# Overview

Assembly is a framework for **chaining AI agents into pipelines** using folder structure as configuration. Each pipeline (a **line**) has **stations** (specialized agents) that process a task sequentially, passing results through a shared JSON file (the **workpiece**).

It is invoked as a CLI (`assembly`) implemented in TypeScript, run with Bun. State is kept on disk in plain files — no database, no message queue.

## The metaphor

```
                ┌─────────────┐
Raw Input ────▶ │  Station 1  │ ─▶ workpiece grows
                │  (research) │
                └─────────────┘
                       │
                       ▼
                ┌─────────────┐
                │  Station 2  │ ─▶ workpiece grows
                │   (draft)   │
                └─────────────┘
                       │
                       ▼
                ┌─────────────┐
                │  Station 3  │ ─▶ workpiece grows
                │  (review)   │
                └─────────────┘
                       │
                       ▼
              Finished workpiece
```

A workpiece moves through stations. Each station is an agent that reads from the workpiece and writes back to its own key. Folder structure defines the line.

## What's actually on disk

```
~/.assembly/                            # Global config + state
  .env                                  # API keys
  orchestrator.pid                      # Daemon PID file
  dashboard.pid                         # Dashboard PID file
  usage-status.json                     # Provider quota snapshot
  lines/                                # Globally available pipelines
  stations/                             # Globally available reusable stations
  runs/                                 # Run history

<repo>/lines/<line-name>/               # A line definition
  line.yaml                             # Sequence + defaults
  stations/<station>/AGENT.md           # The agent's prompt + frontmatter
  stations/<station>/EVAL.md            # (optional) Quality gate
  stations/<station>/memory/MEMORY.md   # (optional) Persistent memory
  queues/                               # Runtime state
    inbox/      held/      done/
    error/      review/    activity.jsonl
  stations/<station>/queue/
    inbox/      processing/    output/
```

See [`queues-and-flow.md`](./queues-and-flow.md) for the full directory map and [`configuration.md`](./configuration.md) for each file's schema.

## Two ways to run

1. **Batch / one-shot** — `assembly run <line> --task "..."`
   Synchronous; runs in the foreground; prints the workpiece path when done.

2. **Daemon** — `assembly daemon start` plus `assembly enqueue <line> --task "..."`
   The daemon watches `queues/inbox/` for new tasks and runs them asynchronously. The dashboard (`assembly dashboard`) provides a live view.

The daemon is the production mode. The batch mode is for one-off scripting and dry runs.

## Three concepts make the framework

1. **Workpiece** — A JSON file that accumulates results.
2. **Station** — A folder with `AGENT.md`. Reads the workpiece, writes its key.
3. **Line** — A folder with `line.yaml`. Defines the order of stations.

A single shape is returned by every station — the **standard envelope**:

```json
{ "summary": "string (required)", "content": "string (optional)", "data": { } }
```

Same shape everywhere. See [`concepts.md`](./concepts.md) for the full mental model.

## Why folder-driven

- `ls` shows you the pipeline.
- `cat AGENT.md` shows you the prompt.
- `jq` queries the workpiece.
- `git diff` shows you exactly what changed run-to-run.
- No SDK, no DSL — markdown body is the system prompt, YAML frontmatter is the config.

## What Assembly takes from prior art

| From | Idea |
|------|------|
| **LangGraph** | Typed state + checkpointing |
| **CrewAI** | Role clarity per station |
| **OpenAI Agents SDK** | Guardrails on I/O, built-in tracing |
| **Google ADK** | Parallel + loop primitives |
| **Pydantic AI** | Output schema validation |

Beyond those, Assembly leans on file-based auditable state (the workpiece is just JSON on disk), model-failover chains, and write-ahead crash recovery — three properties that fall out naturally from treating the file system as the source of truth.

What is **different**: every framework above invents a new I/O shape per agent. Assembly uses one envelope for every station, and the file system is the UI.

## What is NOT in scope

- Orchestration UI beyond the dashboard (no drag-and-drop builder).
- Agent-to-agent chat — stations talk through the workpiece, not directly.
- State machines as a first-class concept — `sequence` + loops + gates cover the cases that matter.

## Where to go next

- [`concepts.md`](./concepts.md) — the four nouns explained in depth.
- [`runtime.md`](./runtime.md) — how the daemon actually runs lines.
- [`development-guide.md`](./development-guide.md) — build your own line.
