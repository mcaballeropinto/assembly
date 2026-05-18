# Core Concepts

Four nouns. Everything in Assembly is a refinement on these.

## 1. Workpiece

A JSON file accumulating results as it moves through a line. One workpiece per run.

```jsonc
{
  "id": "run_2026-05-13T15-32-44.123_abc",
  "line": "content-pipeline",
  "task": "Write a blog post about AI agents",
  "input": { "tone": "casual" },
  "stations": {
    "research": {
      "status": "done",
      "summary": "Compiled 12 sources on AI agent trends",
      "content": "## Key Findings\n…",
      "data": { "source_count": 12 },
      "started_at": "…", "finished_at": "…",
      "model": "claude-sonnet-4-20250514",
      "tokens": { "in": 420, "out": 1250, "cache_read": 0, "cache_creation": 0 },
      "cost_usd": 0.014
    }
  },
  "totals": { "tokens": { "in": 6420, "out": 4150 }, "cost_usd": 0.072 }
}
```

**Rules:**

- `task` and `input` are immutable — set once at the start.
- `stations.<name>` is written by the runner using the **envelope** returned by the station.
- Every station can read all prior station outputs.
- The runner saves `workpiece.json` to disk after every station — a checkpoint.

**ID format:** `run_<ISO-UTC-with-dashes>_<3-hex>`. The 3-hex suffix is a process-local atomic counter that prevents collisions on fanout batches (see [`workpiece.ts`](../src/workpiece.ts)).

Internal scratch fields the runner uses (not part of the public envelope, prefixed `_`):
- `_retry_history` — accumulated failed attempts awaiting consumption.
- `_pending_eval_feedback` — eval critique fed into the next attempt's prompt for `script` provider stations.

Workpieces live in `~/.assembly/runs/<id>-<line>/workpiece.json` (and in per-station queue directories while in flight).

See [`../src/workpiece.ts`](../src/workpiece.ts) and [`../src/types.ts`](../src/types.ts) for full types.

## 2. Envelope

The **standard return shape** for every station — the single most important design decision in Assembly.

```json
{
  "summary": "string — required, one line, what was produced",
  "content": "string — optional, full text output (markdown, prose, code)",
  "data":    { "optional": "structured fields (objects, arrays, primitives)" }
}
```

Why one shape:

- **Compact context.** Downstream stations can be shown only summaries (saving tokens) and pull `content`/`data` explicitly when needed.
- **Structured gates.** `gate.check: review.data.approved` works because `data` is always an object.
- **Mixed styles.** A research agent leans on `content`; a review agent leans on `data`; both use the same envelope.
- **Validation.** The runner can validate every output the same way.

The runner takes the envelope a station returns and files it into `workpiece.stations[name]`, adding `status`, `started_at`, `finished_at`, `model`, `tokens`, `cost_usd`, `eval` (if EVAL.md ran), and `previous_attempts` (if retries happened).

A `script`-provider station returns the envelope on stdout. An LLM-provider station returns it as JSON in its response. See [`envelope-and-guardrails.md`](./envelope-and-guardrails.md) for parsing, repair, and validation.

## 3. Station

A folder with one required file: `AGENT.md`.

```
stations/research/
  AGENT.md                # required — frontmatter + prompt
  EVAL.md                 # optional — quality gate
  memory/MEMORY.md        # optional — persistent learnings
```

`AGENT.md` has YAML frontmatter + markdown body. The **body is the system prompt**. The frontmatter is the station's config.

```markdown
---
reads: [task, input, research.content]
provider: claude-code
model: sonnet
tools: [WebFetch, Read]
guardrails:
  output:
    required: [summary]
    schema:
      data.source_count: { type: number, minimum: 1 }
---

# Research Agent

You are a research specialist. Given the task, …
```

Frontmatter keys are documented in [`configuration.md`](./configuration.md).

## 4. Line

A folder with `line.yaml` and a `stations/` subfolder. `line.yaml` is the blueprint.

```yaml
name: content-pipeline
description: Research, draft, review, publish

sequence:
  - research
  - draft
  - review
  - publish

concurrency: 1
timeout: 600

defaults:
  provider: claude-code
  model: claude-sonnet-4-20250514
  max_tokens: 4096
```

A sequence entry can be:

- A bare station name: `research`
- A station object with per-invocation overrides: `{ station: { name: enrich, max_wall_clock: 900 } }`
- A parallel block: `{ parallel: [outline, tone-analysis] }`
- A gate: `{ gate: { check: "review.data.approved", if_true: publish, if_false: revise } }`
- A loop: `{ loop: { stations: [review, revise], until: "review.data.approved == true", max: 3 } }`

The runner flattens these into a linear ordering it can execute (see [`runner.ts`](../src/runner.ts) → `flattenSequence()`).

Full schema reference: [`configuration.md`](./configuration.md).

## How they relate

```
              Line                (line.yaml)
                ▼
        ┌───────┴───────┐
        ▼               ▼
     Station        Station       (each: AGENT.md + EVAL.md? + memory/)
        │               │
        └──── envelope ─┘
                ▼
           Workpiece              (one JSON file, accumulates envelopes)
```

A run starts when something writes a JSON file to `<line>/queues/inbox/` (CLI, trigger, or fanout from another line). The daemon picks it up, the line's orchestrator drives it through each station, and the final workpiece lands in `queues/done/` (or `error/` or `review/`).

For the directory layout, see [`queues-and-flow.md`](./queues-and-flow.md).
For what the daemon actually does, see [`runtime.md`](./runtime.md).
For what one station actually does, see [`execution.md`](./execution.md).
