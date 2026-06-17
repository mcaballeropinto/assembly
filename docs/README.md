# Assembly Documentation Index

> Agent factory lines — folder-driven multi-agent workflows.
> Tasks flow through specialized stations on a file-based queue. No databases.

This index is the entry point. Each doc is self-contained and cross-links to others. Read the doc you need; you don't need to read in order.

If you only have time for two pages: read [`overview.md`](./overview.md) and [`concepts.md`](./concepts.md).

---

## Map

### Start here

| Doc | What it covers |
|-----|----------------|
| [`overview.md`](./overview.md) | What Assembly is, the assembly-line metaphor, where files live, what makes it different from LangGraph / CrewAI |
| [`concepts.md`](./concepts.md) | The four core terms — workpiece, envelope, station, line — and how they relate |
| [`glossary.md`](./glossary.md) | Every term in one place. Cross-reference when reading other docs |

### Configuration reference

| Doc | What it covers |
|-----|----------------|
| [`configuration.md`](./configuration.md) | `line.yaml` schema, `AGENT.md` frontmatter, `EVAL.md`, `memory/MEMORY.md` |
| [`cli.md`](./cli.md) | Every CLI subcommand, flags, line resolution, env vars |

### How it runs

| Doc | What it covers |
|-----|----------------|
| [`runtime.md`](./runtime.md) | Daemon lifecycle, global orchestrator, per-line orchestrator, section workers, signals, PID files, hot reload / handoff |
| [`queues-and-flow.md`](./queues-and-flow.md) | File-based queues, the inbox → processing → output → done/error/review path, `on_complete` fanout triggers, held/release, producer allowlist (emit-manifest) |
| [`execution.md`](./execution.md) | What happens inside one station: providers (`api`/`claude-code`/`claude-code-cached`/`pi`/`script`), prompt building, context modes, scratch dir, tool rounds |

### Correctness & reliability

| Doc | What it covers |
|-----|----------------|
| [`envelope-and-guardrails.md`](./envelope-and-guardrails.md) | Envelope parsing, in-session nudge + Haiku repair, guardrail validation, EVAL.md, escalation |
| [`reliability.md`](./reliability.md) | Failure classes, retry policy, the layered timeout stack (Bash → stream → API → station idle → station wall-clock), reaper |

### Observability

| Doc | What it covers |
|-----|----------------|
| [`dashboard.md`](./dashboard.md) | React SPA dashboard, Bun static/API server, Vite dev flow, build/ship workflow, data sources, kanban, retry, error dismissal, usage, task-events |
| [`cost-and-memory.md`](./cost-and-memory.md) | Pricing table, token + cache accounting, per-station `memory/MEMORY.md` persistence |

### Example lines in this repo

| Doc | What it covers |
|-----|----------------|
| [`lines-catalog.md`](./lines-catalog.md) | The example lines under `lines/` — `hello-world`, `repo-health-digest`, `assembly-dev` |

### Building your own

| Doc | What it covers |
|-----|----------------|
| [`development-guide.md`](./development-guide.md) | How to build a new line end-to-end, common pitfalls (scratch leakage, inbox fabrication, neutral task titles), testing |
| [`ai-agent-guidelines.md`](./ai-agent-guidelines.md) | Repo rules for AI agents and automation: git hygiene, generated bundles, parallel-safe tests, deploy discipline |

---

## Cheat sheet — the 30-second model

```
line.yaml             defines the sequence of stations
stations/<name>/      contains AGENT.md (the prompt) + optional EVAL.md + optional memory/
workpiece.json        the accumulating state — one JSON file per run
envelope              what each station returns: { summary, content?, data? }
queues/               file-based mailboxes — moving files = moving state
daemon                watches queues, spawns section workers, routes outputs
dashboard             Bun-served React dashboard; reads disk, shows kanban, activity + costs
```

Everything else is a refinement on these.

---

## Authoritative sources outside `docs/`

`docs/` is the curated layer. When digging deeper, the canonical references are:

- [`../DESIGN.md`](../DESIGN.md) — the original design intent
- [`../DATA-FLOW.md`](../DATA-FLOW.md) — step-by-step trace through one run
- [`../src/types.ts`](../src/types.ts) — the type definitions for every shape mentioned here
- [`../skill/SKILL.md`](../skill/SKILL.md) — the user-facing skill description (kept concise)

If a doc here disagrees with the code, the code wins — please update the doc.
