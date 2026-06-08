---
name: assembly
description: |
  Run multi-agent pipelines using Assembly — a factory-line framework where tasks flow through specialized AI stations. Use when the user asks to run a pipeline, execute a line, create or manage assembly workflows, or needs multi-step AI processing (e.g., "research then draft then review"). Also use when they mention "assembly", "line", "station", "workpiece", or "factory line".
---

# Assembly — Agent Factory Lines

Assembly is a CLI tool that chains AI agents into pipelines. Each pipeline ("line") has stations that process a task sequentially, passing results through a shared workpiece.

## Quick Reference

```bash
# List available lines
assembly list

# Run a line by name (searches ~/.assembly/lines/ and .assembly/lines/)
assembly run <line-name> --task "Your task" --input '{"key":"value"}'

# Run a line by path
assembly run ./path/to/line --task "Your task"

# Dry run — see execution plan without calling models
assembly dry <line-name> --task "Your task"

# Inspect results
assembly inspect <workpiece.json>
assembly inspect <workpiece.json> --station <name>

# Resume from failure
assembly run <line-name> --resume <workpiece.json> --from <station>

# Re-run single station
assembly run <line-name> --resume <workpiece.json> --only <station>

# Validate a line
assembly validate <line-name>

# Initialize ~/.assembly
assembly init
```

## Key Concepts

- **Line** — A pipeline defined by `line.yaml` + `stations/` folder
- **Station** — One AI agent step, defined by `AGENT.md` (frontmatter + markdown prompt)
- **Workpiece** — JSON file accumulating results as they flow through stations
- **Envelope** — Every station returns `{ summary, content, data }` — standardized output

## Providers

Each station can use a different provider:

| Provider | Set with | Capabilities |
|----------|----------|-------------|
| `api` | `provider: api` | Direct LLM call (fast, cheap) |
| `claude-code` | `provider: claude-code` | LLM + bash, read, write, edit tools |
| `pi` | `provider: pi` | LLM + all pi tools, skills, extensions |

## Creating a New Line

```bash
# Create the structure
mkdir -p ~/.assembly/lines/my-line/stations/{step1,step2}

# Create line.yaml
cat > ~/.assembly/lines/my-line/line.yaml << 'EOF'
name: my-line
description: What this pipeline does

sequence:
  - step1
  - step2

defaults:
  model: claude-sonnet-4-20250514
  max_tokens: 4096
EOF

# Create station AGENT.md
cat > ~/.assembly/lines/my-line/stations/step1/AGENT.md << 'EOF'
---
reads: [task, input]
---

# Step 1 Agent

Your instructions here.

## Output

Return JSON with:
- `summary`: one-line description
- `content`: full output text (optional)
- `data`: structured data (optional)
EOF
```

## Directory Structure

```
~/.assembly/
  .env              ← API keys (ANTHROPIC_API_KEY)
  lines/            ← Pipeline definitions
    my-line/
      line.yaml
      stations/
        step1/AGENT.md
        step2/AGENT.md
  stations/         ← Shared reusable stations
  runs/             ← Execution history
    run_.../
      workpiece.json
      log.jsonl
```

## Environment

Assembly loads API keys from (in order):
1. `~/.assembly/.env`
2. `.env` in current directory
3. `.assembly/.env` in current directory
4. Shell environment variables

Required: `ANTHROPIC_API_KEY` for the `api` provider.

## Workpiece Format

Every run produces a `workpiece.json`:

```json
{
  "id": "run_2026-...",
  "line": "my-line",
  "task": "The original task",
  "input": { "key": "value" },
  "stations": {
    "step1": {
      "status": "done",
      "summary": "What step1 produced",
      "content": "Full text output...",
      "data": { "structured": "fields" },
      "model": "claude-sonnet-4-20250514",
      "tokens": { "in": 500, "out": 200 }
    }
  }
}
```
