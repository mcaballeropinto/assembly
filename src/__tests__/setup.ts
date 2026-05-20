/**
 * Bun test preload — loaded before any test file via bunfig.toml.
 *
 * Points `ASSEMBLY_HOME` at a per-process tmp dir so test code can't pollute
 * the developer's real `~/.assembly/` (PID files, handoff state, usage
 * snapshots, etc).
 *
 * Why this is in a preload, not in individual test files: paths.ts captures
 * `ASSEMBLY_HOME` at module load. ESM `import` statements hoist before any
 * top-level code, and test-file order is non-deterministic — by the time a
 * test's `beforeEach` could mutate the env, paths.ts has often already been
 * loaded by a sibling test (orchestrator, runner, dashboard, etc) and cached.
 * The previous workaround (`delete require.cache[...]`) silently no-ops under
 * Bun's module loader.
 *
 * The pid suffix isolates concurrent `bun test` invocations from each other
 * (parallel develop+deploy worktrees both running the suite simultaneously
 * would otherwise race on the same `handoff-*.json` mtimes).
 */
import { mkdirSync } from "fs";
import { resolve } from "path";

const testHome = resolve("/tmp", `assembly-test-home-${process.pid}`);
mkdirSync(testHome, { recursive: true });
process.env.ASSEMBLY_HOME = testHome;
