# Configuration Reference

This is the schema reference for every file Assembly reads to define a line.

- [`line.yaml`](#lineyaml) — line config and sequence
- [`AGENT.md`](#agentmd) — station prompt + frontmatter
- [`EVAL.md`](#evalmd) — optional quality gate
- [`memory/MEMORY.md`](#memorymemorymd) — optional persistent memory

All schemas correspond to interfaces in [`../src/types.ts`](../src/types.ts) and validation in [`../src/line.ts`](../src/line.ts).

---

## `line.yaml`

The blueprint for one pipeline. Located at `lines/<line-name>/line.yaml`.

```yaml
name: my-line                 # required — must match the folder name
description: >                # optional — free text
  What this pipeline does

sequence:                     # required — array of steps
  - station-a
  - station-b

concurrency: 5                # optional — max active workers across the line; default unlimited
timeout: 600                  # optional — idle (no output) seconds before SIGTERM; 0 or omitted = unlimited
max_wall_clock: 1800          # optional — hard ceiling regardless of activity
flush_grace: 30               # optional — seconds between SIGTERM and SIGKILL; default 30
heartbeat:                    # optional — keepalive config for claude-code providers
  interval_ms: 10000
  emit_when_silent: true

defaults:                     # optional — applied to every station unless overridden
  provider: claude-code       # api | claude-code | claude-code-cached | pi | script
  model: claude-sonnet-4-20250514
  max_tokens: 4096
  fallback: [gpt-4o]          # not yet wired
  claude_env:                 # env vars merged into every claude-code spawn
    API_TIMEOUT_MS: "600000"
  repair:                     # in-station Haiku repair config
    enabled: true
    model: claude-haiku-4-5-20251001

context: full                 # optional — full | summary; default full
                              # explicit reads in a station's frontmatter override this

retry_policy:                 # optional — per-failure-class retry tuning
  envelope:    { maxRetries: 2, backoff: [10, 60] }
  crash:       { maxRetries: 3, backoff: [10, 60, 300] }
  timeout:     { maxRetries: 2, backoff: [30, 300] }
  guardrail:   { maxRetries: 1, backoff: [10] }
  provider:    { maxRetries: 5, backoff: [10, 60, 300, 900, 1800] }
  aborted:     { maxRetries: 99, backoff: [0] }
  unknown:     { maxRetries: 1, backoff: [60] }

on_success:                   # optional — script run after a successful workpiece
  script: ./hooks/notify.ts

on_failure:                   # optional — script run when a workpiece ends in error/
  script: ./hooks/notify.ts

on_complete:                  # optional — fan results into other lines
  - target: downstream-line
    pass:
      seed_items: data.qualifying_items
      run_id: id
    condition: data.qualifying_items   # only fires if path is truthy
    fanout:                                # one downstream task per element
      over: data.qualifying_items
      as: seed_items                   # downstream input[as] = [element]
```

### Sequence step variants

A sequence entry is one of:

| Form | YAML |
|------|------|
| Bare name | `- research` |
| Station object | `- station: { name: enrich, max_wall_clock: 900, timeout: 300, flush_grace: 60, claude_env: {…}, repair: {…}, heartbeat: {…} }` |
| Parallel | `- parallel: [outline, tone-analysis]` |
| Gate | `- gate: { check: review.data.approved, if_true: publish, if_false: revise }` |
| Loop | `- loop: { stations: [review, revise], until: "review.data.approved == true", max: 3 } ` |

Gates and loops are declared today; the runner currently flattens them into a linear ordering and treats gates as fall-through. See [`runner.ts`](../src/runner.ts) → `flattenSequence()`.

### Per-station overrides on a sequence step

The `station` form lets you override fields just for one slot in the sequence — useful when the same station appears twice but with different limits.

```yaml
sequence:
  - station:
      name: enrich
      max_wall_clock: 900     # hard 15-min ceiling for this slot only
      timeout: 300            # idle timeout override
      claude_env:
        ASSEMBLY_DAEMON_PROMPT_CACHING: "1"
```

Merge precedence for `claude_env`: station > line `defaults.claude_env` > process env (notably `ASSEMBLY_CLAUDE_*` overrides).

### `on_complete` triggers and fanout

When a workpiece finishes successfully, the orchestrator can fire downstream tasks.

- `target` — the downstream line name (folder name under `lines/`).
- `target_path` — alternative to `target`. A dotted workpiece path that resolves to the line name at trigger time. Lets one upstream line route to different downstreams per task — e.g. a shared scraper that dispatches to category-specific enrichment lines based on `input.target_line`.
- `pass` — map of workpiece-path → input-key. Forwards data into the new line's `input`.
- `condition` — dotted path; only fires if truthy.
- `fanout.over` — dotted path resolving to an array; emits one task per element.
- `fanout.as` — the input key on the downstream task. The element is wrapped as a singleton array (`input[as] = [element]`) so downstream contracts expecting arrays still work.

See [`runtime.md`](./runtime.md#triggers-and-fanout) for end-to-end behavior.

---

## `AGENT.md`

The prompt + config for one station. Located at `stations/<name>/AGENT.md`.

````markdown
---
# Context selection — overrides line-level `context`. If present, the runner
# uses explicit-reads mode and only includes the listed paths in the prompt.
reads: [task, input, research.content, draft.summary]

# Provider + model override
provider: claude-code          # api | claude-code | claude-code-cached | pi | script
model: sonnet                  # full model id, or short alias resolved by llm.ts
tools: [WebFetch, Read, Bash]  # for claude-code / pi providers

# Only for provider: script — relative path to the script file
script: ./push.ts

# Output validation
guardrails:
  output:
    required:                  # dotted paths that must resolve to defined, non-null
      - summary
      - data.scored_items
    forbidden:                 # paths that must NOT be set; catches adjacent-task drift
      - data.enriched_items
    schema:                    # type / value checks
      data.scored_items:
        type: array
        minItems: 1
      data.scored_items[].tier:    # `[]` iterates each array element
        enum: [a, b, c]
      data.score:
        type: number
        minimum: 0
        maximum: 10
---

# Research Agent

You are a research specialist. Given the task and prior context, …

## Output

Return JSON with:
- `summary`: one-line description of findings (required)
- `content`: full research brief in markdown (optional)
- `data`: { source_count, confidence } (optional)
````

### Frontmatter keys

| Key | Meaning |
|-----|---------|
| `reads` | Array of dotted paths to include in the prompt. Switches the context mode to `explicit`. Valid paths: `task`, `input`, `<station>`, `<station>.summary`, `<station>.content`, `<station>.data`. |
| `provider` | One of `api`, `claude-code`, `claude-code-cached`, `pi`, `script`. Defaults to the line's `defaults.provider`. |
| `model` | Full model id (`claude-sonnet-4-20250514`) or short alias (`sonnet`, `opus`, `haiku`) resolved by [`llm.ts`](../src/llm.ts). |
| `tools` | Tool allowlist for `claude-code` / `pi` providers. |
| `script` | Required when `provider: script` — relative path to the executable. Receives the workpiece path as `argv[1]`, writes the envelope to stdout. |
| `guardrails.output.required` | Dotted paths that must resolve to defined, non-null values in the envelope. |
| `guardrails.output.forbidden` | Dotted paths that must NOT be set. |
| `guardrails.output.schema` | Type / value checks. See [`envelope-and-guardrails.md`](./envelope-and-guardrails.md#guardrails). |

The body of the markdown file is the **system prompt** for the agent.

---

## `EVAL.md`

An optional quality gate at `stations/<name>/EVAL.md`. When present, the runner evaluates the envelope before declaring the station done.

```markdown
---
provider: api                  # api | claude-code | script
model: claude-haiku-4-5-20251001
on_fail: retry                 # retry | escalate | fail | warn; default retry
max_retries: 2                 # default 1
script: ./check-quality.ts     # required when provider: script
---

# Eval Critic

Score the station's output 1–10. Return JSON:
  { "pass": true|false, "feedback": "...", "score": 7, "action": "retry"|"escalate"|null }
```

- The eval prompt is built from the station's envelope (`summary`, `content`, `data`).
- The response is parsed as `EvalResult`. The `action` field in the response **overrides** the frontmatter `on_fail` for that attempt.
- On `retry`: the runner re-invokes the station with the eval feedback embedded. Tokens for eval-retry are dramatically reduced — prior-station context is dropped and replaced by a compact recap (see [`prompt.ts`](../src/prompt.ts) → `buildEvalRetryPrompt`).
- On `escalate`: status becomes `escalated`, the workpiece routes to `queues/review/`, the pipeline halts.
- When `provider: script`, the script receives a temp workpiece with the station's envelope already filed under `stations[name]`.

See [`envelope-and-guardrails.md`](./envelope-and-guardrails.md#eval-evalmd) for the full flow.

---

## `memory/MEMORY.md`

Optional persistent memory at `stations/<name>/memory/MEMORY.md`. The body is injected into the system prompt right after the AGENT.md prompt.

```markdown
# Memory

## Operational Notes
- GitHub search API caps `per_page` at 100; paginate via `&page=`.
- `recent_commits` returns short SHAs only when `?per_page=` is set.

## Learned Patterns
- 2026-04-12: dormant-but-archived repos are graded F, not D.

## Eval Improvements
- 2026-04-22: tightened the rubric to require rationale citing concrete numbers.
```

- Loaded by [`memory.ts`](../src/memory.ts). Frontmatter is stripped, body is body.
- Warns at >8000 chars (~2000 tokens) — keep it focused.
- For `claude-code` stations, the runner appends a note telling the agent it can write additional `.md` files into the `memory/` folder. The full directory is exposed as `station.memoryDir`.
- `EVAL.md` failures auto-append entries via `writeEvalToMemory()` — see [`cost-and-memory.md`](./cost-and-memory.md#station-memory).

---

## Discovery rules — where Assembly looks for lines

When you say `assembly run my-line`, the resolver checks:

1. Exact path (`./lines/my-line/`)
2. Project-local: `<cwd>/.assembly/lines/<name>/`
3. Global: `~/.assembly/lines/<name>/`
4. Falls through to `resolve(<name>)` — the path is taken literally

For the daemon, the same rule plus discovery via `$ASSEMBLY_LINE_DIRS` (colon-separated) and `~/.assembly/config.yaml` → `line_dirs:` array. See [`runtime.md`](./runtime.md#line-discovery).

---

## A complete minimal line

```
lines/hello/
  line.yaml
  stations/
    greet/
      AGENT.md
```

`line.yaml`:
```yaml
name: hello
sequence: [greet]
defaults:
  provider: claude-code
  model: sonnet
```

`stations/greet/AGENT.md`:
````markdown
---
reads: [task]
---

# Greeter

Given the task, produce a friendly one-line greeting.

Return JSON:
- summary: the greeting itself
- data: { tone: "warm" | "neutral" | "formal" }
````

Run it:
```bash
assembly run hello --task "Welcome the new dev to the team"
```
