#!/usr/bin/env bun
/**
 * Deterministic deploy station for assembly-dev.
 *
 * Non-zero exit = station fails. That is the point — previously this was an
 * LLM station that could return `data.merged: false` with a "done" status,
 * which let broken deploys masquerade as successful pipeline completions.
 *
 * Fails (exit 1) if:
 *   - any test in the worktree fails
 *   - the branch is missing or not ahead of main
 *   - the merge produces conflicts or errors
 *   - the merge commit is not a real merge commit
 *   - the push to origin fails or remote SHA != local SHA
 *
 * Best-effort (logs a warning, doesn't fail):
 *   - worktree cleanup
 *   - branch delete
 *   - dashboard service restart
 */
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";

const REPO = process.env.ASSEMBLY_REPO_ROOT;
if (!REPO) {
  process.stderr.write("[deploy] ASSEMBLY_REPO_ROOT must point at the cloned assembly repo root\n");
  process.exit(2);
}

function log(msg: string) {
  process.stderr.write(`[deploy] ${new Date().toISOString()} ${msg}\n`);
}

function fatal(msg: string, extra = ""): never {
  process.stderr.write(`[deploy] FATAL: ${msg}\n`);
  if (extra) process.stderr.write(extra.slice(-3000) + "\n");
  process.exit(1);
}

function emit(envelope: { summary: string; content?: string; data: Record<string, unknown> }): never {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(0);
}

// ─── Input ────────────────────────────────────────────────────────────

const workpiecePath = process.argv[2];
if (!workpiecePath || !existsSync(workpiecePath)) {
  fatal(`workpiece path missing: argv[2]=${workpiecePath}`);
}

let wp: any;
try {
  wp = JSON.parse(readFileSync(workpiecePath, "utf-8"));
} catch (e) {
  fatal(`workpiece parse failed: ${e}`);
}

const developData = wp.stations?.develop?.data;

// No-op short-circuit. Develop propagates plan's no_op flag when no work was
// done — skip the merge / push / restart pipeline entirely and emit a clean
// success envelope. The task ends in done/ instead of crashing on the missing
// branch_name / commit_sha / worktree_path that the merge path requires.
if (developData?.no_op === true) {
  const reason = typeof developData.no_op_reason === "string" ? developData.no_op_reason : "develop reported no-op";
  log(`no-op from develop: ${reason}`);
  emit({
    summary: `No-op: ${reason.slice(0, 140)}`,
    content: `Deploy skipped — develop signalled no_op.\n\nReason: ${reason}\n\nNo merge, no push, no dashboard restart.`,
    data: {
      no_op: true,
      no_op_reason: reason,
      merged: false,
      merge_commit: "",
      pushed: false,
      worktree_cleaned: true,
      dashboard_restarted: false,
      conflicts: [],
    },
  });
}

if (!developData?.branch_name || !developData?.commit_sha || !developData?.worktree_path) {
  fatal("develop.data missing required fields: branch_name, commit_sha, worktree_path");
}

const branch: string = developData.branch_name;
const commitSha: string = developData.commit_sha;
const worktreePath: string = developData.worktree_path;

log(`branch=${branch} commit=${commitSha.slice(0, 8)} worktree=${worktreePath}`);

if (!existsSync(worktreePath)) {
  fatal(`worktree missing at ${worktreePath}`);
}

// ─── 1. Run tests — any failure fails the station ─────────────────────

log("running bun test");
const testR = spawnSync("bun", ["test"], {
  cwd: worktreePath,
  encoding: "utf-8",
  timeout: 300_000,
});
const testOut = (testR.stdout ?? "") + "\n" + (testR.stderr ?? "");

if (testR.status !== 0) {
  fatal(`bun test exited ${testR.status}`, testOut);
}

// bun test can exit 0 and still have failing tests in some reporter modes.
// Parse the summary line as a belt-and-suspenders check.
const failMatch = testOut.match(/(\d+)\s+fail\b/);
const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
if (failCount > 0) {
  fatal(`${failCount} test(s) failing in worktree`, testOut);
}

const errorMatch = testOut.match(/(\d+)\s+errors?\b/);
const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
if (errorCount > 0) {
  fatal(`${errorCount} test error(s) in worktree`, testOut);
}

log(`tests pass (${failCount} fail, ${errorCount} errors)`);

// ─── 2. Sanity check the branch ───────────────────────────────────────

if (spawnSync("git", ["-C", REPO, "rev-parse", "--verify", branch]).status !== 0) {
  fatal(`branch ${branch} does not exist in ${REPO}`);
}

const aheadR = spawnSync("git", ["-C", REPO, "log", `main..${branch}`, "--oneline"], { encoding: "utf-8" });
if (!(aheadR.stdout ?? "").trim()) {
  fatal(`branch ${branch} has no commits ahead of main`);
}

if (spawnSync("git", ["-C", REPO, "merge-base", "--is-ancestor", commitSha, branch]).status !== 0) {
  fatal(`commit ${commitSha} is not on branch ${branch}`);
}

// ─── 3. Merge to main ─────────────────────────────────────────────────

log("checkout main");
const coR = spawnSync("git", ["-C", REPO, "checkout", "main"], { encoding: "utf-8" });
if (coR.status !== 0) {
  fatal("git checkout main failed", (coR.stdout ?? "") + "\n" + (coR.stderr ?? ""));
}

const problemStatement = (
  wp.stations?.plan?.data?.problem_statement ??
  wp.stations?.plan?.summary ??
  wp.task ??
  ""
)
  .toString()
  .split("\n")[0]
  .slice(0, 200);

const filesChanged = Array.isArray(developData.files_changed) ? developData.files_changed : [];
const commitMsg = [
  `feat(assembly): ${problemStatement}`,
  "",
  "Implemented via assembly-dev line.",
  `Branch: ${branch}`,
  `Files changed: ${JSON.stringify(filesChanged)}`,
].join("\n");

log(`merge ${branch} --no-ff`);
const mergeR = spawnSync(
  "git",
  ["-C", REPO, "merge", branch, "--no-ff", "-m", commitMsg],
  { encoding: "utf-8" }
);
if (mergeR.status !== 0) {
  spawnSync("git", ["-C", REPO, "merge", "--abort"]);
  fatal("git merge failed", (mergeR.stdout ?? "") + "\n" + (mergeR.stderr ?? ""));
}

const parentsR = spawnSync("git", ["-C", REPO, "rev-list", "--parents", "-n", "1", "HEAD"], { encoding: "utf-8" });
const parentsCount = (parentsR.stdout ?? "").trim().split(/\s+/).length - 1;
if (parentsCount !== 2) {
  fatal(`HEAD is not a merge commit (parents=${parentsCount})`);
}

const shaR = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" });
const mergeSha = (shaR.stdout ?? "").trim();
if (mergeSha.length !== 40) {
  fatal(`unable to capture merge SHA (got "${mergeSha}")`);
}

if (spawnSync("git", ["-C", REPO, "merge-base", "--is-ancestor", commitSha, "HEAD"]).status !== 0) {
  fatal(`develop commit ${commitSha} not in merge history of ${mergeSha}`);
}

log(`merge_commit=${mergeSha}`);

// ─── 4. Push to origin ────────────────────────────────────────────────

log("pushing to origin");
const pushR = spawnSync("git", ["-C", REPO, "push", "origin", "main"], { encoding: "utf-8" });
if (pushR.status !== 0) {
  fatal("git push origin main failed", (pushR.stdout ?? "") + "\n" + (pushR.stderr ?? ""));
}

const lsR = spawnSync("git", ["-C", REPO, "ls-remote", "origin", "refs/heads/main"], { encoding: "utf-8" });
const remoteSha = ((lsR.stdout ?? "").split(/\s+/)[0] ?? "").trim();
if (remoteSha !== mergeSha) {
  fatal(`remote main (${remoteSha}) does not match local merge (${mergeSha})`);
}

log(`pushed, remote_sha=${remoteSha}`);

// ─── 5. Clean up worktree + branch (best-effort) ──────────────────────

let worktreeCleaned = true;
const wtRmR = spawnSync("git", ["-C", REPO, "worktree", "remove", worktreePath, "--force"], { encoding: "utf-8" });
if (wtRmR.status !== 0) {
  log(`worktree remove failed (non-fatal): ${wtRmR.stderr ?? ""}`);
  worktreeCleaned = false;
}
const brDelR = spawnSync("git", ["-C", REPO, "branch", "-d", branch], { encoding: "utf-8" });
if (brDelR.status !== 0) {
  log(`branch delete failed (non-fatal): ${brDelR.stderr ?? ""}`);
  worktreeCleaned = false;
}

// ─── 6. Restart dashboard service (best-effort, opt-in via env) ───────

const dashboardService = process.env.ASSEMBLY_DASHBOARD_SERVICE;
let dashboardRestarted = false;
if (dashboardService) {
  const rcR = spawnSync("systemctl", ["restart", dashboardService], { encoding: "utf-8" });
  const activeR = spawnSync("systemctl", ["is-active", dashboardService], { encoding: "utf-8" });
  dashboardRestarted = (activeR.stdout ?? "").trim() === "active";
  if (!dashboardRestarted) {
    log(`dashboard restart failed or not active (non-fatal): rc=${rcR.status} active=${(activeR.stdout ?? "").trim()}`);
  }
} else {
  log("ASSEMBLY_DASHBOARD_SERVICE not set; skipping dashboard restart");
}

// ─── 7. Emit envelope ─────────────────────────────────────────────────

emit({
  summary: `Merged ${branch} to main at ${mergeSha.slice(0, 8)}`,
  content: [
    `Merged ${branch} to main at ${mergeSha}.`,
    `Pushed to origin; remote_sha=${remoteSha}.`,
    `worktree_cleaned=${worktreeCleaned}`,
    `dashboard_restarted=${dashboardRestarted}`,
  ].join("\n"),
  data: {
    merged: true,
    merge_commit: mergeSha,
    pushed: true,
    worktree_cleaned: worktreeCleaned,
    dashboard_restarted: dashboardRestarted,
    conflicts: [],
  },
});
