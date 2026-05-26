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
 *   - the branch is missing or not ahead of BASE (ASSEMBLY_DEPLOY_BRANCH)
 *   - the merge produces conflicts or errors
 *   - the merge commit is not a real merge commit
 *   - the push to origin fails or remote SHA != local SHA
 *   - the live worktree (REPO) can't be fast-forwarded to origin/BASE
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

// Branch deploy merges into and pushes. REPO is the LIVE worktree on this
// branch (services restart from here). Default keeps the pre-2026-05-26
// single-clone behavior; assembly's setup overrides with ASSEMBLY_DEPLOY_BRANCH
// (e.g. "production") when the canonical edit checkout lives on a different
// branch and the deploy worktree is split out.
const BASE = process.env.ASSEMBLY_DEPLOY_BRANCH ?? "main";

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
      daemon_reloaded: false,
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

const aheadR = spawnSync("git", ["-C", REPO, "log", `${BASE}..${branch}`, "--oneline"], { encoding: "utf-8" });
if (!(aheadR.stdout ?? "").trim()) {
  fatal(`branch ${branch} has no commits ahead of ${BASE}`);
}

if (spawnSync("git", ["-C", REPO, "merge-base", "--is-ancestor", commitSha, branch]).status !== 0) {
  fatal(`commit ${commitSha} is not on branch ${branch}`);
}

// ─── 2b. Safety re-check on the branch (defense in depth) ─────────────
//
// develop ran the gates before commit, but we re-check at the deploy
// boundary so a develop bypass / future-disabled gate / direct deploy
// invocation still can't push violations to origin/${BASE}.
//
// We scan the COMMIT RANGE ${BASE}..<branch> (just the new work) rather
// than the entire branch, so noise from older history isn't flagged.

log("safety re-check on branch commits");

// Files changed by the branch (relative to BASE).
const branchFilesR = spawnSync(
  "git",
  ["-C", REPO, "diff", "--name-only", `${BASE}..${branch}`],
  { encoding: "utf-8" }
);
const branchFiles = ((branchFilesR.stdout ?? "").trim().split("\n")).filter((s) => s.length > 0);

// Full diff content for regex scanning.
const branchDiffR = spawnSync(
  "git",
  ["-C", REPO, "diff", "--no-color", `${BASE}..${branch}`],
  { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
);
const branchDiff = branchDiffR.stdout ?? "";

// Path blocklist (same patterns as develop.ts).
const BLOCKED_PATH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.env(\.|$)/, reason: ".env files (secrets)" },
  { re: /(^|\/)\.secrets(\.|$)/, reason: ".secrets files" },
  { re: /\.(pem|key|p12|pfx|crt|cer|jks)$/i, reason: "key/cert files" },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/, reason: "SSH private keys" },
  { re: /(^|\/)\.ssh(\/|$)/, reason: ".ssh directory" },
  { re: /(^|\/)\.aws(\/|$)/, reason: ".aws directory (credentials)" },
  { re: /(^|\/)\.gnupg(\/|$)/, reason: ".gnupg directory" },
  { re: /(^|\/)\.assembly(\/|$)/, reason: "~/.assembly runtime state" },
  { re: /(^|\/)\.claude(\/|$)/, reason: "~/.claude config" },
  { re: /^lines\/[^/]+\/queues(\/|$)/, reason: "line queue runtime state" },
  { re: /(^|\/)\.git(\/|$)/, reason: ".git internals" },
  { re: /(^|\/)node_modules(\/|$)/, reason: "node_modules" },
  { re: /(^|\/)\.DS_Store$/, reason: "macOS metadata" },
];
const blockedHits: Array<{ file: string; reason: string }> = [];
for (const f of branchFiles) {
  for (const { re, reason } of BLOCKED_PATH_PATTERNS) {
    if (re.test(f)) {
      blockedHits.push({ file: f, reason });
      break;
    }
  }
}
if (blockedHits.length > 0) {
  const lines = blockedHits.map((h) => `  ${h.file}  (${h.reason})`).join("\n");
  fatal(
    "blocked path on branch — deploy halted before merge",
    `Branch ${branch} touches paths on the safety-gate blocklist:\n${lines}`
  );
}

// Regex secret scan (same patterns as develop.ts).
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Anthropic API key", re: /\bsk-ant-api03-[A-Za-z0-9_\-]{50,}/ },
  { name: "OpenAI/sk-style key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS secret access key (likely)", re: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i },
  { name: "Google API key", re: /\bAIza[A-Za-z0-9_\-]{35}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Slack token", re: /\bxox[abpsr]-[A-Za-z0-9\-]{10,}\b/ },
  { name: "Stripe live secret", re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: "PEM private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
const addedLines: string[] = [];
for (const line of branchDiff.split("\n")) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    addedLines.push(line);
  }
}
const addedText = addedLines.join("\n");
const secretHits: Array<{ kind: string; sample: string }> = [];
for (const { name, re } of SECRET_PATTERNS) {
  const m = addedText.match(re);
  if (m) {
    const sample = m[0].slice(0, 8) + "…[redacted]";
    secretHits.push({ kind: name, sample });
  }
}
if (secretHits.length > 0) {
  const lines = secretHits.map((h) => `  ${h.kind}: ${h.sample}`).join("\n");
  fatal(
    "potential secret on branch — deploy halted before merge",
    `Branch ${branch} contains strings matching secret patterns:\n${lines}`
  );
}

// gitleaks on the commit range — broader ruleset.
const gitleaksProbe = spawnSync("gitleaks", ["version"], { encoding: "utf-8" });
if (gitleaksProbe.status !== 0) {
  fatal(
    "gitleaks not installed on deploy host",
    `gitleaks binary not found on PATH. Install it (apt-get install -y gitleaks) ` +
      `so the deploy safety re-check can run.`
  );
}
log(`gitleaks detect --log-opts ${BASE}..${branch}`);
const glR = spawnSync(
  "gitleaks",
  ["detect", "--no-banner", "--redact", "--exit-code", "1", "--log-opts", `${BASE}..${branch}`],
  { cwd: REPO, encoding: "utf-8" }
);
if (glR.status !== 0) {
  const reason = glR.status === 1 ? "secrets detected in branch commits" : `gitleaks crashed (exit ${glR.status})`;
  fatal(
    `gitleaks (deploy): ${reason}`,
    ((glR.stdout ?? "") + "\n" + (glR.stderr ?? "")).slice(-3000)
  );
}

log("safety re-check passed");

// ─── 3. Merge in a throwaway worktree ────────────────────────────────
//
// Pre-2026-05-26 deploy did `git checkout BASE; git merge; git push`
// directly inside REPO. That coupled REPO's working tree to the merge
// operation — anyone editing REPO saw their files change underneath them,
// and uncommitted edits could block deploy. Now:
//   1. Spawn a throwaway worktree at /tmp/assembly-deploy/<wpId>, detached
//      at BASE's tip. REPO already has BASE checked out as a branch;
//      `--detach` avoids the per-branch worktree lock.
//   2. Merge the dev branch into the detached HEAD there.
//   3. `git push origin HEAD:BASE` — origin/BASE advances; the push
//      side-effect also updates our local refs/remotes/origin/BASE.
//   4. Fast-forward REPO's local BASE to origin/BASE — REPO IS the live
//      checkout the dashboard restarts from, so this is what makes the
//      merged code reachable.
//   5. Tear down the throwaway worktree.

const deployWtRoot = `/tmp/assembly-deploy/${wp.id}`;

if (existsSync(deployWtRoot)) {
  log(`removing leftover deploy worktree ${deployWtRoot}`);
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
}

log(`creating throwaway worktree ${deployWtRoot} detached at ${BASE}`);
const wtAddR = spawnSync(
  "git",
  ["-C", REPO, "worktree", "add", "--detach", deployWtRoot, BASE],
  { encoding: "utf-8" }
);
if (wtAddR.status !== 0) {
  fatal("git worktree add for deploy throwaway failed", (wtAddR.stdout ?? "") + "\n" + (wtAddR.stderr ?? ""));
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

log(`merge ${branch} --no-ff in throwaway worktree`);
const mergeR = spawnSync(
  "git",
  [
    "-C", deployWtRoot,
    "-c", "user.name=assembly-deploy",
    "-c", "user.email=assembly-deploy@local",
    "merge", branch, "--no-ff", "-m", commitMsg,
  ],
  { encoding: "utf-8" }
);
if (mergeR.status !== 0) {
  spawnSync("git", ["-C", deployWtRoot, "merge", "--abort"], { encoding: "utf-8" });
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal("git merge failed", (mergeR.stdout ?? "") + "\n" + (mergeR.stderr ?? ""));
}

const parentsR = spawnSync("git", ["-C", deployWtRoot, "rev-list", "--parents", "-n", "1", "HEAD"], { encoding: "utf-8" });
const parentsCount = (parentsR.stdout ?? "").trim().split(/\s+/).length - 1;
if (parentsCount !== 2) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`HEAD is not a merge commit (parents=${parentsCount})`);
}

const shaR = spawnSync("git", ["-C", deployWtRoot, "rev-parse", "HEAD"], { encoding: "utf-8" });
const mergeSha = (shaR.stdout ?? "").trim();
if (mergeSha.length !== 40) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`unable to capture merge SHA (got "${mergeSha}")`);
}

if (spawnSync("git", ["-C", deployWtRoot, "merge-base", "--is-ancestor", commitSha, "HEAD"]).status !== 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`develop commit ${commitSha} not in merge history of ${mergeSha}`);
}

log(`merge_commit=${mergeSha}`);

// ─── 4. Push to origin ────────────────────────────────────────────────

log(`pushing HEAD to origin/${BASE}`);
const pushR = spawnSync(
  "git",
  ["-C", deployWtRoot, "push", "origin", `HEAD:refs/heads/${BASE}`],
  { encoding: "utf-8" }
);
if (pushR.status !== 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`git push origin HEAD:${BASE} failed`, (pushR.stdout ?? "") + "\n" + (pushR.stderr ?? ""));
}

const lsR = spawnSync("git", ["-C", REPO, "ls-remote", "origin", `refs/heads/${BASE}`], { encoding: "utf-8" });
const remoteSha = ((lsR.stdout ?? "").split(/\s+/)[0] ?? "").trim();
if (remoteSha !== mergeSha) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`remote ${BASE} (${remoteSha}) does not match local merge (${mergeSha})`);
}

log(`pushed, remote_sha=${remoteSha}`);

// ─── 4b. Fast-forward the live worktree (REPO) ───────────────────────
//
// REPO is the live worktree services run from. It's on BASE but stale
// relative to origin/BASE (we just pushed). The push side-effect already
// advanced our local refs/remotes/origin/BASE — now FF the local BASE
// branch and update REPO's working tree atomically so the dashboard
// restart below picks up the new code.

log(`fast-forwarding REPO=${REPO} to origin/${BASE}`);
const ffR = spawnSync(
  "git",
  ["-C", REPO, "merge", "--ff-only", `origin/${BASE}`],
  { encoding: "utf-8" }
);
if (ffR.status !== 0) {
  // The merge is already on origin — we can't roll it back. REPO has
  // diverged from origin/BASE (uncommitted edits, manual commits, etc.).
  // Fail loudly; operator must reconcile REPO before next deploy.
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(
    `fast-forward of live worktree REPO=${REPO} to origin/${BASE} failed — origin has merge ${mergeSha} but REPO diverged`,
    (ffR.stdout ?? "") + "\n" + (ffR.stderr ?? "")
  );
}

const repoHeadR = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" });
if ((repoHeadR.stdout ?? "").trim() !== mergeSha) {
  log(`warning: REPO HEAD ${(repoHeadR.stdout ?? "").trim()} != merge ${mergeSha} after FF (non-fatal)`);
}

// ─── 5. Clean up worktrees + branch (best-effort) ─────────────────────

let worktreeCleaned = true;
const devWtRmR = spawnSync("git", ["-C", REPO, "worktree", "remove", worktreePath, "--force"], { encoding: "utf-8" });
if (devWtRmR.status !== 0) {
  log(`dev worktree remove failed (non-fatal): ${devWtRmR.stderr ?? ""}`);
  worktreeCleaned = false;
}
const dpWtRmR = spawnSync("git", ["-C", REPO, "worktree", "remove", deployWtRoot, "--force"], { encoding: "utf-8" });
if (dpWtRmR.status !== 0) {
  log(`deploy worktree remove failed (non-fatal): ${dpWtRmR.stderr ?? ""}`);
  worktreeCleaned = false;
}
const brDelR = spawnSync("git", ["-C", REPO, "branch", "-d", branch], { encoding: "utf-8" });
if (brDelR.status !== 0) {
  log(`branch delete failed (non-fatal): ${brDelR.stderr ?? ""}`);
  worktreeCleaned = false;
}

// ─── 6. Reload live services with new build (best-effort) ────────────
//
// Dashboard: systemctl restart — clean SIGTERM, then Restart=on-failure
// brings it back. The service ExecStart runs `bun run src/cli.ts dashboard
// start`, which re-reads the just-merged source from disk.
//
// Daemon: we do NOT call `assembly daemon reload` from inside a deploy
// worker running under a systemd-managed daemon. Reload's handoff design
// (old daemon spawns detached successor, exits 0) is incompatible with
// `Type=simple`/`Restart=on-failure`: systemd sees a clean MainPID exit,
// marks the service deactivated, and the detached successor — not tracked
// as MainPID — gets killed when its grandparent shell exits. Verified
// outage on 2026-05-19 23:38.
//
// Station scripts (this file, plan/develop/deploy AGENT.md, etc.) are read
// off disk per task invocation, so changes to those land immediately on
// the next task. For changes to daemon code itself (orchestrator, runner,
// queue, etc.), a manual `systemctl restart assembly` is required.
// `daemon_reloaded` stays false to signal that.

const dashboardService = process.env.ASSEMBLY_DASHBOARD_SERVICE ?? "assembly-dashboard";
let dashboardRestarted = false;
{
  const rcR = spawnSync("systemctl", ["restart", dashboardService], { encoding: "utf-8" });
  const activeR = spawnSync("systemctl", ["is-active", dashboardService], { encoding: "utf-8" });
  dashboardRestarted = (activeR.stdout ?? "").trim() === "active";
  if (!dashboardRestarted) {
    log(`dashboard restart failed or not active (non-fatal): rc=${rcR.status} active=${(activeR.stdout ?? "").trim()}`);
  } else {
    log(`dashboard restarted (${dashboardService})`);
  }
}

const daemonReloaded = false;

// ─── 7. Emit envelope ─────────────────────────────────────────────────

emit({
  summary: `Merged ${branch} to ${BASE} at ${mergeSha.slice(0, 8)}`,
  content: [
    `Merged ${branch} to ${BASE} at ${mergeSha}.`,
    `Pushed to origin; remote_sha=${remoteSha}.`,
    `worktree_cleaned=${worktreeCleaned}`,
    `dashboard_restarted=${dashboardRestarted}`,
    `daemon_reloaded=${daemonReloaded}`,
  ].join("\n"),
  data: {
    merged: true,
    merge_commit: mergeSha,
    pushed: true,
    worktree_cleaned: worktreeCleaned,
    dashboard_restarted: dashboardRestarted,
    daemon_reloaded: daemonReloaded,
    conflicts: [],
  },
});
