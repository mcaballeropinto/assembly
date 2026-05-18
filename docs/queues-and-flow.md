# Queues and Flow

Assembly's state is **the file system**. Moving files moves state. There's no database, no message queue, no in-memory work queue that survives restart.

This doc covers the queue directory layout, how workpieces move through it, fanout to downstream lines, the producer allowlist that protects queues from rogue writes, and the held/release mechanism.

Implementation: [`../src/queue.ts`](../src/queue.ts), [`../src/emit-manifest.ts`](../src/emit-manifest.ts), [`../src/held.ts`](../src/held.ts).

---

## Directory layout per line

```
<line>/
  line.yaml
  queues/
    inbox/                    # raw tasks just arrived
    held/                     # tasks pending manual release
    done/                     # finished workpieces (terminal success)
    error/                    # finished workpieces (terminal failure)
    review/                   # escalated workpieces (need a human)
    activity.jsonl            # line-level event log
    flow.jsonl                # periodic queue-depth snapshots
    task-events/<wpId>/       # per-workpiece event streams (one file per station)
    .emitted.jsonl            # producer allowlist
    .unverified/              # quarantined files

  stations/<name>/
    AGENT.md
    queue/
      inbox/                  # workpieces waiting for this station
      processing/             # in-flight (a worker has them)
      output/                 # worker finished; orchestrator routes
```

## The happy path

```
CLI         ┌──────────────────┐
enqueue ──▶ │ <line>/          │
            │   queues/inbox/  │
            └────────┬─────────┘
                     │ inbox watcher claims + enriches
                     ▼
            ┌──────────────────────────────────┐
            │ stations/<first>/queue/inbox/    │
            └────────┬─────────────────────────┘
                     │ drainInbox spawns worker
                     ▼
            ┌──────────────────────────────────┐
            │ stations/<first>/queue/processing│
            └────────┬─────────────────────────┘
                     │ worker runs LLM, writes envelope
                     ▼
            ┌──────────────────────────────────┐
            │ stations/<first>/queue/output/   │
            └────────┬─────────────────────────┘
                     │ output watcher routes by status
        done   ┌─────┴─────┐  failed (retryable)
               ▼           ▼
   stations/<next>/    backoff timer, then
   queue/inbox/        back to /inbox/
        │
        ▼  (after last station)
   queues/done/
```

Terminal states:

- **`queues/done/`** — every station returned `status: done`.
- **`queues/error/`** — a station failed and the retry budget for its failure class was exhausted.
- **`queues/review/`** — a station's EVAL.md returned `escalate`, or routing got into a degenerate orphan state.

---

## File shapes at each stage

### Raw task (from `assembly enqueue`)

```json
{ "task": "…", "input": { … } }
```

The inbox watcher upgrades this to a workpiece via [`createWorkpiece()`](../src/workpiece.ts) on first sight.

### Workpiece (after enrichment)

See [`concepts.md`](./concepts.md#1-workpiece). The runner adds the standard `id`, `line`, `stations: {}`, and so on.

### Sidecars attached to a workpiece

Files in queue directories that travel with the workpiece — moved together when the orchestrator renames the workpiece between directories:

| Suffix | Written by | Used by |
|--------|-----------|---------|
| `.session.jsonl` | section worker (`claude-code` providers) | dashboard for replay; session-log salvage |
| `.stderr.log` | section worker (held open) | dashboard tail, adoption tailing |
| `.progress.jsonl` | section worker (per tool use) | rolled up into `stations[name].rounds` |
| `.envelope.json` | section worker (invocation-scoped) | LLM module polls it as the success signal |
| `.retry.json` | orchestrator (when backoff is pending) | output watcher; cleared when backoff expires |

### Activity log (`queues/activity.jsonl`)

Append-only JSONL, one event per line. Sample events:
- `task_received`, `station_started`, `station_completed`, `station_failed`
- `trigger_fired`, `trigger_skipped`, `fanout_emitted`
- `retry_scheduled`, `retry_manual`, `error_dismissed`
- `worker_adopted`, `usage_paused`, `usage_resumed`

The dashboard reads this for the per-line activity stream. Long files are tailed, not loaded whole.

### Flow snapshot (`queues/flow.jsonl`)

Periodic (default every 60s, override with `ASSEMBLY_FLOW_SNAPSHOT_MS`) queue-depth dump:
```json
{ "ts": "…", "inbox": 4, "processing": 2, "done": 51, "error": 2 }
```
Used for the historical depth chart on the dashboard.

### Per-workpiece task events (`queues/task-events/<wpId>/<station>.events.jsonl`)

Fine-grained per-station event log. Each line:

```json
{
  "ts": "…",
  "seq": 17,
  "station": "scrape",
  "kind": "tool_call" | "tool_result" | "message" | "heartbeat" | "lifecycle",
  "summary": "WebFetch(example.com/...)",
  "detail": { … }     // capped at 8KB
}
```

`seq` is monotonic per `(linePath, wpId, station)` — the dashboard uses it to paginate. The index file `index.json` in each `task-events/<wpId>/` records per-station status, event count, and last timestamp.

---

## Producer allowlist (emit-manifest)

The queues are protected against rogue writes. Every queue directory has a `.emitted.jsonl` manifest of files that are *expected to appear*. Anything not in the manifest is moved to `.unverified/` and an alert is logged.

Sources tracked:

| Source | Who writes it |
|--------|---------------|
| `cli` | `assembly enqueue` |
| `release` | `assembly release` (from held/) |
| `trigger` | `on_complete` non-fanout emit |
| `fanout` | `on_complete` per-element emit |
| `transition` | Orchestrator routing workpiece to next station |
| `recovery` | Orchestrator on startup picking up stranded workpieces |
| `bootstrap` | First-time daemon startup auto-recording pre-existing files |

**Why this exists.** Stations have Bash. A misbehaving agent (or an agent that hallucinates its tool calls) can `echo '{…}' > queues/inbox/fake.json`. Without the allowlist, the daemon would happily process forged workpieces — including ones with prompts crafted to manipulate the pipeline. This has been observed in practice: when a fetch agent's real fetch failed, it fabricated fanout JSON files and wrote them directly into a downstream line's inbox. The allowlist + scratch-dir isolation are layered defenses.

Layers:
- **Scratch directory** ([`runtime.md`](./runtime.md#per-worker-isolation)) — workers run in a private `/tmp` cwd, so naive relative-path writes don't land in the line directory at all.
- **Producer allowlist** — even absolute-path writes by an agent are quarantined unless the orchestrator or CLI sanctioned them.

Recording: see [`emit-manifest.ts`](../src/emit-manifest.ts) → `recordEmit(queueDir, filename, source)`.
Quarantine: `quarantineUnverified(queueDir, filename)` moves the file to `.unverified/<ts>-<name>`.

---

## Held / release

`queues/held/` is a staging area. A held task is not visible to the inbox watcher.

```bash
# Stage:
assembly enqueue repo-health-digest --task "…" --hold

# List:
assembly held repo-health-digest

# Release one or all:
assembly release repo-health-digest task-1715616000000.json
assembly release repo-health-digest --all
```

`release` does an atomic rename from `held/` to `inbox/` and records the file in `.emitted.jsonl` with source `release`. It's idempotent — files that have already moved appear in `skipped`, not `errors`.

Use `--hold` when:
- You're enqueuing in a tight loop and want to inspect before draining.
- The line has `concurrency: 1` and you want to control ordering across many enqueues.
- You're loading the inbox from a script and want a manual gate before processing.

On `concurrency: 1` lines, the inbox auto-drains as soon as a slot opens — so the safe pattern is to hold everything, then release items one at a time when you're ready for each to run.

---

## Triggers (`on_complete`) and fanout

When a workpiece reaches `queues/done/`, the orchestrator processes `on_complete` entries from `line.yaml`.

### Non-fanout trigger

```yaml
on_complete:
  - target: analyze
    pass:
      seed: data.bug_id
      context: research.content
    condition: data.bug_id
```

For each entry:
1. If `condition` is set and resolves to falsy → skip, log `trigger_skipped`.
2. Resolve `target` (or `target_path` for dynamic routing).
3. Build a new task: `{ task: <source line's task>, input: { …pass mappings resolved against source workpiece } }`.
4. Write into the target line's `queues/inbox/` with `.emitted.jsonl` source `trigger`.

### Fanout trigger

```yaml
on_complete:
  - target_path: input.target_line
    fanout:
      over: data.qualifying_items
      as: seed_items
    pass:
      run_id: id
      keyword_filter: input.keyword_filter
```

The array at `data.qualifying_items` is resolved on the source workpiece. One task is emitted per element. Each emitted task gets `input[as] = [element]` — wrapped as a singleton array so downstream contracts expecting arrays still work. `pass` mappings are also applied to every emitted task, resolved from the source workpiece (not the element).

### Why `target_path`

`target_path` lets one upstream line route different runs to different downstream lines. Example: a single shared `scrape-one` line is reused by multiple category-specific dispatchers. Each dispatcher fans out into `scrape-one` with `input.target_line` set to the appropriate downstream enrichment line. `scrape-one`'s own `on_complete` uses `target_path: input.target_line` to route back to whichever line the dispatcher specified.

---

## Routing details — output watcher

```
output/ file appears
   │
   ├─ dedup guard (same wp+station+mtime within 30s → ignore)
   │
   ├─ load workpiece, read stations[name].status
   │
   ├─ status: "done"
   │   ├─ orphan section? (not in sequence) → dynamic routing
   │   │   walk every section in line, route to first undone, else done/
   │   └─ otherwise → next station's inbox/ (or done/ if last)
   │       ├─ run on_success script
   │       └─ fire on_complete triggers
   │
   ├─ status: "escalated" → review/
   │
   └─ status: "failed"
       ├─ classify (envelope/crash/timeout/guardrail/provider/aborted/unknown)
       ├─ decideRetry()
       │   ├─ retry: write .retry.json, setTimeout(backoff), rename to inbox/
       │   └─ exhausted: rename to error/, run on_failure script
```

See [`reliability.md`](./reliability.md) for the retry policy and failure-class taxonomy.

---

## A note on stations vs queues

The line-level `queues/inbox/` is the *external* entry point. Each station also has its own internal `queue/{inbox,processing,output}`. The flow is:

1. Task lands in line-level `queues/inbox/`.
2. Inbox watcher claims it, runs it through `createWorkpiece` if raw, and renames to the first station's `queue/inbox/`.
3. From there it bounces between station-level queues as it progresses.
4. Final result lands back in line-level `queues/done/` (or `error/` / `review/`).

So `line.yaml` lives in the line dir; the per-station `AGENT.md` lives in `stations/<name>/`; the runtime queue dirs live underneath both.
