# Lines Catalog

The lines that ship under [`../lines/`](../lines/). Three example lines that
together cover the framework's main building blocks. Read them in the order
they're listed here.

```
hello-world  →  repo-health-digest  →  assembly-dev
  (2 stations,    (5 stations,           (3 stations,
   script+LLM)    fanout-ready,          self-modifying
                  EVAL gate)             worktree pipeline)
```

---

## `hello-world`

**Path:** `lines/hello-world/`
**Purpose:** Smallest possible Assembly line. Pairs one LLM station with one
deterministic script station so you can see the envelope contract end-to-end
without distractions.

### Stations
| Station | Provider | Role |
|---------|----------|------|
| `greet`  | `claude-code` (haiku) | Generate a short greeting from the task description. |
| `record` | `script`              | Append the greeting to `lines/hello-world/greetings.md`. |

### Run it
```bash
assembly enqueue hello-world --task "Greet a new open-source contributor"
```

### Notable
- `greet` has zero tools — the LLM produces the envelope directly from the
  task prompt. The simplest possible LLM station.
- `record` is a script provider: real code, deterministic, no LLM cost.
- The pair illustrates the most common collaboration pattern: an LLM does
  creative work, a script writes the result to disk.

---

## `repo-health-digest`

**Path:** `lines/repo-health-digest/`
**Purpose:** Five-station pipeline that audits GitHub repositories and emits
a graded markdown digest. Demonstrates how script and LLM stations cooperate
across a longer sequence, with an eval gate keeping the LLM honest.

### Stations
| Station | Provider | Role |
|---------|----------|------|
| `discover` | `script`              | Resolve `input.repos` or `input.topic` to a normalised repo list. |
| `fetch`    | `script`              | Pull metadata, recent commits, and issue counts from the GitHub API. |
| `analyze`  | `claude-code` (sonnet)| Compute qualitative health signals per repo. |
| `score`    | `claude-code` + `EVAL`| Combine signals into a letter grade with a strict rubric. |
| `report`   | `script`              | Aggregate everything into a timestamped markdown digest. |

### Run it
```bash
assembly enqueue repo-health-digest \
  --task "Audit Anthropic SDK ecosystem" \
  --input '{"repos":["anthropics/anthropic-sdk-python","anthropics/anthropic-sdk-typescript"]}'
```

Or by topic:

```bash
assembly enqueue repo-health-digest \
  --task "Top claude-sdk repos" \
  --input '{"topic":"claude-sdk","limit":10}'
```

Set `GITHUB_TOKEN` to lift the unauthenticated 60-req/hr ceiling.

### Notable
- **EVAL gate at `score`**: a cheap haiku eval re-checks each scored repo
  against the rubric (grade-band consistency, rationale cites real numbers).
  On failure the runner retries `score` with the eval feedback inlined.
- **Script ↔ LLM separation**: `discover` / `fetch` / `report` are pure code
  (deterministic, free), `analyze` / `score` are LLM-judged (the parts where
  human-like interpretation pays off).
- **Aggregator pattern in `report`**: takes the output of every prior station
  and produces a single artifact under `lines/repo-health-digest/digests/`.

---

## `assembly-dev`

**Path:** `lines/assembly-dev/`
**Purpose:** Meta-line — Assembly developing Assembly. Takes a feature
request or bug report through three stages: plan → develop → deploy. Useful
both as a working example of long, stateful pipelines and as the line you
can actually use to evolve the framework.

### Stations
| Station | Provider | Role |
|---------|----------|------|
| `plan`    | `codex` (reasoning) + `EVAL` (Codex) | Read-only — explore the codebase, produce a strict implementation plan. |
| `develop` | `script` (spawns Codex)       | In a git worktree — implement the plan, run `bun test`, commit. |
| `deploy`  | `script` (spawns Codex on conflicts) | Merge to main, push, optionally restart a systemd service. |

### Config
```yaml
concurrency: 1            # one feature at a time
timeout: 900              # 15-min idle
defaults:
  provider: codex
  model: reasoning
  max_tokens: 32768
  repair:
    enabled: false
```

### Notable
- Requires `ASSEMBLY_REPO_ROOT` pointing at the cloned repo root. Optional
  `ASSEMBLY_DASHBOARD_SERVICE` enables the post-merge systemd restart.
- `develop` is a script provider that orchestrates Codex
  inside a per-task git worktree (`/tmp/assembly-dev/<wp-id>/`). The LLM
  writes code; the script handles worktree setup, test runs, and commits.
- `repair.enabled: false` intentionally disables the Anthropic repair/nudge
  fallback for this line, so assembly-dev has no Claude/Anthropic model path.
- `plan` is read-only — no tools that can write to the source tree. That's
  the whole point: planning happens against the live codebase but cannot
  mutate it; only `develop` (in its sandboxed worktree) writes.
- Both `plan` and `develop` have `EVAL.md`. Develop's eval re-runs tests
  to verify, then can `action: retry` or `action: escalate`.

---

## Common patterns to take away

1. **Mix providers per station.** Use `script` for anything deterministic
   (filesystem, API calls with structured responses, aggregation). Use
   `claude-code` only for the parts that need judgement.
2. **Add an EVAL when the LLM output has a strict shape.** The cost of a
   haiku-level eval is tiny compared to a downstream station running on
   garbage input.
3. **Use `concurrency: 1` for stateful or memory-heavy lines.** Stations
   doing real subprocess work (worktrees, browsers, large model calls)
   stack badly under parallelism. The framework can fan out across lines
   instead of within a single line.
4. **Keep state out of git.** Per-station `queue/` directories are runtime
   state. They're git-ignored. Only `line.yaml`, `stations/`, and the
   `AGENT.md` / `EVAL.md` / script files belong in version control.
