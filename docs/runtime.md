# Runtime — Daemon, Orchestrator, Workers

How Assembly actually runs once the daemon is up.

The runtime has three layers:

1. **Global orchestrator** — one per machine. Discovers lines, starts a per-line orchestrator for each.
2. **Per-line orchestrator** — one per line. Watches the line's queues, spawns workers, routes outputs.
3. **Section worker** — one per in-flight workpiece+station pair. Runs the actual LLM call.

Implementations:
- [`../src/global-orchestrator.ts`](../src/global-orchestrator.ts)
- [`../src/orchestrator.ts`](../src/orchestrator.ts)
- [`../src/section-worker.ts`](../src/section-worker.ts)

---

## Daemon lifecycle

### Start (`assembly daemon start`)

1. Load `.env` files.
2. Refuse if `~/.assembly/orchestrator.pid` exists and points at a live process — unless `ASSEMBLY_RELOAD_FROM_PID` is set (handoff path).
3. Discover lines (see below).
4. For each line: spawn a per-line orchestrator (`startOrchestrator(linePath)`).
5. Write `~/.assembly/orchestrator.pid` atomically (temp + rename) with `{ "pid": <pid> }`.
6. Start the orphan reaper.
7. Begin a 30-second polling loop to pick up newly-added lines and tear down removed ones.

### Stop (`assembly daemon stop`)

Sends `SIGTERM` to the PID in the PID file. The daemon:

1. Calls `handle.stop()` on every managed line.
2. Each line sends `SIGUSR2` to its worker process groups so they can flush an `aborted` envelope.
3. Waits up to `flush_grace` seconds (default 30) for workers to exit.
4. SIGKILLs any holdouts.
5. Removes the PID file. Exits.

### Status (`assembly daemon status`)

Reads `~/.assembly/orchestrator.pid` and `~/.assembly/dashboard.pid` and probes both PIDs with `kill(pid, 0)`. Cleans up stale files.

### Hot reload (`assembly daemon reload`)

A graceful in-place restart that adopts running workers — used after editing code or rebuilding `dist/`.

```
old daemon                            new daemon
─────────                             ──────────
SIGHUP received
  │
  ├─ writeHandoff()  ──────────────▶  handoff-<oldpid>.json
  │                                    { workers: [...], lines: [...] }
  │
  ├─ spawn detached "daemon _resume" with env ASSEMBLY_RELOAD_FROM_PID=<oldpid>
  │                                    │
  │                                    ├─ read handoff state
  │                                    ├─ adopt living worker PIDs
  │                                    │   (re-tail stderr from current size,
  │                                    │    re-register exit-poll handlers)
  │                                    ├─ restore retry counts + usage gate state
  │                                    ├─ touch orchestrator-ready-<newpid>
  │  poll for ready file ◀───────────  │
  ├─ stop watchers (handoff=true)
  │   DON'T signal workers
  ├─ remove old PID file
  │
  └─ exit                              ├─ atomically write new PID file
                                       ├─ remove ready file
                                       └─ resume normal operation
```

Files involved (all under `~/.assembly/`):

| File | Owner | Lifetime |
|------|-------|----------|
| `orchestrator.pid` | Both daemons in sequence | Persistent while a daemon runs |
| `handoff-<oldpid>.json` | Old daemon writes, new consumes | Deleted by new daemon after adoption |
| `orchestrator-ready-<newpid>` | New daemon | Created during adoption, deleted before claiming PID file |

The successor inherits exactly the workers that are still alive. Workers themselves only know about their stderr sidecar and the `processing/` file — they don't care that the watching daemon changed. Workpieces produced during the handoff window are routed by the successor's output watchers.

Timeout: `assembly daemon reload --timeout 30` waits 30 seconds for the PID file to point at a new PID. If the successor doesn't come up, the old daemon stays running rather than orphaning workers.

---

## Line discovery

The global orchestrator finds lines by, in order:

1. `~/.assembly/lines/*/line.yaml`
2. Every entry in `$ASSEMBLY_LINE_DIRS` (colon-separated)
3. Every entry in `~/.assembly/config.yaml`'s `line_dirs:` array

Each discovered line gets a per-line orchestrator. New lines are picked up by the 30-second poll; removed lines have their orchestrators stopped.

---

## Per-line orchestrator

For each discovered line, [`startOrchestrator(linePath)`](../src/orchestrator.ts) creates watchers, claims state, and stays running until the daemon stops.

### What it watches

| Path | Purpose |
|------|---------|
| `<line>/queues/inbox/` | New tasks from CLI / trigger / fanout |
| `<line>/queues/held/` | Tasks paused for manual release |
| `<line>/stations/<name>/queue/inbox/` | Workpieces waiting for a specific station |
| `<line>/stations/<name>/queue/processing/` | In-flight workpieces (worker has them) |
| `<line>/stations/<name>/queue/output/` | Worker has finished — orchestrator routes the result |

### What it manages

- **Active workers map**: `Map<station, count>` — used for concurrency gating.
- **Retry counts**: `Map<"<wpId>:<station>", number>` — per-station retry budget.
- **Backoff timers**: `setTimeout`s holding workpieces in `output/` before re-entering `inbox/`.
- **Usage gate**: when the provider quota is low (`~/.assembly/usage-status.json`), the orchestrator pauses new spawns and reports the state. Resume polling re-checks every 60s.

### Inbox watcher flow

When a file appears in `queues/inbox/`:

1. **Producer-allowlist check.** If the filename is not in `.emitted.jsonl` for that queue, move it to `.unverified/` and log `producer_unknown`. See [`queues-and-flow.md`](./queues-and-flow.md#producer-allowlist).
2. **Enrich.** If the file is a raw task shape (`{ task, input }`), wrap it as a workpiece via `createWorkpiece()`.
3. **Claim.** Atomically rename to `stations/<first>/queue/inbox/`.
4. **Drain.** Call `drainInbox` on that station — spawn workers up to the concurrency limit.

### Output watcher flow

When a file appears in `stations/<name>/queue/output/`:

1. **Dedup guard.** Same `(wpId, station, mtime)` within 30s is ignored — guards against double-rename races.
2. **Read the workpiece.** Look at `stations[name].status`.
3. **Route by status:**
   - `done` → next station's `inbox/` (or `queues/done/` if last station); run `on_success` hook; fire `on_complete` triggers.
   - `escalated` → `queues/review/`.
   - `failed` → consult retry policy; either schedule a retry (write `.retry.json` sidecar, `setTimeout` for backoff, then move back to `inbox/`) or move to `queues/error/` and run `on_failure`.

The retry policy is per-failure-class — see [`reliability.md`](./reliability.md).

### Concurrency

`concurrency:` in `line.yaml` is enforced at spawn time. If `activeWorkers[station] >= concurrency`, new workpieces stay queued in `inbox/` until a slot frees. There's no global ordering guarantee — workpieces race for slots.

---

## Section worker

One subprocess per (workpiece, station) pair. Invoked from the orchestrator:

```
bun run src/section-worker.ts <stationDir> <workpiecePath>
```

Spawned **detached** (`Bun.spawn(..., { detached: true })`) so the worker becomes its own process group leader (PGID === PID). This matters for kill semantics — the orchestrator can `kill(-pgid, SIGTERM)` to take down the worker plus anything it spawned (typically a `claude` CLI subprocess).

### Per-worker isolation

Each worker gets a private scratch directory:

```
$TMPDIR/assembly-scratch-<wpId>-<basename>
```

This is the worker's `cwd` for both `script` and `claude-code` providers. Cleaned up on exit. **Why:** stations would otherwise leak relative-path writes — agents with Bash were observed writing `FANOUT-*-RESULT.json` and similar files into the cwd, polluting the assembly tree (see [`development-guide.md`](./development-guide.md#scratch-leakage)).

### Env vars

Workers inherit `process.env`, plus merged `claude_env` overrides from line + station configs (station wins). Forwarded into the `claude` CLI for `claude-code` providers.

### Sidecar files

Per-workpiece sidecars that follow the workpiece file as it moves between queue directories:

| Sidecar | Purpose |
|---------|---------|
| `<wp>.session.jsonl` | Raw stream from the `claude` CLI |
| `<wp>.stderr.log` | Worker stderr (held open during the run, tailed on adoption) |
| `<wp>.progress.jsonl` | Per-tool-use events; rolled up into `stations[name].rounds` |
| `<wp>.envelope.json` | Invocation-scoped envelope file the worker writes; the LLM module polls it |
| `<wp>.retry.json` | Retry state when backoff is pending |

Excluded from listing in [`queue.ts`](../src/queue.ts): files starting with `.`, ending in `.retry.json` / `.envelope.json` / `.tmp.<pid>`, and the `.unverified/` directory.

### Worker signal handling

| Signal | Meaning | Behavior |
|--------|---------|----------|
| `SIGTERM` | Orchestrator's idle / wall-clock timeout fired | Re-read workpiece; if `status: done`, move to `output/` cleanly. Otherwise write `failure_class: "timeout"` envelope. |
| `SIGUSR2` | Daemon shutdown in progress | Same as SIGTERM, but classify as `failure_class: "aborted"` so the next daemon retries aggressively. |
| `SIGKILL` | Flush grace expired | Worker has no chance to flush; orchestrator's output watcher will pick up whatever is in `processing/` next boot. |

The flush handler is idempotent — repeated signals are no-ops.

---

## Orphan reaper

[`../src/reaper.ts`](../src/reaper.ts) runs inside the global orchestrator. It SIGKILLs processes with `PPID=1` matching a name allowlist (default `^(claude|mcp-.*|.*-mcp-server)$`) and older than `olderThanMs` (default 60s).

Why: a worker that gets SIGKILLed without flush_grace can leave its `claude` subprocess re-parented to init, still burning tokens. The reaper sweeps these up every 5 minutes.

Adopted workers are **protected** — the reaper takes the orchestrator's `getKnownWorkerPids()` callback and skips them plus any process whose parent is in that set.

---

## Triggers and fanout

When a workpiece finishes successfully, the orchestrator:

1. Runs the `on_success` script if configured. Stdout is logged; failure does not fail the workpiece.
2. Iterates `on_complete` entries.

For each `on_complete` entry:

- Resolve `target_path` if present, else use `target`.
- Resolve `condition`; skip if falsy.
- If `fanout` is set: resolve the array at `fanout.over`. Emit one task per element. Each task gets `input[fanout.as] = [element]` plus all `pass` mappings.
- Otherwise: emit one task with `pass` mappings as the input.

Emitted tasks are written into the **target line's** `queues/inbox/` directory, recorded in `.emitted.jsonl` with source `trigger` (or `fanout`).

A typical three-line dispatch pattern works without code:
- An upstream **discover** line fans out one task per discovered source.
- A **scrape** line fans out one task per qualifying item — to a line named in `input.target_line` (resolved via `target_path`).
- A downstream **enrich** line scores and persists each item.

See [`lines-catalog.md`](./lines-catalog.md) for the example lines that ship with the repo.

---

## What's saved where (path summary)

```
~/.assembly/
  .env                          # API keys
  orchestrator.pid              # { pid }
  dashboard.pid                 # { pid, port }
  orchestrator-ready-<pid>      # transient — handoff sync
  handoff-<pid>.json            # transient — handoff state
  usage-status.json             # provider quota snapshot
  runs/<id>-<line>/             # final workpieces + log.jsonl

<line>/
  line.yaml
  queues/
    inbox/ held/ done/ error/ review/
    activity.jsonl              # line-level event log
    flow.jsonl                  # periodic queue depths
    task-events/<wpId>/         # per-workpiece per-station event streams
    .emitted.jsonl              # producer allowlist
    .unverified/                # quarantined files
  stations/<name>/
    AGENT.md  EVAL.md?  memory/
    queue/
      inbox/ processing/ output/
```
