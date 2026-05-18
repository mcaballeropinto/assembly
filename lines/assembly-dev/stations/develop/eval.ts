#!/usr/bin/env bun
/**
 * Develop station eval — runs tests in the worktree and reports pass/fail.
 *
 * Called by runner.ts / section-worker.ts when `eval.provider: script` is
 * configured on the station. The contract:
 *   argv[1] — path to a workpiece JSON that includes the just-produced
 *             envelope under workpiece.stations.develop (as if it had been
 *             written normally).
 *   stdout  — one-line JSON matching EvalResult: { pass, feedback, action?, score? }
 *   exit 0  — envelope written (eval completed — pass or fail is in the JSON)
 *   non-zero — eval infrastructure itself broke; runner treats as pass+warn
 *
 * Philosophy: develop itself already runs `bun test` and hard-fails when tests
 * don't pass. This eval is a belt-and-suspenders second check — it runs tests
 * again from the merge target's perspective and catches regressions that
 * passed-in-isolation but conflict with main. On test failure it sets
 * action=retry so the runner re-invokes develop with the failure as feedback.
 */
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";

function emit(result: { pass: boolean; feedback: string; action?: string; score?: number }): never {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

const workpiecePath = process.argv[2];
if (!workpiecePath || !existsSync(workpiecePath)) {
  process.stderr.write(`[develop-eval] workpiece path missing: argv[1]=${workpiecePath}\n`);
  process.exit(1);
}

let wp: any;
try {
  wp = JSON.parse(readFileSync(workpiecePath, "utf-8"));
} catch (e) {
  process.stderr.write(`[develop-eval] workpiece parse failed: ${e}\n`);
  process.exit(1);
}

const dev = wp.stations?.develop?.data ?? {};
const worktreePath: string | undefined = dev.worktree_path;
const wtAssembly = worktreePath ? `${worktreePath}/assembly` : undefined;

if (!wtAssembly || !existsSync(wtAssembly)) {
  emit({
    pass: false,
    feedback: `Worktree missing at ${wtAssembly ?? "(undefined)"} — develop's state is incomplete. Re-run develop to rebuild the worktree.`,
    action: "retry",
  });
}

process.stderr.write(`[develop-eval] running bun test in ${wtAssembly}\n`);
const testR = spawnSync("bun", ["test"], {
  cwd: wtAssembly,
  encoding: "utf-8",
  timeout: 300_000,
});
const testOut = ((testR.stdout ?? "") + "\n" + (testR.stderr ?? "")).slice(-6000);

// bun test can exit 0 yet still have failures reported in some modes; check
// both the exit code and the fail/error summary markers.
const failMatch = testOut.match(/(\d+)\s+fail\b/);
const errorMatch = testOut.match(/(\d+)\s+errors?\b/);
const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
const passMatch = testOut.match(/(\d+)\s+pass\b/);
const passCount = passMatch ? parseInt(passMatch[1], 10) : 0;
const exitOk = testR.status === 0;

if (exitOk && failCount === 0 && errorCount === 0) {
  emit({
    pass: true,
    feedback: `Tests pass in worktree: ${passCount} pass, 0 fail, 0 errors`,
  });
}

// Tests failed — hand back the tail of the test output so develop's inner
// agent can see exactly what to fix on retry.
emit({
  pass: false,
  feedback:
    `Tests failed in the develop worktree (bun test exit=${testR.status}, ${failCount} fail, ${errorCount} errors, ${passCount} pass).\n\n` +
    `Test output (last 6k chars):\n\n${testOut}\n\n` +
    `Fix the failing tests — read the output above carefully, identify each failing assertion, and correct either the test or the implementation. Do not skip or delete failing tests unless the plan explicitly calls for it.`,
  action: "retry",
});
