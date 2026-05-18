# Assembly — Agent Factory Lines

> A framework for building agent workflows using folder structure as configuration.
> Like an assembly line: raw input enters, flows through specialized stations, finished product comes out.

---

## Core Metaphor

```
                    ┌─────────────┐
  Raw Input ───────▶│  Station 1  │──▶ workpiece grows
                    │  (Research)  │
                    └─────────────┘
                          │
                          ▼
                    ┌─────────────┐
   workpiece ──────▶│  Station 2  │──▶ workpiece grows
                    │   (Draft)   │
                    └─────────────┘
                          │
                          ▼
                    ┌─────────────┐
   workpiece ──────▶│  Station 3  │──▶ workpiece grows
                    │  (Review)   │
                    └─────────────┘
                          │
                          ▼
                   Finished Product
```

A **workpiece** moves through **stations**. Each station is an agent
that reads from and writes to the workpiece. The folder structure defines the line.

---

## Three Concepts. That's It.

### 1. Workpiece — The thing being built

A JSON object that accumulates results as it moves through the line.
Every station can read everything, but writes to its own key.

Every station returns the **same envelope**:

```json
{
  "summary": "One-line description of what this station produced",
  "content": "The full markdown/text output (optional)",
  "data": { "any": "structured fields (optional)" }
}
```

- **`summary`** — required, always a string. One sentence. Used for compact context passing.
- **`content`** — optional, free-form text (markdown, prose, code, whatever).
- **`data`** — optional, structured key-value pairs. Objects, arrays, booleans, numbers.

This means the full workpiece looks like:

```json
{
  "id": "run_2026-04-04T10-30-00",
  "line": "content-pipeline",
  "task": "Write a blog post about AI agents",
  "input": { "tone": "casual", "audience": "developers" },
  "stations": {
    "research": {
      "status": "done",
      "summary": "Compiled 12 sources on AI agent trends for 2026",
      "content": "## Key Findings\n- AI agent frameworks grew 3x in 2025\n- 78% of devs...",
      "data": { "source_count": 12, "confidence": "high" },
      "started_at": "2026-04-04T10:30:01Z",
      "finished_at": "2026-04-04T10:30:08Z",
      "model": "claude-sonnet-4-20250514",
      "tokens": { "in": 420, "out": 1250 }
    },
    "draft": {
      "status": "done",
      "summary": "Wrote 800-word blog post with casual tone",
      "content": "# AI Agents Are Eating Software\n\nIn 2026...",
      "data": { "word_count": 823, "reading_time": "4 min" },
      "started_at": "2026-04-04T10:30:09Z",
      "finished_at": "2026-04-04T10:30:18Z",
      "model": "claude-sonnet-4-20250514",
      "tokens": { "in": 1800, "out": 2100 }
    },
    "review": {
      "status": "done",
      "summary": "Approved with 2 minor suggestions",
      "data": {
        "approved": true,
        "score": 8,
        "issues": ["Tighten the intro", "Add a CTA"]
      },
      "started_at": "2026-04-04T10:30:19Z",
      "finished_at": "2026-04-04T10:30:22Z",
      "model": "claude-sonnet-4-20250514",
      "tokens": { "in": 4200, "out": 800 }
    }
  }
}
```

**Rules:**
- `task` and `input` — immutable, set at the start
- `stations.<name>` — each station writes here using the standard envelope
- `summary` — required from every station, always a string
- `content` and `data` — optional, stations use whichever makes sense
- Every station can **read** all previous stations' outputs
- Every station **writes** only to its own key

### 2. Station — A specialized agent

A folder with one required file: `AGENT.md`

```
stations/research/
  AGENT.md        ← The only required file
```

`AGENT.md` is the agent's brain — a markdown file with YAML frontmatter:

```markdown
---
reads: [task, input]              # What this station needs (for docs + context control)
model: claude-sonnet-4-20250514            # Model to use (optional, inherits from line)
tools: [web-search]               # Tools this agent can use (optional)
---

# Research Agent

You are a research specialist. You receive a task and produce a comprehensive
research brief that downstream agents will use.

## Your Job

1. Break down the task into research questions
2. Search for relevant, recent information
3. Compile findings into a structured brief

## Output

You MUST return valid JSON with this shape:
- `summary`: one-line description of your findings
- `content`: your full research brief in markdown
- `data`: structured metadata (source_count, confidence level, key topics)
```

That's it. The markdown body IS the system prompt. The frontmatter IS the config.

### 3. Line — The assembly sequence

A folder where the structure defines the flow:

```
lines/content-pipeline/
  line.yaml                  ← Defines the sequence + config
  stations/
    research/
      AGENT.md
    draft/
      AGENT.md
    review/
      AGENT.md
    publish/
      AGENT.md
```

`line.yaml` — the blueprint:

```yaml
name: content-pipeline
description: Research, draft, review, and publish content

# The sequence — this is the assembly line order
sequence:
  - research
  - draft
  - review
  - publish

# Defaults for all stations (can be overridden per station)
defaults:
  model: claude-sonnet-4-20250514
  max_tokens: 4096
```

**Why a separate `line.yaml` instead of numbered folders?**
- Reorder without renaming folders
- Same station can appear twice (e.g., review → revise → review)
- Clearer than parsing `01-`, `02-` prefixes
- Supports advanced patterns (parallel, conditional) in one place

---

## The Standard Envelope — Why It Matters

Every station returns the same JSON shape. Always. This is the **single most important
design decision** in Assembly.

```json
{
  "summary": "string (required) — one-liner of what was produced",
  "content": "string (optional) — full text output",
  "data": { }  // object (optional) — structured fields
}
```

**Why this works:**

1. **Compact context passing.** The runner can build downstream prompts using just summaries:
   ```
   ## Previous Stations
   - research: Compiled 12 sources on AI agent trends for 2026
   - draft: Wrote 800-word blog post with casual tone
   ```
   No need to dump full outputs into every prompt. Saves tokens, keeps focus.

2. **Full context when needed.** A station that declares `reads: [research.content]`
   gets the full research text. Explicit and controlled.

3. **Structured gates.** Conditions work naturally:
   ```yaml
   gate:
     check: review.data.approved
   ```
   No special "JSON mode" — `data` is always an object.

4. **Mixed formats.** A research agent is `content`-heavy (lots of text).
   A review agent is `data`-heavy (scores, booleans). Both use the same envelope:
   ```json
   // research — mostly text
   { "summary": "...", "content": "## Key Findings\n...", "data": { "source_count": 12 } }

   // review — mostly structured
   { "summary": "...", "data": { "approved": true, "score": 8, "issues": [...] } }

   // code-gen — both
   { "summary": "...", "content": "```python\ndef main()...\n```", "data": { "language": "python", "lines": 42 } }
   ```

5. **Validation.** The runner can validate every station's output before proceeding:
   - Has `summary`? (required)
   - Is it valid JSON?
   - Does `data` match an optional schema from the AGENT.md frontmatter?

---

## How It Runs

### The Simplest Case

```bash
assembly run lines/content-pipeline --task "Write a blog post about AI agents"
```

What happens:
1. Creates a workpiece: `{ task: "...", input: {}, stations: {} }`
2. Reads `line.yaml` → gets sequence: `[research, draft, review, publish]`
3. For each station in sequence:
   a. Loads `AGENT.md` (frontmatter + prompt)
   b. Builds the LLM message: system prompt + workpiece context
   c. Calls the model (with JSON output mode)
   d. Validates the response has `summary` (required)
   e. Writes `{ summary, content, data, status, timing, tokens }` to workpiece
   f. Saves `workpiece.json` to disk (checkpoint)
4. Returns the final workpiece

### What Each Agent Actually Sees

When the `draft` station runs, it receives:

```
┌─ SYSTEM MESSAGE ──────────────────────────────────────────┐
│ [contents of draft/AGENT.md body]                         │
│                                                           │
│ IMPORTANT: You MUST respond with valid JSON containing:   │
│ - "summary": one-line description (required)              │
│ - "content": your full output text (optional)             │
│ - "data": any structured metadata (optional)              │
└───────────────────────────────────────────────────────────┘

┌─ USER MESSAGE ────────────────────────────────────────────┐
│ # Task                                                    │
│ Write a blog post about AI agents                         │
│                                                           │
│ # Input                                                   │
│ { "tone": "casual", "audience": "developers" }            │
│                                                           │
│ # Previous Stations                                       │
│                                                           │
│ ## research (summary)                                     │
│ Compiled 12 sources on AI agent trends for 2026           │
│                                                           │
│ ## research (content)                                     │
│ ## Key Findings                                           │
│ - AI agent frameworks grew 3x in 2025                     │
│ - 78% of devs have tried at least one...                  │
│                                                           │
│ ---                                                       │
│ Produce your output now.                                  │
└───────────────────────────────────────────────────────────┘
```

### Context Modes — What Previous Stations Get Included

As stations accumulate, the "Previous Stations" section grows.
Three strategies, configured in `line.yaml` or per-station in `AGENT.md`:

**Full (default)** — every station sees all prior summaries + content:
```yaml
context: full
```

**Summary only** — only summaries, not full content (saves tokens):
```yaml
context: summary
```

**Explicit reads** — station declares exactly what it needs:
```yaml
---
reads: [task, input, research.content, draft.summary]
---
```
Only those fields are included. Most efficient for long lines.

---

## Advanced Patterns

These are defined in `line.yaml` when you need them. The basic sequential case
requires none of this.

### Parallel Stations

```yaml
sequence:
  - research
  - parallel:
      - outline
      - tone-analysis
  - draft
```

`outline` and `tone-analysis` run simultaneously. Both outputs are
available to `draft`.

### Gates (Conditional Routing)

```yaml
sequence:
  - research
  - draft
  - review
  - gate:
      check: review.data.approved
      if_true: publish
      if_false: revise
  - publish
```

Gates read `data` fields from any station's envelope. Because `data` is
always structured JSON, conditions are simple path expressions.

### Loops

```yaml
sequence:
  - research
  - draft
  - loop:
      stations: [review, revise]
      until: review.data.approved == true
      max: 3
  - publish
```

### Guardrails (Input/Output Validation)

Inspired by OpenAI Agents SDK. Define validation rules per station:

```yaml
---
guardrails:
  output:
    required: [summary]
    schema:
      data:
        approved: boolean
        score: { type: number, min: 1, max: 10 }
---
```

The runner validates the station's output against the schema before
writing it to the workpiece. If validation fails, the station is retried
or marked as `failed`.

### Model Failover

Define fallback chains:

```yaml
defaults:
  model: claude-sonnet-4-20250514
  fallback: [gpt-4o, deepseek-r1]
```

If the primary model returns a 5xx or times out, the runner automatically
tries the next model in the chain.

### Shared Station Library

Stations can be referenced from a shared library:

```yaml
sequence:
  - research                          # local: ./stations/research/
  - shared:tone-check                 # shared: ~/.assembly/stations/tone-check/
  - draft
```

Build a station once, reuse it everywhere.

---

## Storage & Resume

### On Disk

```
runs/
  2026-04-04T10-30-00-content-pipeline/
    workpiece.json          ← Current state (updated after each station)
    log.jsonl               ← Append-only execution log
```

**workpiece.json** — always reflects the latest state. After all stations
complete, this is the final result. If the run fails mid-way, this shows
exactly where it stopped. You can `cat` it, `jq` it, pipe it, `git diff` it.

**log.jsonl** — one JSON line per event:
```jsonl
{"event":"run_start","line":"content-pipeline","task":"...","ts":"2026-04-04T10:30:00Z"}
{"event":"station_start","station":"research","model":"claude-sonnet-4-20250514","ts":"2026-04-04T10:30:01Z"}
{"event":"station_end","station":"research","status":"done","tokens":{"in":420,"out":1250},"ts":"2026-04-04T10:30:08Z"}
{"event":"station_start","station":"draft","model":"claude-sonnet-4-20250514","ts":"2026-04-04T10:30:09Z"}
{"event":"station_end","station":"draft","status":"done","tokens":{"in":1800,"out":2100},"ts":"2026-04-04T10:30:18Z"}
{"event":"run_end","status":"done","total_tokens":{"in":6420,"out":4150},"duration":"22s","ts":"2026-04-04T10:30:22Z"}
```

### Resume & Replay

Because the workpiece is saved after each station:

```bash
# Resume from where it failed
assembly run lines/content-pipeline \
  --resume runs/2026-04-04.../workpiece.json --from review

# Re-run just one station (for iterating on prompts)
assembly run lines/content-pipeline \
  --resume runs/2026-04-04.../workpiece.json --only draft

# Dry run — show what would execute
assembly run lines/content-pipeline --task "..." --dry
```

---

## Folder Structure — Full Picture

```
~/.assembly/                          # Global config + shared stations
  config.yaml                         # Global defaults (model, keys, etc.)
  stations/                           # Shared/reusable stations
    tone-check/
      AGENT.md
    fact-check/
      AGENT.md
    json-validator/
      AGENT.md

project/                              # Any project
  lines/                              # Workflows for this project
    content-pipeline/
      line.yaml
      stations/
        research/
          AGENT.md
        draft/
          AGENT.md
        review/
          AGENT.md
        publish/
          AGENT.md
    bug-triage/
      line.yaml
      stations/
        gather/
          AGENT.md
        analyze/
          AGENT.md
        prioritize/
          AGENT.md

  runs/                               # Execution history (auto-generated)
    2026-04-04T10-30-00-content-pipeline/
      workpiece.json
      log.jsonl
```

---

## Real Example: Bug Investigation Line

```
lines/bug-investigation/
  line.yaml
  stations/
    fetch-ticket/AGENT.md
    gather-slack/AGENT.md
    find-session/AGENT.md
    analyze/AGENT.md
    enrich-ticket/AGENT.md
```

`line.yaml`:
```yaml
name: bug-investigation
description: Investigate a bug ticket end-to-end

sequence:
  - fetch-ticket
  - parallel:
    - gather-slack
    - find-session
  - analyze
  - enrich-ticket

defaults:
  model: claude-sonnet-4-20250514
```

`stations/fetch-ticket/AGENT.md`:
```markdown
---
reads: [task]
tools: [linear]
guardrails:
  output:
    required: [summary, data]
    schema:
      data:
        identifier: string
        title: string
        slack_urls: array
---

# Fetch Ticket

You retrieve the full context of a Linear ticket.

Given a ticket ID in the task, fetch:
- Title, description, state, priority
- Comments and their authors
- Labels
- Any URLs in the description (Slack links, trace IDs, media)

## Output

Return JSON with:
- `summary`: one-line description of the ticket
- `content`: the full ticket description and comments
- `data`: { identifier, title, state, priority, url, slack_urls, media_urls, trace_ids }
```

`stations/analyze/AGENT.md`:
```markdown
---
reads: [task, fetch-ticket.data, gather-slack.content, find-session.content]
---

# Analyze Bug

You are a senior engineer performing root cause analysis.

You have:
- The ticket details (from fetch-ticket)
- Slack thread context (from gather-slack)
- Session replay data (from find-session)

## Your Job

1. Correlate the information across sources
2. Identify the likely root cause
3. Determine reproduction steps
4. Assess severity and impact

## Output

Return JSON with:
- `summary`: one-line root cause hypothesis
- `content`: full analysis with repro steps, root cause, and recommendations
- `data`: { root_cause, severity, reproducible, affected_areas }
```

---

## Ideas Borrowed From the Best

After studying LangGraph, CrewAI, OpenAI Agents SDK, Google ADK, and
Pydantic AI, here's what Assembly takes from each:

| Framework | Key Idea We Took | How It Shows Up |
|-----------|-----------------|-----------------|
| **LangGraph** | Typed state + checkpointing | The workpiece is typed JSON, saved after every station. Resume from any point. |
| **LangGraph** | Explicit state transitions | `line.yaml` sequence is the graph. No hidden magic. |
| **CrewAI** | Role clarity + fast prototyping | One AGENT.md per station. Define a role in plain English. Ship in minutes. |
| **OpenAI SDK** | Guardrails on I/O | Optional schema validation on every station's output envelope. |
| **OpenAI SDK** | Built-in tracing | `log.jsonl` records every event — station starts, ends, tokens, errors. |
| **Google ADK** | Parallel + Loop primitives | `parallel:` and `loop:` blocks in line.yaml. |
| **Pydantic AI** | Output validation / schemas | `guardrails.output.schema` in AGENT.md frontmatter. |
| **All of them** | Standard protocol | The envelope (`summary` + `content` + `data`) is Assembly's protocol. |

Three further design choices weren't borrowed from any one framework, but
fall out of using the file system as the source of truth:

- **File-based auditable state.** The workpiece is a JSON file you can `cat`, `jq`, `git diff`. No databases.
- **Model failover chains.** `fallback: [gpt-4o, deepseek-r1]` in config; auto-retry on transient failure.
- **Crash recovery.** Write-ahead — the workpiece is saved after each station, so a run resumes exactly where it stopped.

### What Assembly Does Differently

- **No code required.** Folders + markdown + YAML. That's the whole API.
- **Standard envelope forces consistency.** Every framework above has a different I/O
  format per agent. Assembly has one: `{ summary, content, data }`.
- **Context control is first-class.** `reads:` in frontmatter + context modes
  (`full`, `summary`, explicit) solve the token bloat problem that plagues
  every other framework when chains get long.
- **The file system IS the UI.** `ls` shows the pipeline. `cat` shows the prompt.
  `jq` queries the workpiece. No dashboards needed (but you could build one).

---

## Design Principles

1. **Folders are config.** The file system is the UI. `ls` shows you the pipeline.
2. **Markdown is the prompt.** No DSL. No YAML-encoded prompts. Write naturally.
3. **One envelope to rule them all.** `{ summary, content, data }` everywhere.
4. **The workpiece is the API.** One JSON object, read-anywhere, write-to-your-key.
5. **Stations are pure.** Input → Output. No side effects beyond your key.
6. **Start sequential, add complexity only when needed.** Parallel, loops, and gates are opt-in.
7. **Every run is saved.** Inspect, debug, resume any execution.
8. **Fail gracefully.** Model failover, output validation, checkpointed resume.

---

## What's NOT in Scope (Intentionally)

- **Orchestration UI** — CLI/code first. UI can come later.
- **Agent-to-agent chat** — Stations don't talk. They talk through the workpiece.
- **State machines** — Sequence + loops + gates covers 95% of cases.
- **Framework lock-in** — The runner is simple. The value is in the format.

---

## CLI Reference

```bash
# Run a line
assembly run <line-path> --task "Your task here"
assembly run <line-path> --task "..." --input '{"key": "value"}'

# Resume from checkpoint
assembly run <line-path> --resume <workpiece.json> --from <station>
assembly run <line-path> --resume <workpiece.json> --only <station>

# Inspect
assembly inspect <workpiece.json>                    # Pretty-print the workpiece
assembly inspect <workpiece.json> --station research  # Show one station's output
assembly log <run-dir>                                # Stream the execution log

# Validate (without running)
assembly validate <line-path>                         # Check line.yaml + all AGENT.md files
assembly dry <line-path> --task "..."                  # Show execution plan

# Stations
assembly list-stations                                # Show shared station library
assembly test-station <station-path> --workpiece <json> # Run one station in isolation
```

---

## Programmatic (TypeScript)

```typescript
import { Assembly } from './assembly'

const line = Assembly.load('lines/content-pipeline')

const result = await line.run({
  task: 'Write a blog post about AI agents',
  input: { audience: 'developers', tone: 'casual' }
})

// Access any station's envelope
console.log(result.stations.research.summary)   // "Compiled 12 sources..."
console.log(result.stations.review.data.approved) // true
console.log(result.stations.draft.content)        // "# AI Agents Are Eating..."
```

---

## Next Steps

1. **Scaffold the runner** — TypeScript CLI that reads `line.yaml` + `AGENT.md` files
2. **Implement the envelope** — JSON output mode + validation
3. **Build 2-3 real lines** — Content pipeline, bug investigation, daily standup
4. **Add pi integration** — Use `subagent` for execution, shared stations in `~/.pi/agent/`

---

## Timeout Stack

Assembly applies a layered defense against stuck claude-code processes:

| Layer | Scope | Mechanism |
|-------|-------|-----------|
| Bash tool timeout | Per-tool-call | `BASH_DEFAULT_TIMEOUT_MS=120000`, `BASH_MAX_TIMEOUT_MS=900000` |
| Stream watchdog | Per-API-response | `CLAUDE_ENABLE_BYTE_WATCHDOG=1`, `CLAUDE_ENABLE_STREAM_WATCHDOG=1`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS=300000` |
| API timeout | Per-API-call | `API_TIMEOUT_MS=600000` |
| Station timeout | Per-station | line.yaml `timeout:` or per-station `{ station: { name, timeout } }` — enforced by orchestrator via SIGTERM/SIGKILL |
| Idle watchdog | Per-station | (planned: assembly-idle-timeout-soft-kill.md) — reads `getLastActivityMs()` from the progress feature |

These env vars are applied to every `Bun.spawn` of `claude` in `callClaudeCode()`. Overridable per line (`defaults.claude_env`) and per station (`sequence[].station.claude_env`). Merge precedence: station > line > global defaults > process env (`ASSEMBLY_CLAUDE_*`).

Relevant upstream issues:
- [#38437](https://github.com/anthropics/claude-code/issues/38437) — MCP proxy silent hang
- [#25629](https://github.com/anthropics/claude-code/issues/25629) — stream-json post-result hang
- [#43791](https://github.com/anthropics/claude-code/issues/43791) — MCP timeout field ignored
