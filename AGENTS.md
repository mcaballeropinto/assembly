# AGENTS.md - Assembly Contributor Rules

This file is for AI coding agents working in this repository. Read it before
changing files, and treat it as the local contract for safe Assembly work.

## Git Hygiene

- Start by checking `git status --short`.
- Do not leave `/root/assembly` dirty. Finish with a clean worktree unless the
  user explicitly asks for an uncommitted patch.
- Do not revert or overwrite unrelated user changes.
- Commit and push Assembly repo fixes that belong on `main`; report the branch
  and commit SHA.
- Keep live deploys git-backed. Do not let `/srv/assembly` drift from a commit
  with one-off source edits. If an emergency hotpatch is unavoidable, backport it
  to `/root/assembly`, commit, push, then sync live from git.

## Generated Output

- Never commit `web/dist/` or other generated bundles. `web/dist/` is ignored on
  purpose.
- Build dashboard assets with `bun run build:web` from the repo root whenever
  dashboard source changes, before packaging/deploying, or when a source
  checkout is missing the bundle.
- If `dist` or other generated files appear in `git status`, stop and check
  `.gitignore` / tracking before committing.

## Tests

- Assume `bun test` runs files in parallel. Avoid test changes that mutate
  process-wide state.
- Prefer explicit options, dependency injection, temp directories, and local
  fixtures over global environment variables.
- If a test must set `process.env`, capture the original value and restore or
  delete it in `afterEach`.
- Do not monkeypatch `globalThis.fetch`, timers, filesystem APIs, or shared
  modules unless the patch is scoped and restored in `afterEach`.
- Avoid fixed sleeps for startup or discovery. Expose a readiness promise,
  await the server state, or poll for the specific condition under test.
- For usage-gate bypasses in tests, use `ASSEMBLY_DISABLE_USAGE_GATE=1` rather
  than faking credentials or intercepting network calls.
- Run a targeted test first, then `bun run typecheck`, then full `bun test`
  when touching shared runtime, dashboard API, queues, or test infrastructure.

## Dashboard And Runtime

- Dashboard source lives in `web/`; the Bun dashboard server serves the built
  Vite output from ignored `web/dist/`.
- Do not start, stop, or restart production services from a develop/test task.
  The deploy path owns daemon reloads, dashboard restarts, and live builds.
- Dashboard tests should pass `lineDirs` and `webDistDir` explicitly to
  `startGlobalDashboard()` instead of relying on global env.

## Documentation

- When a mistake exposes a repeatable rule, update docs in the same commit as
  the fix.
- Use `docs/ai-agent-guidelines.md` for AI/contributor behavior, and link more
  specific operational details from the relevant topic doc.
