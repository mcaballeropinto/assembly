# CLI Reference

The `assembly` CLI is the entry point for everything — batch runs, daemon control, dashboard, enqueueing, inspection, validation.

Implementation: [`../src/cli.ts`](../src/cli.ts).

## Synopsis

```
assembly <command> [args] [flags]

Commands:
  run        Run a line synchronously (batch mode)
  enqueue    Drop a task into a line's inbox (or held/)
  held       List held tasks
  release    Move held task(s) into inbox
  daemon     Manage the orchestrator daemon
  dashboard  Manage the dashboard server
  inspect    Inspect a workpiece.json
  validate   Validate a line's config
  dry        Show execution plan for a line + task
  list       List discoverable lines
  init       Set up ~/.assembly
  --help     Print help
```

---

## Line resolution

Wherever a command takes a `<line>` argument, the resolver checks (first match wins):

1. **Exact path** — `./lines/my-pipeline/`
2. **Project-local** — `<cwd>/.assembly/lines/<name>/`
3. **Global** — `~/.assembly/lines/<name>/`

If nothing matches, the resolver falls back to `resolve(<name>)` (the literal path). For destructive operations like `enqueue`, the CLI refuses to proceed unless `<line>/line.yaml` exists — this prevents fabricating queue directories under a wrong path (see [`cli.ts:380-389`](../src/cli.ts)).

---

## `run` — synchronous execution

```bash
assembly run <line> --task "..." [--input '{"k":"v"}'] [--resume <workpiece.json>] [--from <station>] [--only <station>]
```

- `--task` (required) — the task string the line operates on.
- `--input` — JSON object exposed to stations as `input`.
- `--resume` — load a checkpointed workpiece and continue.
- `--from <station>` — resume from this station onwards (skip earlier stations).
- `--only <station>` — re-run just this one station; useful for iterating on a single prompt.

Workpiece lands in `~/.assembly/runs/<id>-<line>/workpiece.json`. The path is printed at the end.

Implementation: [`cli.ts`](../src/cli.ts) → `handleRun` → [`runner.ts`](../src/runner.ts) → `run()`.

## `dry` — execution plan, no LLM calls

```bash
assembly dry <line> --task "..."
```

Prints what would execute without calling models. Same code path as `run` but with `dryRun: true`.

---

## `enqueue` — daemon mode

```bash
assembly enqueue <line> --task "..." [--input '{…}'] [--hold]
```

Writes a task file to `<line>/queues/inbox/` (or `queues/held/` with `--hold`). The daemon picks it up.

- Records the file in the producer allowlist (`.emitted.jsonl`) — see [`queues-and-flow.md`](./queues-and-flow.md#producer-allowlist).
- `--hold` skips the allowlist; release later with `assembly release`.

This is the only safe way to feed the daemon. Writing files directly to `queues/inbox/` triggers quarantine to `.unverified/`.

## `held` — list held tasks

```bash
assembly held <line>
```

Lists `queues/held/*.json` for the given line, oldest first.

## `release` — move held tasks into inbox

```bash
assembly release <line> <taskFile>         # specific file
assembly release <line> --all              # everything in held/
```

Atomic rename + producer-allowlist record. Idempotent — already-moved files appear in the `skipped` list.

---

## `daemon` — orchestrator

```bash
assembly daemon [start]                  # start headless orchestrator
assembly daemon stop                     # SIGTERM the running daemon
assembly daemon reload [--timeout 30]    # graceful reload — adopt workers, swap process
assembly daemon status                   # print PID + dashboard info
```

The daemon discovers lines from:
- `~/.assembly/lines/`
- `$ASSEMBLY_LINE_DIRS` (colon-separated paths)
- `~/.assembly/config.yaml` → `line_dirs:` array

It writes its PID to `~/.assembly/orchestrator.pid` and won't double-start. See [`runtime.md`](./runtime.md) for the full lifecycle.

Signals:
- `SIGINT` / `SIGTERM` → graceful shutdown (workers get `SIGUSR2` → flush window → `SIGKILL`)
- `SIGHUP` → graceful reload (spawn successor that adopts running workers, then exit)

`assembly daemon reload` sends `SIGHUP` from a transient CLI invocation, then polls until the PID file points at the successor.

---

## `dashboard` — web UI

```bash
assembly dashboard [start] [--port 4111] [--host 127.0.0.1]
assembly dashboard stop
assembly dashboard status
```

Independent of the daemon — reads disk directly. Defaults to port `4111` and host `127.0.0.1`, configurable via `--port` and `--host`. PID written to `~/.assembly/dashboard.pid`. See [`dashboard.md`](./dashboard.md).

---

## `inspect` — read a workpiece

```bash
assembly inspect <workpiece.json>                     # full overview
assembly inspect <workpiece.json> --station research  # one station's full output
```

Prints stations, summaries, tokens, cost, eval pass/fail, and content/data on demand.

## `validate` — config sanity check

```bash
assembly validate <line>
```

Loads `line.yaml`, validates schema, loads every `AGENT.md`, reports errors. Use before deploying a new line. Implementation: [`line.ts`](../src/line.ts) → `validateLine()`.

## `list` — discover lines

```bash
assembly list
```

Lists lines found under `~/.assembly/lines/` and `<cwd>/.assembly/lines/`. Each entry must contain a `line.yaml` to be listed.

## `init` — first-time setup

```bash
assembly init
```

Creates `~/.assembly/{lines,stations,runs}` and a `.env` template. Idempotent.

---

## Environment variables

API keys are loaded by [`paths.ts`](../src/paths.ts) → `loadEnvFiles()`. Earlier sources lose to later ones except for shell env, which always wins:

1. `~/.secrets.env`
2. `~/.assembly/.env`
3. `.env` (current directory)
4. `.assembly/.env` (current directory)
5. Shell environment (highest precedence)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | For the `api` provider and in-station envelope repair (Haiku). |
| `ASSEMBLY_ANTHROPIC_API_KEY` | Override only used inside Assembly. Useful if your shell has a personal key set. |
| `API_TIMEOUT_MS` | Per-API-call timeout. Default `600000` (10 min). Forwarded to spawned `claude` subprocesses. |
| `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | Per-Bash-tool-call timeouts inside `claude-code` stations. Defaults `120000` / `900000`. |
| `CLAUDE_ENABLE_BYTE_WATCHDOG`, `CLAUDE_ENABLE_STREAM_WATCHDOG`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | Stream-level watchdogs in the `claude` CLI. See [`reliability.md`](./reliability.md#timeout-stack). |
| `ASSEMBLY_CLAUDE_*` | Process-level overrides for any `claude_env` key (line/station-level still take precedence). |
| `ASSEMBLY_LINE_DIRS` | Colon-separated extra directories scanned for lines. |
| `ASSEMBLY_FLOW_SNAPSHOT_MS` | Cadence of `queues/flow.jsonl` writes. Default 60000. |
| `ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES` | Prompt-size warning threshold for `claude-code` provider. Default 150 KB. |
| `ASSEMBLY_RELOAD_FROM_PID` | Set by `daemon reload` on the successor process — lets it skip the live-PID-file refusal. Internal. |

---

## Common workflows

**One-shot run from a new shell:**
```bash
assembly run repo-health-digest --task "Audit Anthropic SDKs" \
  --input '{"repos":["anthropics/anthropic-sdk-python","anthropics/anthropic-sdk-typescript"]}'
```

**Stand up the daemon + dashboard:**
```bash
assembly daemon start &
assembly dashboard --port 4111 &
```

**Stage a task, inspect it, then release:**
```bash
assembly enqueue repo-health-digest --task "Audit topic:claude-sdk" \
  --input '{"topic":"claude-sdk","limit":10}' --hold
assembly held repo-health-digest
assembly release repo-health-digest --all
```

**Iterate on one station's prompt:**
```bash
# Run once
assembly run my-line --task "..."
# Edit stations/research/AGENT.md
# Re-run only research, keep prior stations' results
assembly run my-line --resume ~/.assembly/runs/run_<id>-my-line/workpiece.json --only research
```

**Reload code without killing in-flight workers:**
```bash
# After editing src/* or rebuilding dist/:
assembly daemon reload --timeout 60
```
See [`runtime.md`](./runtime.md#hot-reload) for what's swapped vs. preserved.
