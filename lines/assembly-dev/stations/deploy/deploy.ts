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
 *   - rebase onto origin/BASE can't be completed (AI resolver exhausted,
 *     markers left over, agent crashed)
 *   - push to origin is rejected (non-FF — origin/BASE moved since fetch)
 *     or remote SHA != local SHA after push
 *   - LIVE worktree (ASSEMBLY_LIVE_ROOT) can't be reset --hard to
 *     origin/BASE after a successful push
 *
 * History is kept linear: deploy rebases the feature branch onto the latest
 * origin/BASE in a throwaway worktree (with the AI conflict resolver wrapping
 * each pause), then `git push origin HEAD:BASE` as a fast-forward. No merge
 * commits land on BASE. Conflicts surface via the AI resolver — neither
 * deploy nor any --force flag ever overwrites a remote commit.
 *
 * Best-effort (logs a warning, doesn't fail):
 *   - worktree cleanup
 *   - branch delete
 *   - dashboard service restart
 */
import { readFileSync, existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { spawnSync } from "child_process";

const REPO = process.env.ASSEMBLY_REPO_ROOT;
if (!REPO) {
  process.stderr.write("[deploy] ASSEMBLY_REPO_ROOT must point at the cloned assembly repo root\n");
  process.exit(2);
}

// Branch deploy merges into and pushes — the canonical history. Post-merge
// we `git push origin HEAD:${BASE}`. Default matches the pre-2026-05-26
// single-clone behavior.
const BASE = process.env.ASSEMBLY_DEPLOY_BRANCH ?? "main";

// Live worktree services run from. After pushing to origin/${BASE} we
// `git -C ${LIVE} reset --hard origin/${BASE}` so its working tree (on
// whatever branch — typically "production" for worktree-isolation from a
// user-owned ${BASE} checkout) matches what was just shipped, then restart
// services. Defaults to REPO when not split out.
const LIVE = process.env.ASSEMBLY_LIVE_ROOT ?? REPO;

// Model used by the conflict-resolution helper agent. Matches develop.ts
// default — sonnet is enough for resolving merge markers in this repo.
const MODEL = process.env.ASSEMBLY_DEPLOY_MODEL ?? "sonnet";

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
// Two-phase deploy:
//   (a) SHIP THE CODE — merge feature branch into BASE in a throwaway
//       worktree, push HEAD:BASE so origin/BASE is the canonical record.
//       Neither REPO nor LIVE is touched during this phase.
//   (b) DEPLOY TO LIVE — `git -C LIVE reset --hard origin/BASE` so LIVE's
//       working tree (typically on a separate "production" branch for
//       worktree-isolation from a user-owned BASE checkout) matches what
//       was just shipped, then restart services.
//
// Pre-2026-05-26 deploy ran phase (a) directly inside REPO, coupling the
// merge to REPO's working tree and blocking anyone editing it. The
// throwaway worktree decouples the two.

const deployWtRoot = `/tmp/assembly-deploy/${wp.id}`;

if (existsSync(deployWtRoot)) {
  log(`removing leftover deploy worktree ${deployWtRoot}`);
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
}

// Fetch BASE so the throwaway forks from the latest remote tip — guards
// against the case where some external push moved origin/BASE between
// develop and deploy. The throwaway detaches at refs/remotes/origin/BASE
// rather than the local BASE branch (which may be stale, especially when
// BASE is checked out in a user-owned worktree they haven't pulled in).
log(`fetching origin/${BASE} before throwaway`);
const fetchR = spawnSync("git", ["-C", REPO, "fetch", "origin", BASE], { encoding: "utf-8" });
if (fetchR.status !== 0) {
  fatal(`git fetch origin ${BASE} failed`, (fetchR.stdout ?? "") + "\n" + (fetchR.stderr ?? ""));
}

log(`creating throwaway worktree ${deployWtRoot} detached at feature=${branch}`);
const wtAddR = spawnSync(
  "git",
  ["-C", REPO, "worktree", "add", "--detach", deployWtRoot, branch],
  { encoding: "utf-8" }
);
if (wtAddR.status !== 0) {
  fatal("git worktree add for deploy throwaway failed", (wtAddR.stdout ?? "") + "\n" + (wtAddR.stderr ?? ""));
}

// Sanity-count feature commits relative to origin/${BASE} before rebase.
// Used after rebase to verify all commits made it through (rebase can drop
// commits that become empty when replayed onto a new base).
const preFeatureCountR = spawnSync(
  "git",
  ["-C", deployWtRoot, "rev-list", "--count", `origin/${BASE}..HEAD`],
  { encoding: "utf-8" }
);
const preFeatureCount = parseInt((preFeatureCountR.stdout ?? "0").trim(), 10) || 0;
if (preFeatureCount === 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`feature ${branch} has no commits ahead of origin/${BASE} — nothing to deploy`);
}
log(`feature has ${preFeatureCount} commit(s) ahead of origin/${BASE}`);

log(`rebasing ${branch} onto origin/${BASE}`);
let rebaseR = spawnSync(
  "git",
  [
    "-C", deployWtRoot,
    "-c", "user.name=assembly-deploy",
    "-c", "user.email=assembly-deploy@local",
    "-c", "core.editor=true",
    "rebase", `origin/${BASE}`,
  ],
  { encoding: "utf-8" }
);

let conflictResolved = false;
let resolutionCount = 0;
const MAX_REBASE_RESOLUTIONS = 20;

while (rebaseR.status !== 0 && resolutionCount < MAX_REBASE_RESOLUTIONS) {
  const conflictsR = spawnSync(
    "git",
    ["-C", deployWtRoot, "diff", "--name-only", "--diff-filter=U"],
    { encoding: "utf-8" }
  );
  const conflictedFiles = ((conflictsR.stdout ?? "").trim().split("\n")).filter(Boolean);

  if (conflictedFiles.length === 0) {
    spawnSync("git", ["-C", deployWtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
    fatal("rebase failed without reporting conflicts", (rebaseR.stdout ?? "") + "\n" + (rebaseR.stderr ?? ""));
  }

  resolutionCount++;
  log(`rebase pause #${resolutionCount}: conflicts in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);

  // AI resolver — mirrors develop.ts pre-rebase resolver. Each pause is one
  // commit being replayed; resolve, stage, `git rebase --continue` proceeds
  // to the next commit (which may pause again, hence the loop).
  const resolveSystemPrompt = `You are a senior developer resolving rebase conflicts inside an Assembly framework worktree.

## Your cwd IS the worktree
- You are running at: ${deployWtRoot}
- The worktree is mid-rebase: \`git rebase origin/${BASE}\` paused on a conflicted commit.
- The conflicted files have \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers (HEAD = origin/${BASE}'s tip plus any already-replayed commits; the incoming side is the feature commit being replayed now).
- Do NOT edit anything under ${REPO} or ${LIVE} — those are DIFFERENT checkouts.
- Do NOT run git commands. The script around you will stage and continue the rebase after you finish. NO \`git add\`, \`git commit\`, \`git rebase\`, \`git reset\`, etc.

## Your job
For each conflicted file: read it, understand BOTH sides, write a merged version with no markers that preserves the intent of both. The feature commit's new work and origin/${BASE}'s drift both matter — don't drop either. If two sides edit the same logical block, integrate them.

## Conflicted files
${conflictedFiles.map((f) => `- ${f}`).join("\n")}

## Verification
After editing each file, re-read it and confirm no \`<<<<<<<\`, \`=======\` (between markers), or \`>>>>>>>\` lines remain. The script will reject files with leftover markers and hard-fail.

Only edit the conflicted files listed above. Auto-merged files are already staged correctly — do not touch them.`;

  const resolveUserMsg = [
    `# Rebase-conflict resolution (deploy, pause #${resolutionCount})`,
    ``,
    `\`git rebase origin/${BASE}\` paused with content conflicts in:`,
    ...conflictedFiles.map((f) => `- ${f}`),
    ``,
    `Resolve each by editing out the markers while preserving both sides' intent.`,
    ``,
    `# Original task`,
    wp.task,
    ``,
    `# Plan summary`,
    wp.stations?.plan?.summary ?? "(no summary)",
  ].join("\n");

  log(`spawning claude for rebase conflict resolution model=${MODEL}`);
  const resolveProc = Bun.spawn(
    [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", MODEL,
      "--input-format", "stream-json",
      "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
      "--disallowedTools", "Skill",
      "--no-session-persistence",
    ],
    {
      cwd: deployWtRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    }
  );

  const resolvePayload = JSON.stringify({
    type: "user",
    system: resolveSystemPrompt,
    message: { role: "user", content: resolveUserMsg },
  }) + "\n";
  resolveProc.stdin.write(resolvePayload);
  await resolveProc.stdin.end();

  let resolveBuffer = "";
  const resolveReader = resolveProc.stdout.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await resolveReader.read();
    if (done) break;
    resolveBuffer += dec.decode(value);
    let idx;
    while ((idx = resolveBuffer.indexOf("\n")) !== -1) {
      const line = resolveBuffer.slice(0, idx);
      resolveBuffer = resolveBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant" && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === "tool_use") {
              log(`resolve.tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
            }
          }
        }
      } catch { /* non-JSON line — ignore */ }
    }
  }

  const resolveStderr = await new Response(resolveProc.stderr).text();
  const resolveExit = await resolveProc.exited;

  if (resolveExit !== 0) {
    spawnSync("git", ["-C", deployWtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
    fatal("conflict-resolution agent exited non-zero", `exit=${resolveExit}\n${resolveStderr.slice(-2000)}`);
  }

  const markerLeftovers: string[] = [];
  for (const f of conflictedFiles) {
    const absPath = resolvePath(deployWtRoot, f);
    if (!existsSync(absPath)) continue; // accepted deletion
    const content = readFileSync(absPath, "utf-8");
    if (
      /^<{7} /m.test(content) ||
      /^={7}$/m.test(content) ||
      /^>{7} /m.test(content)
    ) {
      markerLeftovers.push(f);
    }
  }
  if (markerLeftovers.length > 0) {
    spawnSync("git", ["-C", deployWtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
    fatal(
      "conflict markers remain after resolution agent",
      `Files still containing markers:\n${markerLeftovers.map((f) => `  ${f}`).join("\n")}`
    );
  }

  const addR = spawnSync(
    "git",
    ["-C", deployWtRoot, "add", "--", ...conflictedFiles],
    { encoding: "utf-8" }
  );
  if (addR.status !== 0) {
    spawnSync("git", ["-C", deployWtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
    fatal("git add of resolved conflict files failed", (addR.stdout ?? "") + "\n" + (addR.stderr ?? ""));
  }

  rebaseR = spawnSync(
    "git",
    [
      "-C", deployWtRoot,
      "-c", "user.name=assembly-deploy",
      "-c", "user.email=assembly-deploy@local",
      "-c", "core.editor=true",
      "rebase", "--continue",
    ],
    { encoding: "utf-8" }
  );
  conflictResolved = true;
}

if (rebaseR.status !== 0) {
  spawnSync("git", ["-C", deployWtRoot, "rebase", "--abort"], { encoding: "utf-8" });
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(
    `rebase exhausted ${MAX_REBASE_RESOLUTIONS} resolutions without completing`,
    (rebaseR.stdout ?? "") + "\n" + (rebaseR.stderr ?? "")
  );
}

if (conflictResolved) {
  log(`rebase completed after ${resolutionCount} resolution(s)`);
} else {
  log(`rebase clean (no conflicts)`);
}

// ─── Validate post-rebase state ─────────────────────────────────────

const ancestorR = spawnSync(
  "git",
  ["-C", deployWtRoot, "merge-base", "--is-ancestor", `origin/${BASE}`, "HEAD"],
  { encoding: "utf-8" }
);
if (ancestorR.status !== 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`HEAD is not a descendant of origin/${BASE} after rebase — refusing to push`);
}

const shaR = spawnSync("git", ["-C", deployWtRoot, "rev-parse", "HEAD"], { encoding: "utf-8" });
const mergeSha = (shaR.stdout ?? "").trim();
if (mergeSha.length !== 40) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`unable to capture post-rebase HEAD SHA (got "${mergeSha}")`);
}

const postCountR = spawnSync(
  "git",
  ["-C", deployWtRoot, "rev-list", "--count", `origin/${BASE}..HEAD`],
  { encoding: "utf-8" }
);
const postCount = parseInt((postCountR.stdout ?? "0").trim(), 10) || 0;
if (postCount === 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`rebase consumed all feature commits — nothing to push (HEAD = origin/${BASE})`);
}
log(`post-rebase HEAD=${mergeSha.slice(0, 8)} (${postCount} commits ahead of origin/${BASE}, was ${preFeatureCount})`);

// ─── 4. Push to origin ────────────────────────────────────────────────
//
// Plain push, no --force / --force-with-lease. If origin/${BASE} moved
// between our fetch and this push, the push is rejected (non-fast-forward)
// — we fail loudly, never overwrite. Operator (or next deploy run) handles
// re-rebasing against the new origin/${BASE}.

log(`pushing HEAD to origin/${BASE}`);
const pushR = spawnSync(
  "git",
  ["-C", deployWtRoot, "push", "origin", `HEAD:refs/heads/${BASE}`],
  { encoding: "utf-8" }
);
if (pushR.status !== 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(
    `git push origin HEAD:${BASE} failed — likely non-FF (origin/${BASE} moved since fetch). Re-run deploy.`,
    (pushR.stdout ?? "") + "\n" + (pushR.stderr ?? "")
  );
}

const lsR = spawnSync("git", ["-C", REPO, "ls-remote", "origin", `refs/heads/${BASE}`], { encoding: "utf-8" });
const remoteSha = ((lsR.stdout ?? "").split(/\s+/)[0] ?? "").trim();
if (remoteSha !== mergeSha) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(`remote ${BASE} (${remoteSha}) does not match local HEAD (${mergeSha})`);
}

log(`pushed, remote_sha=${remoteSha}`);

// ─── 4b. Deploy to live worktree (LIVE) ──────────────────────────────
//
// Phase (b) — make the just-shipped code reachable to the running services.
// LIVE is on some non-${BASE} branch (typically "production") so that ${BASE}
// can be checked out elsewhere by a user without colliding. We force-sync
// LIVE's branch to origin/${BASE} via `git reset --hard`:
//   - moves LIVE's current branch ref to origin/${BASE}'s commit
//   - updates LIVE's working tree atomically — services restart below pick
//     up the new code from disk
//   - does NOT touch ${BASE} as a ref (so a worktree on ${BASE} stays put)
//
// If LIVE has uncommitted modifications they're discarded. Services don't
// write to source files, so this should never happen in practice; if it
// does, the discard is the correct behavior (LIVE must match what shipped).

log(`reset --hard LIVE=${LIVE} to origin/${BASE}`);
const resetR = spawnSync(
  "git",
  ["-C", LIVE, "reset", "--hard", `origin/${BASE}`],
  { encoding: "utf-8" }
);
if (resetR.status !== 0) {
  spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", deployWtRoot], { encoding: "utf-8" });
  fatal(
    `git reset --hard origin/${BASE} on LIVE=${LIVE} failed — origin has merge ${mergeSha} but LIVE could not be reset`,
    (resetR.stdout ?? "") + "\n" + (resetR.stderr ?? "")
  );
}

const liveHeadR = spawnSync("git", ["-C", LIVE, "rev-parse", "HEAD"], { encoding: "utf-8" });
if ((liveHeadR.stdout ?? "").trim() !== mergeSha) {
  log(`warning: LIVE HEAD ${(liveHeadR.stdout ?? "").trim()} != merge ${mergeSha} after reset (non-fatal)`);
}

// Best-effort: push LIVE's branch (production) to origin so origin/production
// also tracks the latest deployed commit. Plain push (no --force) — since
// reset moves production strictly forward (to origin/${BASE} which is itself
// a descendant of the previous deploy), the push is a fast-forward and
// requires no force. If someone manually advanced origin/production behind
// our back, push is rejected — we log and continue (main is already shipped).
const liveBranchR = spawnSync("git", ["-C", LIVE, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
const liveBranch = (liveBranchR.stdout ?? "").trim();
let liveBranchPushed = false;
if (liveBranch && liveBranch !== "HEAD" && liveBranch !== BASE) {
  log(`pushing LIVE branch ${liveBranch} to origin`);
  const livePushR = spawnSync(
    "git",
    ["-C", LIVE, "push", "origin", `${liveBranch}:${liveBranch}`],
    { encoding: "utf-8" }
  );
  if (livePushR.status === 0) {
    liveBranchPushed = true;
  } else {
    log(`push of LIVE branch ${liveBranch} failed (non-fatal): ${livePushR.stderr ?? ""}`);
  }
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
// Daemon: scheduled via `systemd-run --no-block --on-active=Ns` to run in
// a detached transient unit, NOT inline. deploy.ts is running inside a
// section-worker that is a descendant of the assembly daemon — calling
// `systemctl restart assembly` directly would SIGTERM the whole cgroup
// (including ourselves) before we could emit the envelope. The deferred
// transient unit fires N seconds after we exit, after the envelope is
// safely persisted by section-worker.
//
// The N-second delay also lets the dashboard restart settle. The previous
// `daemon reload` (in-app handoff) approach was incompatible with the
// systemd Type=simple unit model — see commit history around 2026-05-19.

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

const daemonService = process.env.ASSEMBLY_DAEMON_SERVICE ?? "assembly";
const daemonRestartDelay = process.env.ASSEMBLY_DAEMON_RESTART_DELAY ?? "15s";
let daemonRestartScheduled = false;
{
  const cmdR = spawnSync(
    "systemd-run",
    [
      "--no-block",
      "--on-active=" + daemonRestartDelay,
      "--description=post-deploy daemon restart for " + wp.id,
      "systemctl", "restart", daemonService,
    ],
    { encoding: "utf-8" }
  );
  daemonRestartScheduled = cmdR.status === 0;
  if (!daemonRestartScheduled) {
    log(`systemd-run daemon restart schedule failed (non-fatal): rc=${cmdR.status} ${(cmdR.stderr ?? "").slice(-200)}`);
  } else {
    log(`scheduled deferred daemon restart (${daemonService}, fires in ${daemonRestartDelay})`);
  }
}

// ─── 7. Emit envelope ─────────────────────────────────────────────────
//
// Field naming note: `merge_commit` keeps its name for envelope-consumer
// compat, but it now holds the post-rebase HEAD SHA (no merge commit
// exists — feature commits are replayed linearly on top of origin/BASE).

emit({
  summary: `Rebased ${branch} onto ${BASE} at ${mergeSha.slice(0, 8)}${conflictResolved ? ` (${resolutionCount} conflict resolution${resolutionCount === 1 ? "" : "s"})` : ""}`,
  content: [
    `Rebased ${branch} onto ${BASE} at ${mergeSha}.`,
    `Pushed to origin; remote_sha=${remoteSha}.`,
    conflictResolved ? `Resolved ${resolutionCount} conflict pause(s) via AI during rebase.` : `Rebase was clean (no conflicts).`,
    `LIVE branch ${liveBranch || "(none)"} reset --hard to origin/${BASE}; pushed=${liveBranchPushed}.`,
    `worktree_cleaned=${worktreeCleaned}`,
    `dashboard_restarted=${dashboardRestarted}`,
    `daemon_restart_scheduled=${daemonRestartScheduled} (fires in ${daemonRestartDelay})`,
  ].join("\n"),
  data: {
    merged: true,
    merge_commit: mergeSha,
    pushed: true,
    rebased: true,
    conflict_resolved: conflictResolved,
    resolution_count: resolutionCount,
    live_branch: liveBranch,
    live_branch_pushed: liveBranchPushed,
    worktree_cleaned: worktreeCleaned,
    dashboard_restarted: dashboardRestarted,
    daemon_restart_scheduled: daemonRestartScheduled,
    daemon_restart_delay: daemonRestartDelay,
    daemon_reloaded: false,
    conflicts: [],
  },
});
