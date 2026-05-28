---
reads: [task, plan.data, develop.data]
description: "Merges the develop branch, restarts services, and verifies the deployment."
provider: script
script: deploy.ts
guardrails:
  output:
    required: [summary, data]
    schema:
      data:
        merged: boolean
        merge_commit: string
        pushed: boolean
        worktree_cleaned: boolean
        dashboard_restarted: boolean
        daemon_reloaded: boolean
---

> **Note**: This station is now a deterministic script (`deploy.ts`), not an LLM agent.
> The prose below is kept for humans; the script is the source of truth and enforces
> that ANY test failure or merge/push failure fails the station with a non-zero exit.

# Deploy Station — Assembly Dev Line

You are deploying a verified implementation to the Assembly framework.
The deployment target is the git repo at `${ASSEMBLY_REPO_ROOT}/`. The default branch is **`main`** (not `master` — do not reference `master` anywhere).

> **Operator-specific:** the orchestrator and dashboard services in the snippets below (`assembly.service`, `assembly-dashboard.service`) are example systemd unit names. Adjust to your environment. The script-based `deploy.ts` reads `ASSEMBLY_DASHBOARD_SERVICE` and skips the restart if unset.

> **Line-root sync:** If the daemon discovers lines from a directory other than `ASSEMBLY_LIVE_ROOT` (check `~/.assembly/config.yaml` `line_dirs`), set `ASSEMBLY_LINE_ROOT` in the systemd unit to that path (e.g., `Environment=ASSEMBLY_LINE_ROOT=/root/assembly`). Deploy will `git reset --hard origin/${BASE}` on that path after the LIVE reset, so station scripts match the deployed code. Without this, deploys update `/srv/assembly` but the daemon keeps running old scripts from the line-discovery directory.

## Prerequisites

The develop station has already:
- Made all changes in a git worktree at `{develop.data.worktree_path}`.
- Committed on branch `{develop.data.branch_name}` with SHA `{develop.data.commit_sha}`.
- All tests pass (verified by the eval).

## CRITICAL: Deterministic Deploy

The commands below MUST be executed verbatim. Do NOT summarise shell output with arrows (`→`). Paste real stdout/stderr into your `content`. If any step exits non-zero, stop immediately and fail the station with `merged: false` and the actual error.

Capture the merge SHA from `git rev-parse` — never invent it.

## Process

### 1. Sanity Check the Branch

```bash
cd ${ASSEMBLY_REPO_ROOT}
# Verify the branch exists and has commits ahead of main
git rev-parse --verify {develop.data.branch_name}
AHEAD=$(git log main..{develop.data.branch_name} --oneline | wc -l)
echo "ahead_of_main=$AHEAD"
test "$AHEAD" -gt 0 || { echo "FATAL: branch has no commits ahead of main"; exit 1; }
# Assert the develop commit_sha is actually on the branch
git merge-base --is-ancestor {develop.data.commit_sha} {develop.data.branch_name} || { echo "FATAL: develop.commit_sha not on branch"; exit 1; }
```

### 2. Merge to `main`

```bash
cd ${ASSEMBLY_REPO_ROOT}
git checkout main
git merge {develop.data.branch_name} --no-ff -m "feat(assembly): {plan.data.problem_statement}

Implemented via assembly-dev line.
Branch: {develop.data.branch_name}
Files changed: {develop.data.files_changed}
"
MERGE_SHA=$(git rev-parse HEAD)
echo "merge_commit=$MERGE_SHA"
# Assert merge actually produced a merge commit and its second parent is the branch
PARENTS=$(git rev-list --parents -n 1 HEAD | awk '{print NF-1}')
test "$PARENTS" = "2" || { echo "FATAL: HEAD is not a merge commit"; exit 1; }
git merge-base --is-ancestor {develop.data.commit_sha} HEAD || { echo "FATAL: develop commit not in merge history"; exit 1; }
```

If the merge has conflicts, **do NOT force resolve.** Run `git merge --abort`, report the conflicting files, and set `merged: false`. Do not proceed further.

### 3. Push to `origin`

```bash
cd ${ASSEMBLY_REPO_ROOT}
git push origin main
# Confirm the remote accepted it
REMOTE_SHA=$(git ls-remote origin refs/heads/main | awk '{print $1}')
test "$REMOTE_SHA" = "$MERGE_SHA" || { echo "FATAL: remote main ($REMOTE_SHA) does not match local merge ($MERGE_SHA)"; exit 1; }
```

If push fails (network, protected branch, etc.), set `pushed: false` and include the actual error — the merge is still local and recoverable.

### 4. Clean Up Worktree and Branch

```bash
git -C ${ASSEMBLY_REPO_ROOT} worktree remove {develop.data.worktree_path} --force
git -C ${ASSEMBLY_REPO_ROOT} branch -d {develop.data.branch_name}
# Both commands must succeed. A failed worktree remove or branch delete should
# set worktree_cleaned: false but does NOT fail the station — the merge is done.
```

### 5. Reload Live Services With New Build

```bash
# Dashboard: clean restart picks up the new bundle on next ExecStart.
systemctl restart assembly-dashboard 2>/dev/null || true
sleep 1
systemctl is-active assembly-dashboard || echo "assembly-dashboard not active"
```

**Daemon reload:** `assembly daemon reload` now works under systemd — the
successor is spawned via `systemd-run --scope` into a transient scope outside
the parent service's cgroup. After reload, the successor runs independently;
run `systemctl restart assembly` to bring the daemon back under the service
unit for future `systemctl stop` commands. For deploy, prefer `systemctl
restart assembly` over `daemon reload` — it's simpler and puts the new daemon
under the service unit immediately.

### 6. Final Verification

```bash
cd ${ASSEMBLY_REPO_ROOT}
# MERGE_SHA must be on main
git merge-base --is-ancestor "$MERGE_SHA" main || { echo "FATAL: merge commit not on main"; exit 1; }
git log --oneline -3
cd ${ASSEMBLY_REPO_ROOT} && bun run src/cli.ts validate lines/assembly-dev
```

## Output

**Your entire final assistant response MUST be a single JSON object** — no preamble, no code fences, no trailing text. Tool output does not count.

Return JSON with:

- `summary`: One-line deployment description (e.g., `"Merged assembly-dev/add-parallel to main at <SHA-prefix>"`).
- `content`: Verbatim shell output of every step, including the actual `MERGE_SHA` and `REMOTE_SHA` values. No arrow-summaries.
- `data`:
  - `merged`: Boolean — was the merge successful and the merge-commit invariants verified?
  - `merge_commit`: The full 40-char SHA of the merge commit. MUST be a real SHA. Empty string if `merged: false`.
  - `pushed`: Boolean — did `git push origin main` succeed and the remote match the local SHA?
  - `worktree_cleaned`: Boolean — worktree removed AND branch deleted.
  - `dashboard_restarted`: Boolean — is `assembly-dashboard.service` now active?
  - `daemon_reloaded`: Boolean — did `assembly daemon reload` complete (successor adopted workers and took the PID file)?
  - `conflicts`: Array of conflicting files if the merge failed, empty array otherwise.
