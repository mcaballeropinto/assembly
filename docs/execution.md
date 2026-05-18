# Execution — Inside One Station

What happens between the moment the section worker is spawned and the moment it writes a final envelope.

Implementations:
- [`../src/section-worker.ts`](../src/section-worker.ts) — the worker process
- [`../src/runner.ts`](../src/runner.ts) — orchestrates the per-station call (also used by `assembly run`)
- [`../src/llm.ts`](../src/llm.ts) — provider-specific LLM invocation
- [`../src/prompt.ts`](../src/prompt.ts) — prompt construction
- [`../src/envelope.ts`](../src/envelope.ts) — envelope parse, validate, repair

---

## High-level shape

```
spawn section-worker.ts <stationDir> <workpiecePath>
   │
   ├─ chdir to private scratch dir   (/tmp/assembly-scratch-<wpId>-<basename>)
   ├─ load workpiece + station config (AGENT.md, EVAL.md, memory)
   ├─ build prompt (system + user, context modes applied)
   ├─ call provider                  (api | claude-code | claude-code-cached | pi | script)
   ├─ parse envelope
   │    ├─ if parse fails → repair (in-session nudge → Haiku fallback)
   │    └─ on success → validate guardrails
   ├─ if EVAL.md present → run eval (LLM or script)
   │    ├─ pass → continue
   │    └─ fail → retry (with feedback) or escalate
   ├─ write StationResult to workpiece (envelope + status + timing + tokens + cost)
   ├─ save workpiece.json (checkpoint)
   └─ rename workpiece into stations/<name>/queue/output/  (and exit 0)
```

---

## Providers

`provider:` is set in line `defaults` or per-station AGENT.md frontmatter. Five values are supported.

| Provider | What it does |
|----------|-------------|
| `api` | Direct Anthropic SDK call. Also used internally for envelope repair (Haiku). Fast and cheap; no tools, no Bash. |
| `claude-code` | Spawns the `claude` CLI subprocess in stream-json mode. Has bash, read, write, edit, plus any MCP servers configured. |
| `claude-code-cached` | Same as `claude-code` but moves system-level file instructions into the user message, preserving the prompt cache across retries. Use this when the system prompt is large and stable. |
| `pi` | Spawns `pi` subprocess — same as claude-code, plus pi's tools and skills. |
| `script` | Plain `bun run <script> <workpiecePath>`. Stdout is parsed as the envelope. No LLM at all — used for deterministic stations. |

### `claude-code` invocation in detail

The worker:
1. Spawns `claude` CLI as a child process, stream-json stdin/stdout.
2. Writes `{ type: "user", system, message }` to stdin.
3. Tails stdout (line-delimited JSON), capturing assistant text, tool uses, token counts, and the final `result` event.
4. **Decouples completion from process lifecycle** by polling `<wp>.envelope.json` on disk every 250ms. The agent is instructed to write the final envelope to that file. Whichever wins:
   - File appears → grace period (3s, configurable) for any final result events → SIGKILL the subprocess.
   - Stream ends first → one last poll of the file; if empty, salvage from captured text.
5. Records the elapsed time, tokens, cache_read / cache_creation breakdown, and cost.

This is the most important reliability lever in the codebase. The `claude` CLI can hang post-result indefinitely (known issues anthropic/claude-code#38437, #25629, #43791); decoupling on the envelope file means a hung subprocess never blocks the orchestrator.

### `script` invocation in detail

```bash
bun run <script-from-AGENT.md-frontmatter> <workpiecePath>
```

The script reads the absolute path from `argv[1]`, opens the workpiece, does its work, writes the envelope JSON to stdout, and exits 0. Stderr → thrown error if exit is non-zero.

Scripts can read `_pending_eval_feedback` from the workpiece to thread eval critique into a retry — this lets script stations participate in the same eval/retry loop that LLM stations use.

---

## Scratch directory

Every worker gets its own cwd:

```
$TMPDIR/assembly-scratch-<wpId>-<basename>
```

This is the cwd for both `script` and `claude-code` providers. Cleaned up via `process.on("exit", rmSync(...))` on the worker.

**Why:** the framework cannot trust agents to write only to authorized locations. Workers wrote `FANOUT-*-RESULT.json` and similar scratch files relative to the assembly tree, polluting `lines/` (see [`development-guide.md`](./development-guide.md#scratch-leakage)). Pinning cwd to `/tmp` contains that. The producer allowlist ([`queues-and-flow.md`](./queues-and-flow.md#producer-allowlist)) catches absolute-path writes.

---

## Prompt construction

[`prompt.ts`](../src/prompt.ts) builds two messages.

### System message

```
<AGENT.md body>

<station memory if present>

You MUST respond with valid JSON containing:
- "summary": one-line description (required, non-empty string)
- "content": full output text (optional)
- "data": structured metadata object (optional)
```

The system message is **byte-identical** across retries for the same station — this preserves the prompt cache when using `claude-code-cached`.

### User message

```
# Task
<workpiece.task>

# Input
<workpiece.input as JSON, only if non-empty>

# Previous Stations
<…context-mode-specific section…>

---
Produce your output now.
```

### Context modes

The "Previous Stations" section is built one of three ways:

| Mode | What's included |
|------|-----------------|
| `full` (default) | Every prior station's `summary`, `content`, and `data`. Good for short lines. |
| `summary` | Every prior station's name + `summary` only. Token-efficient for longer lines. |
| `explicit` | Only the dotted paths in `station.reads`. Most efficient; recommended for 5+ stations. |

`context:` in `line.yaml` sets the default. A station's frontmatter `reads: [...]` overrides to `explicit` mode just for that station.

Examples of `reads:` paths:

```yaml
reads:
  - task
  - input
  - research                  # full station object (summary + content + data)
  - draft.content             # just one field
  - review.data
```

### Memory injection

If `stations/<name>/memory/MEMORY.md` exists, its body (with frontmatter stripped) is injected into the system prompt after the AGENT.md body. For `claude-code` providers, the runner also appends an instruction telling the agent it can write additional `.md` files into the `memory/` directory for future runs. See [`cost-and-memory.md`](./cost-and-memory.md#station-memory).

### Eval-retry prompts

When EVAL.md fails and the station retries, the prompt is built differently — by [`buildEvalRetryPrompt`](../src/prompt.ts):

- **System:** same station system message (with memory).
- **Message 1 (user):** compact recap — task + input + the prior output truncated to 4 KB.
- **Message 2 (user):** eval feedback + "Produce improved output".

Prior-station context is dropped entirely. This typically cuts eval-retry tokens by 90%+ vs. resending the full chain.

---

## Tool rounds

For `claude-code` and `pi` providers, the worker writes `<wp>.progress.jsonl` — one line per assistant tool use. After the station finishes, [`tool-rounds.ts`](../src/tool-rounds.ts) rolls this up into:

```json
"rounds": { "turns": 12, "tools": { "Read": 4, "WebFetch": 2, "Bash": 6 } }
```

`turns` is the highest assistant-message index seen — monotonically increasing per assistant message. Tool counts are the number of invocations per tool name.

This appears in `workpiece.stations[name].rounds` and is shown in the dashboard's per-station drawer.

---

## Failure modes

A station can fail at any of these points:

1. **Provider call fails** — model 5xx, timeout, rate limit → `failure_class: "provider"`.
2. **Process exits non-zero** (claude CLI crash, segfault) → `failure_class: "crash"`.
3. **Idle / wall-clock timeout fires** → `failure_class: "timeout"`.
4. **Envelope can't be parsed even after repair** → `failure_class: "envelope"`.
5. **Guardrail validation fails** → `failure_class: "guardrail"`.
6. **Daemon shutdown signal arrives mid-run** → `failure_class: "aborted"`.

The runner writes a failure envelope:

```json
{
  "status": "failed",
  "summary": "<reason>",
  "data": { "error": "…", "validation_errors": [...] },
  "failure_class": "guardrail",
  …
}
```

It still gets written to the workpiece — output watcher reads the `failure_class` and decides what to do. See [`reliability.md`](./reliability.md).

---

## What's saved at every checkpoint

After every successful station, the worker writes the workpiece to disk. Each entry under `stations.<name>` is a `StationResult`:

```typescript
{
  status: "done" | "failed" | "escalated" | "skipped",
  summary, content?, data?,                       // the envelope
  started_at, finished_at, model,
  tokens: { in, out, cache_read?, cache_creation? },
  cost_usd,
  eval?: { pass, feedback, score?, action?, tokens?, cost_usd? },
  failure_class?,
  rounds?: { turns, tools: {…} },
  previous_attempts?: [<flat StationResult>]      // prior failed retries
}
```

Plus `workpiece.totals = { tokens, cost_usd }` rolled up across all stations.

The workpiece is the single source of truth; everything else (sidecars, activity log, task events) is for observability.
