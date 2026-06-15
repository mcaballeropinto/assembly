# Development Guide

How to build a new line, test it, and avoid the pitfalls already mapped from running this thing in production.

---

## Building a new line from scratch

### 1. Sketch the pipeline on paper

What does the input look like? What stations does it pass through? What does each station read and write? Write this down before you create any folders — the folder structure is the consequence, not the design.

Aim for **2–5 stations**. Long pipelines are harder to debug. If you're tempted to write a 10-station line, consider splitting it into multiple lines connected via `on_complete`.

### 2. Create the directory layout

```
lines/my-line/
  line.yaml
  stations/
    step1/
      AGENT.md
    step2/
      AGENT.md
```

If the line goes in `~/.assembly/lines/` it'll be discovered by the daemon and any user's CLI. If it goes in a project-local `<repo>/lines/`, run the daemon from that directory or set `ASSEMBLY_LINE_DIRS`.

### 3. Write `line.yaml`

Start minimal. You can add `retry_policy`, `concurrency`, `on_complete` later.

```yaml
name: my-line
description: What this pipeline does
sequence: [step1, step2]
defaults:
  provider: claude-code
  model: sonnet
  max_tokens: 16384
```

### 4. Write each `AGENT.md`

Body is the system prompt. Be specific about what to read, what to produce, and what the envelope should contain.

```markdown
---
reads: [task, input]
guardrails:
  output:
    required: [summary, data.score]
    schema:
      data.score: { type: number, minimum: 0, maximum: 10 }
---

# Step 1 — Score the input

Given the task, produce a score from 0–10 with reasoning.

## Output

Return JSON with:
- summary: one-line outcome
- content: full reasoning in markdown
- data: { score: number, rationale: string }
```

### 5. Validate

```bash
assembly validate my-line
```

Catches missing fields, broken YAML, AGENT.md frontmatter mistakes.

### 6. Dry-run

```bash
assembly dry my-line --task "Test task"
```

Confirms the execution plan without calling models.

### 7. Run for real

```bash
assembly run my-line --task "Test task" --input '{"k": "v"}'
```

Prints the workpiece path. Inspect:

```bash
assembly inspect ~/.assembly/runs/run_<id>-my-line/workpiece.json
```

### 8. Iterate on prompts

```bash
# After editing stations/step1/AGENT.md
assembly run my-line --resume ~/.assembly/runs/run_<id>-my-line/workpiece.json --only step1
```

`--only` re-runs just one station against the existing workpiece, so you don't pay to re-run earlier stations.

### 9. Add retries, eval, and memory as needed

- **EVAL.md** when the station's quality varies and a critic can catch it.
- **memory/MEMORY.md** when learnings accumulate run over run.
- **Custom `retry_policy`** when one failure class dominates (e.g., a flaky provider).
- **`max_wall_clock`** on any station that calls the web — agents drift.

### 10. Test in daemon mode

```bash
assembly enqueue my-line --task "..."
# Watch on dashboard
```

If `--hold`-ing before release feels safer:

```bash
assembly enqueue my-line --task "..." --hold
assembly held my-line
assembly release my-line --all
```

---

## Common pitfalls

Hard-won lessons from running real lines. Each item links the underlying behavior in the code.

### Scratch leakage

**Symptom:** Files named `FANOUT-*-RESULT.json`, `FANOUT-*-SUMMARY.md`, etc. appear at the top of `lines/` or inside station directories.

**Cause:** Pre-2026-04 worker stations wrote relative-path scratch files. The current behavior is that every worker `cwd`s into `$TMPDIR/assembly-scratch-<wpId>-<basename>` so naive writes go to `/tmp`, not the repo. But: if you write AGENT.md prose that tells the agent "save the result to FANOUT-X.json" — and the agent obeys with absolute path — the producer-allowlist will quarantine it. Both layers fail open.

**Fix:** Don't reference filenames in AGENT.md prompts unless you mean it. Agents echo back what you tell them.

Reference: [`runtime.md`](./runtime.md#per-worker-isolation), [`queues-and-flow.md`](./queues-and-flow.md#producer-allowlist).

### Inbox fabrication

**Symptom:** Downstream line's `queues/inbox/` accumulates JSON files whose `task` doesn't match anything the upstream actually saw.

**Cause:** When an agent's fetch fails (network, auth, rate limit), it may "hallucinate" data and write fake JSON to what it thinks is the next inbox. This has been observed in practice: a fetch agent's WebFetch failed, and rather than report empty results, the agent fabricated fanout files and wrote them directly into a downstream station's `queue/inbox/`.

**Fix:**
- The producer-allowlist (`.emitted.jsonl`) is the primary defense — only the orchestrator's authorized writers (CLI, trigger, fanout, release) are accepted.
- Belt-and-suspenders: harden the upstream AGENT.md prose to require explicit `fetch_failed: true` envelopes when fetch fails. Forbid producing listing arrays from training data.
- Schema-validate the upstream output via guardrails so empty/null arrays propagate cleanly rather than triggering fanout.

### Recursive `assembly run` from inside a `claude-code` station

**Symptom:** Spawned worker recursively spawns more workers; the box runs out of memory.

**Cause:** When a `claude-code` station has Bash access and the AGENT.md prompt contains words like "smoke test", "migration", or anything that an agent interprets as "run the full pipeline to confirm", the agent will literally invoke `bun src/cli.ts run …` — which spawns another worker, which has Bash, which does the same.

**Fix:** Never use trigger words like "smoke", "migration", or "test the line" in `--task` for stations that have Bash. Use neutral language like "verify the JSON output is correct" or "confirm the envelope shape".


### Concurrency-1 inbox flooding

**Symptom:** A line with `concurrency: 1` is enqueued with 50 tasks at once. The inbox processes them serially as expected, but you wanted to inspect the inputs first.

**Fix:** Use `--hold` to stage them. Release one at a time or in batches. On concurrency-1 lines the inbox auto-drains as soon as the worker frees, so the held area is the right staging place.


### Memory-constrained box

**Symptom:** Stacking concurrency > 1 across sibling lines causes OOMs.

**Fix:** Pin memory-heavy lines (those with long-running LLM stations or headless browsers) to `concurrency: 1`. Push parallelism to cheap downstream lines (network fetches, deterministic scripts) where workers are light. Tune to the actual box.

---

## Testing checklist before deploying a line

- [ ] `assembly validate <line>` passes.
- [ ] `assembly dry <line> --task "..."` shows the expected plan.
- [ ] One successful `assembly run` end-to-end on a representative task.
- [ ] Every station's envelope passes its guardrails on the happy path.
- [ ] If EVAL.md is configured: at least one run where eval fails and retries succeed.
- [ ] `max_wall_clock` is set on any station that touches the web.
- [ ] `on_success` / `on_failure` hooks work (Discord post or whatever your sink is).
- [ ] If `on_complete` is set: the downstream line picks up the emitted task and processes it.
- [ ] Cost of one run is acceptable (`assembly inspect` → `totals.cost_usd`).

---

## Debugging a stuck or failing run

1. **Find the workpiece.** `assembly inspect <workpiece.json>` — look at the per-station status.
2. **Read the sidecar.** `<wp>.stderr.log` and `<wp>.session.jsonl` are next to the workpiece in whatever queue it's stuck in.
3. **Replay the prompt.** The session log has every turn. You can paste the system + user message into the Anthropic console to reproduce.
4. **Check `.retry.json`.** If it exists, the workpiece is in backoff. The `backoff_until` timestamp tells you when it'll retry.
5. **Dashboard task events.** `queues/task-events/<wpId>/<station>.events.jsonl` is per-tool-use granularity for `claude-code` stations.
6. **The activity log.** `queues/activity.jsonl` gives you line-level events — when the workpiece was claimed, retried, fanned out, etc.
7. **Daemon process state.** `assembly daemon status`; if a worker is stuck, `ps aux | grep section-worker`.

---

### Working on the dashboard

For dashboard frontend work, run the Bun dashboard server and Vite dev server side by side:

```bash
assembly dashboard --port 4111
bun run dashboard:web
```

The React dev server proxies `/api` to the Bun dashboard server, so frontend requests hit the same filesystem-backed API used by the shipped dashboard.

Placement rules:

- New panels and dashboard-specific components go under `web/src/components/...`, grouped by domain.
- Route composition belongs under `web/src/routes` or the existing router structure; keep route files focused on composition.
- API client and query helpers belong under `web/src/lib`.
- Shared wire types come from `src/dashboard-api.ts`.

When vendoring shadcn blocks, copy the source into `web/src/components`, normalize imports to local `@/components/ui/*` and `@/lib/utils`, and record provenance in comments or `web/PORT-NOTES.md` when that helps future updates.

Spacing, padding, radius, typography, and component choices come from [`DESIGN.md#dashboard`](../DESIGN.md#dashboard). Do not add new CSS files or per-component spacing overrides unless `DESIGN.md` is updated first.

---

## When to add a new feature to Assembly itself

Use the `assembly-dev` meta-line. It's literally what it's for:

```bash
assembly enqueue assembly-dev --task "Add support for X" --input '{"context": "..."}'
```

The `plan` station produces a structured implementation plan; `develop` does the work in a worktree with tests/screenshots gated by EVAL.md; `deploy` merges and restarts.

Alternative: just edit `src/` and rebuild. The `develop` station does the same thing — it's automation, not a different code path.
