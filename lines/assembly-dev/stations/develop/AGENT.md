---
reads: [task, input, plan]
provider: script
script: develop.ts
guardrails:
  output:
    required: [summary, data]
    schema:
      data:
        branch_name: string
        worktree_path: string
        files_changed: array
        files_created: array
        tests_passed: boolean
        test_output: string
        commit_sha: string
---

# Develop Station — Assembly Dev Line (scripted)

This station is a **script provider**. The implementation lives in
`develop.ts` (same directory). This markdown body is documentation only —
the section-worker runs `bun run develop.ts <workpiece.json>` and parses
its stdout as the envelope.

## Why a script?

Previously this station was a pure LLM agent. The agent resolved plan file
paths like `src/orchestrator.ts` against `${ASSEMBLY_REPO_ROOT}/` (the
main worktree) and edited those files directly — so the branch worktree at
`/tmp/assembly-dev/…` ended up with no real changes, and the deploy station
silently hallucinated a merge it never performed.

The scripted flow makes the mechanical parts deterministic:
- Worktree setup off `main` (or re-attach if branch exists from a retry).
- Spawns the coding LLM with `cwd = worktree/assembly` — so relative and
  default paths naturally land in the worktree.
- Tight system prompt that forbids the agent from touching git state or
  `${ASSEMBLY_REPO_ROOT}/`.
- Asserts `git status` shows real changes before attempting a commit.
- Runs `bun test`, captures output.
- Creates the commit and captures the real SHA via `git rev-parse HEAD`.
- Guarantees HEAD is ahead of `main` before returning success.

If any check fails, the script emits a `Failed: …` envelope with enough
context for the retry/repair path to do something useful.

## Config

- `ASSEMBLY_DEV_MODEL` env var overrides the LLM model (default: `sonnet`).
- `REPO` and paths are hard-coded to `${ASSEMBLY_REPO_ROOT}` and
  `/tmp/assembly-dev/{id}` — update `develop.ts` if those move.

## Output contract

Envelope emitted on stdout, exactly one line, consumed by section-worker:

```json
{
  "summary": "one-line",
  "content": "full changelog markdown",
  "data": {
    "branch_name": "assembly-dev/…",
    "worktree_path": "/tmp/assembly-dev/<id>",
    "files_changed": ["src/foo.ts", …],
    "files_created": ["src/bar.ts", …],
    "tests_passed": true,
    "test_output": "<last 4000 chars of bun test output>",
    "commit_sha": "<40-char hex>"
  }
}
```

`commit_sha` is required by the deploy station — deploy will refuse to
merge if it is empty or not a real SHA.
