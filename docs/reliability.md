# Reliability — Failure Classes, Retries, Timeouts

Assembly's defense-in-depth approach to keeping a long-running daemon healthy. Implementations span:
- [`../src/retry-state.ts`](../src/retry-state.ts)
- [`../src/orchestrator.ts`](../src/orchestrator.ts) (output watcher + retry scheduler)
- [`../src/section-worker.ts`](../src/section-worker.ts) (signal handlers)
- [`../src/reaper.ts`](../src/reaper.ts) (orphan cleanup)
- [`../src/envelope.ts`](../src/envelope.ts) (repair fallback)

---

## Failure classes

When a station fails, the runner records a `failure_class`. The orchestrator's retry policy is keyed on this class.

| Class | When it's set |
|-------|--------------|
| `envelope` | `EnvelopeError` survived even after Haiku repair — the model can't or won't return valid JSON |
| `crash` | Worker process exited non-zero or got killed by a signal not under our control |
| `timeout` | Idle-output watchdog or hard wall-clock timeout fired; `SIGTERM` reached the worker |
| `guardrail` | Envelope parsed but failed schema / required / forbidden validation |
| `provider` | Upstream API error — rate limit, auth, model-down, network |
| `aborted` | Daemon shutdown signal (`SIGUSR2`) reached the worker — it flushed an aborted envelope |
| `unknown` | Pre-classification fallback; appears on legacy workpieces |

These are defined in [`types.ts`](../src/types.ts) as `FailureClass`.

---

## Retry policy

Per-failure-class. Each class has a `maxRetries` and a `backoff: number[]` (seconds between retries, indexed by attempt number).

Default policy (overridden in `line.yaml` → `retry_policy`):

```yaml
retry_policy:
  envelope:  { maxRetries: 2, backoff: [10, 60] }
  crash:     { maxRetries: 3, backoff: [10, 60, 300] }
  timeout:   { maxRetries: 2, backoff: [30, 300] }
  guardrail: { maxRetries: 1, backoff: [10] }
  provider:  { maxRetries: 5, backoff: [10, 60, 300, 900, 1800] }
  aborted:   { maxRetries: 99, backoff: [0] }
  unknown:   { maxRetries: 1, backoff: [60] }
```

(`aborted` retries effectively forever with no backoff — they're never the workpiece's fault.)

### Retry flow

```
worker writes failed envelope, exits 0
   │
   ▼
output watcher sees the file
   │
   ├─ read failure_class
   ├─ load .retry.json sidecar (or start fresh)
   ├─ retry_count < maxRetries?
   │     │
   │     ├─ YES
   │     │   ├─ write .retry.json { retry_count++, in_backoff: true, backoff_until: ts }
   │     │   ├─ setTimeout(backoff[retry_count])
   │     │   └─ on timer fire: rename output/<wp> → station/inbox/<wp>
   │     │
   │     └─ NO (budget exhausted)
   │         ├─ clear retry counter
   │         ├─ rename output/<wp> → queues/error/
   │         └─ run on_failure script
```

### Per-workpiece state

`.retry.json` sidecar next to the workpiece during the backoff window:

```json
{
  "retry_count": 2,
  "max_retries": 3,
  "failure_class": "crash",
  "in_backoff": true,
  "backoff_until": "2026-05-13T22:18:00Z",
  "exhausted": false
}
```

On daemon startup, [`retry-state.ts`](../src/retry-state.ts) walks all queue dirs and cleans up orphan retry sidecars whose workpiece is gone.

### Previous attempts

Each failed attempt is preserved on the workpiece. When a station eventually succeeds, its `StationResult.previous_attempts` array contains every prior failed attempt (each itself a `StationResult`, but flattened — no recursion). This means a single station entry can carry the full history of how the station ended up succeeding.

The orchestrator stages prior attempts under `workpiece._retry_history` until the next successful write, which drains them into `previous_attempts`. See [`workpiece.ts`](../src/workpiece.ts).

---

## Timeout stack

Assembly applies five layered timeouts. Each catches a different failure mode.

| Layer | Scope | Default | Knob |
|-------|-------|---------|------|
| Bash tool | Per-Bash-tool call inside a `claude-code` station | 120s default / 900s max | `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` |
| Stream watchdog | Per API response stream | 300s idle | `CLAUDE_ENABLE_STREAM_WATCHDOG=1`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS=300000` |
| Byte watchdog | Per API response (bytes-flowing check) | enabled | `CLAUDE_ENABLE_BYTE_WATCHDOG=1` |
| API call | Per `claude` API call | 600s | `API_TIMEOUT_MS=600000` |
| Station — idle | Per station, no-output | `line.timeout` | `line.yaml` top-level, or per-station via `station.timeout` |
| Station — wall clock | Per station, hard ceiling | `line.max_wall_clock` | `line.yaml` top-level, or per-station via `station.max_wall_clock` |
| Daemon flush grace | SIGTERM → SIGKILL window | 30s | `line.flush_grace` or per-station override |

These cascade from the inside out — the innermost layer fires first if it can.

### Station idle timeout

The orchestrator polls each worker's `getLastActivityMs()` every ~5s. If `Date.now() - lastActivityMs > line.timeout * 1000`, it begins the kill sequence:

1. Send `SIGTERM` to the worker's process group.
2. Wait `flush_grace` seconds.
3. Send `SIGKILL`.

The worker's `SIGTERM` handler tries to write a `failure_class: "timeout"` envelope before exiting. If it succeeds, the next attempt re-runs the station from a clean slate.

### Station wall-clock timeout

A separate timer fires after `max_wall_clock` regardless of activity. Same kill sequence.

Use both: `timeout` catches hangs; `max_wall_clock` catches drift (an agent slowly chasing a hallucinated path).

Example pattern:

```yaml
sequence:
  - station:
      name: enrich
      max_wall_clock: 900   # Hard 15-min ceiling. Without this, an agent
                            # has been observed drifting from "process one
                            # input" into "process the entire upstream
                            # dataset" — runs of 2+ hours.
```

### Daemon flush grace

When `SIGTERM` lands on a worker, the orchestrator waits `flush_grace` seconds before escalating to `SIGKILL`. The worker uses this window to write its abort envelope and re-rename the workpiece into `output/` so the next daemon picks it up.

If the worker exceeds the grace, the orchestrator sends `SIGKILL` and leaves the workpiece in `processing/`. The next daemon's recovery sweep moves it back to `inbox/`.

---

## Orphan reaper

The reaper ([`reaper.ts`](../src/reaper.ts)) is a safety net for the `claude` CLI hang issue. Every 5 minutes it scans for processes that:

- Have `PPID = 1` (re-parented to init — their parent worker died).
- Match the name allowlist (default: `^(claude|mcp-.*|.*-mcp-server)$`).
- Are older than `olderThanMs` (default 60s).

Matches get `SIGKILL`ed.

Adopted workers are **protected** — the reaper takes the orchestrator's `getKnownWorkerPids()` callback at every scan and skips those PIDs and any process whose PPID is in that set. This is what makes hot reload (`assembly daemon reload`) safe: workers re-parented to init during the predecessor's exit are recognized as adopted children.

---

## What survives a crash

- **Daemon crash** — workers keep running (they're separate processes). On next start, the orchestrator does a recovery sweep: any workpiece left in `stations/*/queue/processing/` whose worker is no longer alive gets re-renamed to `inbox/`. Workers still alive are *not* adopted on a fresh start (only `reload` does that) — they keep running but the new daemon doesn't know about them; the reaper will eventually clean them up.
- **Worker crash** — the orchestrator sees `processing/` go untouched after the subprocess exit code; treats it as `crash` failure class and retries per policy.
- **Both** — same as daemon crash, but with the orphan `claude` cleanup story handled by the reaper.

---

## The `aborted` class — graceful daemon shutdown

When the daemon receives `SIGINT` / `SIGTERM`:

1. Per-line orchestrators send `SIGUSR2` to every active worker's process group.
2. Worker handler reads the workpiece, writes a failure envelope with `failure_class: "aborted"`, moves it to `output/`, exits.
3. Output watchers route to retry queue (the `aborted` retry budget is huge — these are never the workpiece's fault).
4. Once `flush_grace` expires, holdouts get `SIGKILL`.
5. Daemon exits.

This is why `aborted` retries effectively forever — they're system-level interruptions, not workpiece-level failures.

---

## Cross-reference

- The retry mechanics are visible on the dashboard — see [`dashboard.md`](./dashboard.md#retry-and-error-panels).
- Eval failures route through a separate retry loop in the runner — see [`envelope-and-guardrails.md`](./envelope-and-guardrails.md#eval-evalmd).
- Hot reload (`assembly daemon reload`) preserves retry counts in the handoff state — see [`runtime.md`](./runtime.md#hot-reload).
