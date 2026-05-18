---
provider: script
script: eval.ts
on_fail: retry
max_retries: 4
---

# Develop Eval — Independent Test Run

Script-based eval. `eval.ts` re-runs `bun test` in develop's worktree and
returns `{pass, feedback, action}`. On test failure it sets `action: retry`,
which makes the runner invoke develop again with the test output as feedback
threaded through the workpiece's `_pending_eval_feedback` field.

The prompt body below is retained for reference only — scripts ignore it.
If you need a richer LLM review (plan coverage, acceptance criteria,
backward-compat checks), wire a second eval station downstream rather than
reviving the LLM path here.

---

## Previous LLM Eval (reference only — not executed)

You are evaluating a development implementation for the Assembly framework.
You have access to the filesystem to verify changes directly.

## Evaluation Process

### 1. Verify Worktree Exists and Has Commits

```bash
# Check the worktree exists
ls -la {develop.data.worktree_path}

# Check the branch has commits
git -C {develop.data.worktree_path} log --oneline -5
```

If the worktree doesn't exist or has no commits, **fail immediately**.

### 2. Verify Tests Pass

Run the tests yourself — don't trust the agent's report:

```bash
cd {develop.data.worktree_path} && bun test 2>&1
```

If tests fail, include the full error output in your feedback.

### 3. Verify All Planned Files Were Changed

Cross-reference `plan.data.files_to_change` and `plan.data.files_to_create` against `develop.data.files_changed` and `develop.data.files_created`.

Check the git diff to see actual changes:
```bash
git -C {develop.data.worktree_path} diff main --stat
```

Flag any planned files that weren't touched, or unexpected files that were changed.

### 4. Verify Implementation Matches Plan

For each step in `plan.data.implementation_steps`:
- Read the relevant files in the worktree
- Confirm the described change was actually made
- Check that it matches the plan's `details`, not just a superficial change

### 5. Verify Backward Compatibility

Validate existing lines still work:
```bash
cd {develop.data.worktree_path} && bun run src/cli.ts validate lines/assembly-dev 2>&1
cd {develop.data.worktree_path} && bun run src/cli.ts validate lines/hello-world 2>&1
cd {develop.data.worktree_path} && bun run src/cli.ts validate lines/repo-health-digest 2>&1
```

### 6. Verify Dashboard (If Affected)

If `plan.data.dashboard_affected` is true:
1. Start the dashboard from the worktree
2. Take a screenshot
3. Compare against the plan's acceptance criteria
4. Check for visual regressions (broken layout, missing elements, JS errors)

```bash
cd {develop.data.worktree_path}
timeout 10 bun run src/cli.ts dashboard --port 4198 &
sleep 4
# Screenshot
chromium --headless --screenshot=/tmp/eval-dashboard-screenshot.png --window-size=1280,900 http://localhost:4198 2>/dev/null || true
kill %1 2>/dev/null || true
```

### 7. Check Acceptance Criteria

Walk through each item in `plan.data.acceptance_criteria` and verify it's met.
Be specific — "tests pass" isn't enough if the criteria says "parallel stations execute concurrently."

## Scoring

Score each area 0-20 (total out of 100). Pass threshold: **80**.

1. **Tests pass** (0-20): All tests green = 20. Any failure = 0.
2. **Plan coverage** (0-20): All planned changes implemented = 20. Deduct 5 per missing change.
3. **Implementation quality** (0-20): Changes match plan details, no shortcuts or stubs.
4. **Backward compatibility** (0-20): Existing lines validate. No regressions.
5. **Acceptance criteria** (0-20): Each criterion met = equal share of 20. Unmet = 0 for that share.

## Action Decision

After scoring, decide the next action:
- Set `"action": "retry"` if issues are fixable by the develop station (test failures, missing file changes, incomplete implementation, minor bugs).
- Set `"action": "escalate"` if issues require human judgment (fundamental architectural mismatch, impossible requirements, persistent failures after multiple retries with same root cause).

## Output

Return JSON:
```json
{
  "pass": true/false,
  "score": 0-100,
  "feedback": "Detailed feedback. If failing, list EXACTLY what to fix: file path, line, what's wrong, what it should be. The develop station will retry with this feedback — make it actionable.",
  "action": "retry" or "escalate" (optional — use when pass is false)
}
```

**Critical:** Your feedback is the develop station's only signal for what to fix on retry.
Be extremely specific. "Tests fail" is useless. "Test in runner.test.ts line 42 fails because `runStation` now expects 3 args but the test passes 2 — add the new `retryCount` arg" is useful.
