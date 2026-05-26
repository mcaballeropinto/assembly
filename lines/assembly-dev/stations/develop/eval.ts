#!/usr/bin/env bun
/**
 * Develop station eval — re-checks quality gates against the just-produced
 * envelope and signals retry-with-feedback when any of {typecheck, lint,
 * tests} are failing.
 *
 * Contract:
 *   argv[1] — path to workpiece JSON (envelope under workpiece.stations.develop)
 *   stdout  — JSON { pass, feedback, action?, score? }
 *   exit 0  — eval completed (pass or fail is in the JSON)
 *   non-zero — eval infrastructure itself broke; runner treats as pass+warn
 *
 * Develop produces quality results in its envelope:
 *   typecheck_passed / typecheck_output
 *   lint_passed     / lint_output
 *   tests_passed    / test_output
 *
 * Eval treats those as authoritative for typecheck + lint (develop ran them
 * milliseconds ago in the worktree). For tests we ALSO re-run independently
 * — that's the original belt-and-suspenders the eval was written for, and
 * it catches "passes-in-isolation but breaks under different load/order"
 * regressions.
 *
 * On ANY failure: action:retry, feedback = concatenated outputs. The runner
 * threads feedback into the next develop attempt via _pending_eval_feedback,
 * and develop.ts puts it in the agent's user message so the agent sees
 * exactly what to fix.
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

// The worktree IS the assembly checkout — develop.ts sets worktree_path to
// /tmp/assembly-dev/<wpId> directly, not /tmp/assembly-dev/<wpId>/assembly.
// The previous "/assembly" suffix here always produced a missing-dir
// retry loop that ate max_retries silently.
if (!worktreePath || !existsSync(worktreePath)) {
  emit({
    pass: false,
    feedback: `Worktree missing at ${worktreePath ?? "(undefined)"} — develop's state is incomplete. Re-run develop to rebuild the worktree.`,
    action: "retry",
  });
}

// ── Collect quality failures from develop's envelope ───────────────
const feedbackParts: string[] = [];

if (dev.typecheck_passed === false) {
  const out = typeof dev.typecheck_output === "string" ? dev.typecheck_output : "(no output captured)";
  feedbackParts.push(`## Typecheck failed\n\n${out}`);
}

if (dev.lint_passed === false) {
  const out = typeof dev.lint_output === "string" ? dev.lint_output : "(no output captured)";
  feedbackParts.push(`## Lint failed (after auto-fix)\n\nThe \`bun run lint:fix\` step before this gate auto-fixes anything ESLint marks as fixable. The errors below remain after auto-fix — they need manual attention.\n\n${out}`);
}

// ── Check for safety gate failures from develop ────────────────────
if (dev.gate_failure && typeof dev.gate_failure === 'object') {
  const gf = dev.gate_failure as { gate?: string; details?: string };
  const gate = typeof gf.gate === 'string' ? gf.gate : 'unknown';
  const details = typeof gf.details === 'string' ? gf.details : '(no details captured)';
  feedbackParts.push(
    `## Safety gate failed: ${gate}\n\n` +
    `Previous attempt was rejected by safety gate '${gate}'.\n\n` +
    `Details:\n${details}\n\n` +
    `Fix the issue and retry. Do NOT touch the files/lines that caused the gate to fire. ` +
    `Restrict your changes to ONLY the files listed in the plan's files_to_change and files_to_create.`
  );
}

// ── Re-run tests in the worktree (belt-and-suspenders + catches order-
//    sensitivity regressions that develop's own run didn't hit). ────
// Skip test re-run when a gate failure occurred — no commit was made,
// worktree state is from the rejected attempt.
if (!dev.gate_failure) {
process.stderr.write(`[develop-eval] running bun test in ${worktreePath}\n`);
const testR = spawnSync("bun", ["test"], {
  cwd: worktreePath,
  encoding: "utf-8",
  timeout: 300_000,
});
const testOut = ((testR.stdout ?? "") + "\n" + (testR.stderr ?? "")).slice(-6000);

const failMatch = testOut.match(/(\d+)\s+fail\b/);
const errorMatch = testOut.match(/(\d+)\s+errors?\b/);
const passMatch = testOut.match(/(\d+)\s+pass\b/);
const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
const passCount = passMatch ? parseInt(passMatch[1], 10) : 0;
const testsOk = testR.status === 0 && failCount === 0 && errorCount === 0;

if (!testsOk) {
  feedbackParts.push(
    `## Tests failed in develop worktree\n\n` +
      `bun test exit=${testR.status}, ${failCount} fail, ${errorCount} errors, ${passCount} pass.\n\n` +
      `Test output (last 6k chars):\n\n${testOut}\n\n` +
      `Fix the failing tests — read the output above, identify each failing assertion, and correct either the test or the implementation. Do not skip or delete failing tests unless the plan explicitly calls for it.`
  );
}
}

if (feedbackParts.length === 0) {
  emit({
    pass: true,
    feedback: `All quality gates pass: typecheck, lint, ${passCount} tests.`,
  });
}

emit({
  pass: false,
  feedback:
    `Develop produced code that doesn't pass all quality gates. Fix each issue below, then the orchestrator will re-run develop.\n\n` +
    feedbackParts.join("\n\n---\n\n"),
  action: "retry",
});
