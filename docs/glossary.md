# Glossary

Every term used elsewhere in the docs, in one place. Roughly ordered from most-fundamental to most-specific.

## Workpiece
The JSON object that flows through a line, accumulating one envelope per completed station. Saved to disk after every station as a checkpoint. See [`concepts.md`](./concepts.md#1-workpiece).

## Envelope
The standardized return shape from every station: `{ summary, content?, data? }`. The runner files it under `workpiece.stations[<name>]`. See [`concepts.md`](./concepts.md#2-envelope).

## Station
A folder under `lines/<line>/stations/<name>/` containing `AGENT.md`, optional `EVAL.md`, optional `memory/`. One agent step in a pipeline. See [`configuration.md`](./configuration.md#agentmd).

## Line
A folder containing `line.yaml` and a `stations/` subdir. A pipeline definition. See [`configuration.md`](./configuration.md#lineyaml).

## Sequence
The ordered list of station references in `line.yaml`. Entries can be bare names, station objects with overrides, parallel blocks, gates, or loops. See [`configuration.md`](./configuration.md#sequence-step-variants).

## Section worker
The subprocess that runs one (workpiece, station) pair. Spawned by the orchestrator, isolated in its own scratch directory. See [`runtime.md`](./runtime.md#section-worker).

## Per-line orchestrator
The long-running coroutine that watches one line's queues, spawns workers, and routes outputs. See [`runtime.md`](./runtime.md#per-line-orchestrator).

## Global orchestrator
The daemon process. Discovers lines, starts per-line orchestrators, manages the reaper and reload handoff. See [`runtime.md`](./runtime.md#daemon-lifecycle).

## Daemon
The `assembly daemon` process — same thing as the global orchestrator from the operator's perspective.

## Inbox / Held / Processing / Output / Done / Error / Review
The seven queue directory states. See [`queues-and-flow.md`](./queues-and-flow.md#directory-layout-per-line).

## Producer allowlist
`.emitted.jsonl` files in queue directories listing filenames sanctioned to appear. Anything else is moved to `.unverified/`. See [`queues-and-flow.md`](./queues-and-flow.md#producer-allowlist).

## Provider
The runtime backend for a station: `api`, `claude-code`, `claude-code-cached`, `pi`, `script`. See [`execution.md`](./execution.md#providers).

## Context mode
How prior-station context is included in a station's prompt: `full`, `summary`, or `explicit` (via the station's `reads:` frontmatter). See [`execution.md`](./execution.md#context-modes).

## Reads
The list of dotted workpiece paths a station declares in AGENT.md frontmatter. Switches the context mode to explicit. See [`configuration.md`](./configuration.md#frontmatter-keys).

## Guardrail
Optional output validation declared in AGENT.md — `required`, `forbidden`, `schema`. Runs after envelope parse. See [`envelope-and-guardrails.md`](./envelope-and-guardrails.md#guardrails).

## Eval
Optional quality gate at `stations/<name>/EVAL.md`. Runs a critic over the envelope; can pass, fail, retry, or escalate. See [`envelope-and-guardrails.md`](./envelope-and-guardrails.md#eval-evalmd).

## Repair
The fallback path when envelope parsing fails — in-session nudge first, then a direct Anthropic SDK Haiku call. See [`envelope-and-guardrails.md`](./envelope-and-guardrails.md#repair-flow).

## Failure class
The category of a station failure: `envelope`, `crash`, `timeout`, `guardrail`, `provider`, `aborted`, `unknown`. Drives retry policy. See [`reliability.md`](./reliability.md#failure-classes).

## Retry policy
Per-failure-class config: `maxRetries` + `backoff: number[]` (seconds). Set in `line.yaml` → `retry_policy`. See [`reliability.md`](./reliability.md#retry-policy).

## Timeout stack
The five layered timeouts: Bash → stream / byte watchdogs → API call → station idle → station wall-clock. See [`reliability.md`](./reliability.md#timeout-stack).

## Flush grace
The window between `SIGTERM` and `SIGKILL` for a worker — gives it time to write an abort envelope. Default 30s. See [`reliability.md`](./reliability.md#daemon-flush-grace).

## Reaper
Background process that SIGKILLs orphaned `claude` / MCP subprocesses (`PPID = 1`). Adopted workers are protected. See [`reliability.md`](./reliability.md#orphan-reaper).

## Heartbeat
Optional keepalive emission from a `claude-code` station — keeps the orchestrator's idle timer healthy when the agent is thinking quietly. Configured per-line or per-station. See [`configuration.md`](./configuration.md#lineyaml).

## Hot reload / handoff
`assembly daemon reload` — graceful in-place restart that adopts running workers via a handoff state file. See [`runtime.md`](./runtime.md#hot-reload).

## Handoff state file
`~/.assembly/handoff-<oldpid>.json` — the snapshot the old daemon writes for its successor. Consumed and deleted by the new daemon after adoption.

## Ready file
`~/.assembly/orchestrator-ready-<newpid>` — transient marker the new daemon touches to tell the old one adoption is complete. The old daemon polls for this before stepping down.

## On complete trigger
Per-line config that emits downstream tasks when a workpiece completes successfully. Two flavors: bare (one task per workpiece) and fanout (one task per array element). See [`runtime.md`](./runtime.md#triggers-and-fanout).

## Fanout
A trigger pattern that emits N downstream tasks, one per element of an array on the source workpiece. The element is wrapped as a singleton array in `input[as]`. See [`queues-and-flow.md`](./queues-and-flow.md#fanout-trigger).

## Target path
An alternative to `target:` on an `on_complete` entry. A dotted workpiece path that resolves to the downstream line name at trigger time. Lets one shared line route per-task to different downstream lines (e.g. a generic scraper that dispatches to category-specific enrichment lines). See [`queues-and-flow.md`](./queues-and-flow.md#why-target_path).

## Pass
The map of source-workpiece paths to downstream `input` keys in an `on_complete` entry. Forwards data across the line boundary.

## Activity log
`queues/activity.jsonl` per line — append-only event stream for line-level events. Source for the dashboard's activity feed.

## Task events
`queues/task-events/<wpId>/<station>.events.jsonl` — fine-grained per-tool-use events from a `claude-code` station. Paginated by `seq` (monotonic counter). See [`dashboard.md`](./dashboard.md#task-events-stream).

## Sidecar
A file that travels with a workpiece between queue directories. `.session.jsonl`, `.stderr.log`, `.progress.jsonl`, `.envelope.json`, `.retry.json`. See [`runtime.md`](./runtime.md#sidecar-files).

## Scratch directory
The per-worker `$TMPDIR/assembly-scratch-<wpId>-<basename>` cwd. Cleaned up on worker exit. Contains naive relative-path writes from agents. See [`execution.md`](./execution.md#scratch-directory).

## Memory
`stations/<name>/memory/MEMORY.md` plus any sibling files. Persistent notes injected into the system prompt. EVAL.md failures auto-append. See [`cost-and-memory.md`](./cost-and-memory.md#station-memory).

## Total tokens / cost
Per-workpiece rollup at `workpiece.totals`. Summed across every station's call + repair + eval. Also displayed per-session and per-station in the dashboard. See [`cost-and-memory.md`](./cost-and-memory.md#cost-tracking).

## Usage gate
The orchestrator's quota-aware pause mechanism. Reads `~/.assembly/usage-status.json`; blocks worker spawns when `paused: true`; resumes via 60s re-poll.

## PID file
`~/.assembly/orchestrator.pid` for the daemon; `~/.assembly/dashboard.pid` for the dashboard. Each contains `{ pid, port? }`. Live-process check prevents double-start.

## Line discovery
The set of directories the daemon scans: `~/.assembly/lines/`, `$ASSEMBLY_LINE_DIRS` colon-separated, `~/.assembly/config.yaml` → `line_dirs:`. See [`runtime.md`](./runtime.md#line-discovery).

## Line resolution
The CLI lookup path for `<line>` arguments: exact path, then `<cwd>/.assembly/lines/<name>/`, then `~/.assembly/lines/<name>/`. See [`cli.md`](./cli.md#line-resolution).
