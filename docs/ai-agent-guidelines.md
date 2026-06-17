# AI Agent Guidelines

This page captures operating rules for AI agents and automation changing
Assembly. It exists because the repo is both an application and the factory that
edits itself; small process mistakes can become runtime drift, flaky tests, or
generated bundles in git.

For the short executable version, see [`../AGENTS.md`](../AGENTS.md).

---

## Start With The State On Disk

Before editing, inspect the current repo state:

```bash
git status --short
```

Work with existing user changes; do not revert them unless explicitly asked.
When your Assembly change belongs in the repo, commit and push it. Ending with
a dirty `/root/assembly` checkout makes the next automation pass ambiguous and
has already caused avoidable deploy confusion.

If you touch production under `/srv/assembly`, keep it tied to a git commit.
The preferred flow is:

1. Fix `/root/assembly`.
2. Test.
3. Commit and push.
4. Sync `/srv/assembly` from that commit.
5. Build generated artifacts and restart/reload through the deploy path.

One-off live edits are emergency-only. Backport them immediately so live does
not become the only copy of the truth.

---

## Do Not Commit Generated Bundles

`web/dist/` is generated output from Vite and is intentionally ignored. Do not
commit hashed dashboard bundles. Rebuild them from source:

```bash
bun run build:web
```

Build when:

- `web/dist/` is missing in a source checkout.
- Dashboard source under `web/` changed.
- A deploy or package step needs the built SPA.
- The dashboard is serving stale assets after a checkout or merge.

If generated output shows up in `git status`, verify whether it is ignored or
still tracked before staging anything.

---

## Design Tests For Parallel Execution

Bun can run test files in parallel, so tests must not assume they own global
process state.

Prefer:

- Explicit constructor/function options.
- Isolated temp directories.
- Local fixtures.
- Dependency injection for paths and services.
- Condition-based waits.

Avoid:

- Setting `process.env` without restoring it.
- Monkeypatching `globalThis.fetch` or other shared globals across tests.
- Using fake credentials to trick runtime gates.
- Sleeping a fixed number of milliseconds and hoping startup finished.

If environment variables are unavoidable, use this pattern:

```ts
const originalValue = process.env.MY_ENV;

beforeEach(() => {
  process.env.MY_ENV = "test-value";
});

afterEach(() => {
  if (originalValue === undefined) delete process.env.MY_ENV;
  else process.env.MY_ENV = originalValue;
});
```

For Assembly usage-gate tests, prefer `ASSEMBLY_DISABLE_USAGE_GATE=1` over
mocking network calls or creating fake Claude credentials.

For dashboard API/static tests, pass explicit options into
`startGlobalDashboard()`:

```ts
const server = startGlobalDashboard({
  port: 0,
  lineDirs: [testLinesDir],
  webDistDir: testWebDistDir,
});
```

That keeps each test hermetic and avoids racing over
`ASSEMBLY_LINE_DIRS` / `ASSEMBLY_DASHBOARD_WEB_DIST_DIR`.

---

## Wait For Readiness, Not Time

Fixed sleeps are a common source of flakes. When code starts background work,
prefer one of these:

- Await the initialization promise before handling requests.
- Return an explicit readiness promise from the API.
- Poll for the specific state the test needs.
- Trigger the operation directly through a public function in the test.

The dashboard server now waits for initial line discovery before serving API
requests. Follow that pattern for future startup work.

---

## Verification Ladder

Use the narrowest useful check first, then broaden based on blast radius.

For docs-only changes:

```bash
git diff --check
```

For prompt/config/docs that affect `assembly-dev` behavior:

```bash
bun run typecheck
```

For runtime, queue, dashboard API, or test-infrastructure changes:

```bash
bun test <targeted files>
bun run typecheck
bun test
```

If the full suite fails, separate real failures from pre-existing flakes by
rerunning the failing file alone and reading the failure. Do not label a failure
"flaky" until you can explain the shared state, timing, filesystem, or external
dependency that makes it nondeterministic.

---

## Document The Rule With The Fix

When a bug reveals a reusable operating rule, update the relevant documentation
in the same change:

- `AGENTS.md` for AI/contributor behavior.
- `docs/dashboard.md` for dashboard build, serving, and deploy behavior.
- `docs/reliability.md` for retries, timeouts, and recovery behavior.
- `docs/development-guide.md` for line-authoring pitfalls.
- Station `AGENT.md` / `EVAL.md` files when the rule must affect future
  `assembly-dev` workpieces directly.

The goal is not to create paperwork. The goal is to make the next agent less
likely to repeat a known failure mode.
