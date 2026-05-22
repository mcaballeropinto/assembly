#!/usr/bin/env bun
/**
 * Deterministic develop station for assembly-dev.
 *
 * Script provider — replaces the pure-LLM develop station so worktree setup,
 * cwd, test run, and commit SHA capture happen in code, not in an agent's
 * hallucination. The LLM only does what it's good at: reading the plan and
 * writing code into the right place.
 *
 * Contract (script provider):
 *   stdin  — unused
 *   argv[1] — path to workpiece JSON
 *   stdout  — one-line envelope JSON (consumed by section-worker)
 *   stderr  — progress log (tee'd into activity via section-worker stderr capture)
 *   exit 0  — envelope written; non-zero = failure, stderr surfaced to caller
 */
import { readFileSync, existsSync, statSync, unlinkSync } from "fs";
import { resolve as resolvePath } from "path";
import { spawnSync } from "child_process";

const REPO = process.env.ASSEMBLY_REPO_ROOT;
if (!REPO) {
  process.stderr.write("[develop] ASSEMBLY_REPO_ROOT must point at the cloned assembly repo root\n");
  process.exit(2);
}
const MODEL = process.env.ASSEMBLY_DEV_MODEL ?? "sonnet";

function log(msg: string) {
  process.stderr.write(`[develop] ${new Date().toISOString()} ${msg}\n`);
}

function emit(envelope: {
  summary: string;
  content?: string;
  data: Record<string, unknown>;
}): never {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(0);
}

/**
 * Hard-fail: exit non-zero so the runner/orchestrator marks the station as
 * failed and the pipeline stops. Every failure in this station is "downstream
 * cannot proceed" — deploy needs branch_name, commit_sha, and worktree_path
 * to do anything, and without a successful develop those are meaningless.
 * The previous "soft fail" path (emit a Failed: envelope + exit 0) let deploy
 * advance and retry 3× before giving up — that path is gone for good.
 */
function hardFail(summary: string, details: string): never {
  process.stderr.write(`[develop] FATAL: ${summary}\n`);
  if (details) {
    process.stderr.write(details.slice(-2000) + "\n");
  }
  process.exit(1);
}

// ─── Input ────────────────────────────────────────────────────────────

const workpiecePath = process.argv[2];
if (!workpiecePath || !existsSync(workpiecePath)) {
  hardFail("workpiece path missing", `argv[1]=${workpiecePath}`);
}

let wp: any;
try {
  wp = JSON.parse(readFileSync(workpiecePath, "utf-8"));
} catch (e) {
  hardFail("workpiece parse failed", String(e));
}

const wpId: string = wp.id;
const plan = wp.stations?.plan?.data;

// No-op short-circuit. Two paths trigger it:
//   1. Plan explicitly set `no_op: true` (the documented signal).
//   2. Plan implicitly reported nothing to do — empty `files_to_change` AND
//      empty `files_to_create`. Agents don't reliably set the explicit flag
//      (we've seen "Feature already fully implemented" plans with empty file
//      lists but `branch_name: "none/feature-already-implemented"`), so we
//      infer the no-op from the file lists too.
// Either way: no worktree, no claude spawn, no tests, no commit. The flag
// propagates to deploy so the merge/push/restart pipeline also short-circuits.
function isNoOpPlan(plan: any): { is_no_op: boolean; reason: string } {
  if (!plan) return { is_no_op: false, reason: "" };
  if (plan.no_op === true) {
    return {
      is_no_op: true,
      reason: typeof plan.no_op_reason === "string" ? plan.no_op_reason : "plan reported no_op=true",
    };
  }
  const changeList = Array.isArray(plan.files_to_change) ? plan.files_to_change : null;
  const createList = Array.isArray(plan.files_to_create) ? plan.files_to_create : null;
  if (changeList !== null && createList !== null && changeList.length === 0 && createList.length === 0) {
    const ps = typeof plan.problem_statement === "string" ? plan.problem_statement.slice(0, 200) : "";
    return {
      is_no_op: true,
      reason: `plan has empty files_to_change and files_to_create${ps ? ` — ${ps}` : ""}`,
    };
  }
  return { is_no_op: false, reason: "" };
}

const noOp = isNoOpPlan(plan);
if (noOp.is_no_op) {
  log(`no-op from plan: ${noOp.reason}`);
  emit({
    summary: `No-op: ${noOp.reason.slice(0, 140)}`,
    content: `Develop skipped — plan signalled no_op (explicit or inferred from empty file lists).\n\nReason: ${noOp.reason}\n\nNo worktree, no claude spawn, no tests, no commit.`,
    data: {
      no_op: true,
      no_op_reason: noOp.reason,
      branch_name: "",
      worktree_path: "",
      commit_sha: "",
      files_changed: [],
      files_created: [],
      tests_passed: true,
    },
  });
}

if (!plan?.branch_name) {
  hardFail("plan.data.branch_name required", "develop can't set up a worktree without a branch name");
}

const branch: string = plan.branch_name;
const wtRoot = `/tmp/assembly-dev/${wpId}`;
const wt = wtRoot;

// ─── Worktree setup ───────────────────────────────────────────────────

log(`worktree=${wtRoot} branch=${branch}`);

// Auto-cleanup of stale worktrees holding the same branch.
//
// Plan generates content-based branch names (e.g. assembly-dev/station-
// health-indicator), so retries of the same task — or re-runs of similar
// tasks — try to claim a branch already checked out in a leftover
// worktree from a prior failed run. `git worktree add` refuses with
// "branch X is already used by worktree at Y". We auto-remove any such
// orphan if its branch has NO commits ahead of main (i.e. the agent's
// session produced no committed work — just transient edits that
// already cost us a failed run). Worktrees with real ahead-of-main
// commits are preserved and we hardFail so the operator can inspect.
function findWorktreeForBranch(targetBranch: string): string | null {
  const r = spawnSync("git", ["-C", REPO, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const blocks = (r.stdout ?? "").split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let br = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) br = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
    if (br === targetBranch && path !== wtRoot) return path;
  }
  return null;
}

const stalePath = findWorktreeForBranch(branch);
if (stalePath) {
  const aheadR = spawnSync("git", ["-C", REPO, "log", `main..${branch}`, "--oneline"], { encoding: "utf-8" });
  const aheadOfMain = (aheadR.stdout ?? "").trim();
  if (!aheadOfMain) {
    log(`stale worktree at ${stalePath} holds branch ${branch} with no commits ahead of main — removing`);
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", stalePath], { encoding: "utf-8" });
    spawnSync("git", ["-C", REPO, "branch", "-D", branch], { encoding: "utf-8" });
  } else {
    hardFail(
      "branch already checked out in another worktree with unmerged commits",
      `branch=${branch} stale_worktree=${stalePath}\n` +
        `That worktree has commits ahead of main — refusing to auto-remove.\n` +
        `Inspect the commits there and either merge them, abandon the branch ` +
        `(git -C ${REPO} worktree remove --force ${stalePath} && git -C ${REPO} branch -D ${branch}), ` +
        `or pick a different branch name in the plan.\n` +
        `Commits ahead of main:\n${aheadOfMain}`
    );
  }
}

if (!existsSync(wtRoot)) {
  const branchExists = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", branch]).status === 0;
  const args = branchExists
    ? ["-C", REPO, "worktree", "add", wtRoot, branch]
    : ["-C", REPO, "worktree", "add", wtRoot, "-b", branch, "main"];
  const r = spawnSync("git", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    hardFail("git worktree add failed", `branch=${branch}\n${r.stderr}`);
  }
  log(`worktree created`);
} else {
  log(`worktree exists, reusing`);
}

if (!existsSync(wt) || !statSync(wt).isDirectory()) {
  hardFail("worktree missing", `expected ${wt}; branch=${branch}`);
}

// ─── Build the agent prompt ───────────────────────────────────────────

const dashboardAffected = plan.dashboard_affected === true;
const impl = (plan.implementation_steps ?? []) as Array<{
  step?: number;
  description?: string;
  files?: string[];
  details?: string;
}>;

const envelopePath = resolvePath(wt, ".envelope.json");

const systemPrompt = `You are a senior developer implementing a plan inside an Assembly framework worktree.

## Your cwd IS the worktree
- You are already running at: ${wt}
- All edits target files under this directory. Use relative paths or paths starting with ${wt}/.
- Do NOT edit anything under ${REPO} — that is a DIFFERENT checkout and your changes would bypass the merge pipeline.
- Do NOT create git commits, worktrees, or merges — the script around you handles that after you finish.
- Do NOT run git add, git commit, git merge, systemctl, or anything that modifies git state.

## Your job
Read the plan, implement it inside the current directory, run \`bun test\` until it passes. That is all.

## Envelope file — REQUIRED, this is how you report results
Before you finish, you MUST use the Write tool to create this file:

  ${envelopePath}

The file MUST contain a single JSON object with exactly these fields:

{
  "summary": "<one-line changelog>",
  "content": "<detailed changelog, file-by-file>",
  "data": {
    "files_changed": ["src/foo.ts", ...],
    "files_created": ["src/bar.ts", ...],
    "tests_passed": true,
    "test_output": "<last 50 lines of bun test output>"
  }
}

The harness reads this file after you exit. Without it, the station fails with no
parseable envelope and the work is discarded. Your final assistant message can
say anything — only the file matters. If you ran out of room mid-task, still
write the envelope describing what you DID change (so the harness sees a real
diff with a matching file list); the deploy step will fail on test failures and
the orchestrator will retry develop with feedback.`;

// Prior eval feedback — set by the runner when retrying develop after eval
// rejected the previous attempt (usually because tests failed). Read from the
// workpiece's ephemeral `_pending_eval_feedback` slot. Also fall back to the
// last item in `previous_attempts` when retry state was preserved through the
// orchestrator queue path instead.
const pendingFeedback: string | undefined = (() => {
  const pe = (wp as any)._pending_eval_feedback;
  if (pe && pe.station === "develop" && typeof pe.feedback === "string") {
    return `# Prior attempt feedback (attempt ${pe.attempt})\n${pe.feedback}`;
  }
  const prev = (wp.stations?.develop?.previous_attempts ?? []) as Array<any>;
  const last = prev[prev.length - 1];
  const lastFeedback = last?.eval?.feedback;
  if (typeof lastFeedback === "string" && lastFeedback.trim()) {
    return `# Prior attempt feedback (from previous_attempts)\n${lastFeedback}`;
  }
  return undefined;
})();

const userMsg = [
  `# Task`,
  wp.task,
  ``,
  `# Plan summary`,
  wp.stations?.plan?.summary ?? "(no summary)",
  ``,
  `# Plan content`,
  wp.stations?.plan?.content ?? "(no content)",
  ``,
  `# Implementation steps`,
  ...impl.map(
    (s, i) =>
      `${i + 1}. ${s.description ?? ""}\n   Files: ${JSON.stringify(s.files ?? [])}\n   Details: ${s.details ?? ""}`
  ),
  ``,
  dashboardAffected
    ? `# Dashboard affected\nYes — but DO NOT start, stop, restart, or signal any \`assembly\` service, dashboard, or daemon. The dashboard and daemon both run from the same source tree as this worktree, and the production dashboard owns \`~/.assembly/dashboard.pid\`; spinning up another \`bun run src/cli.ts dashboard\` (even on a different --port) collides with that file and kills the live service. The deploy station restarts the dashboard and reloads the daemon with the new build after merge — that is the only path. Limit yourself to \`bun test\` and static checks.`
    : `# Dashboard affected\nNo.`,
  ``,
  pendingFeedback ?? "",
].join("\n");

if (pendingFeedback) {
  log(`retry with prior-attempt feedback (${pendingFeedback.length} chars)`);
}

// ─── Spawn claude with cwd=worktree ───────────────────────────────────

// Clear any stale envelope from a prior failed run in this worktree —
// otherwise we'd read the old agent's output and skip the live one's failure.
if (existsSync(envelopePath)) {
  try { unlinkSync(envelopePath); } catch {}
}

log(`spawning claude cwd=${wt} model=${MODEL} envelope=${envelopePath}`);

const claudeArgs = [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--model", MODEL,
  "--input-format", "stream-json",
  "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
  "--disallowedTools", "Skill",
  "--no-session-persistence",
];

const proc = Bun.spawn(["claude", ...claudeArgs], {
  cwd: wt,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

const payload = JSON.stringify({
  type: "user",
  system: systemPrompt,
  message: { role: "user", content: userMsg },
}) + "\n";
proc.stdin.write(payload);
await proc.stdin.end();

// Stream stdout for tool-use logs only — the envelope comes from the file,
// not from the model's final assistant turn. We still read stdout to drain
// the pipe (otherwise the child blocks on backpressure).
let buffer = "";
const stdoutReader = proc.stdout.getReader();
const dec = new TextDecoder();
while (true) {
  const { done, value } = await stdoutReader.read();
  if (done) break;
  buffer += dec.decode(value);
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "tool_use") {
            log(`tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
          }
        }
      }
    } catch {
      /* non-JSON line — ignore */
    }
  }
}

const stderrText = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

if (exitCode !== 0) {
  hardFail(
    "claude exited non-zero",
    `branch=${branch} worktree=${wtRoot}\nexit=${exitCode}\n${stderrText.slice(-2000)}`
  );
}

// ─── Load agent envelope — prefer file, fall back to git synthesis ────
//
// The system prompt asks the agent to Write ${envelopePath} as its final
// step. In practice agents reliably do the IMPLEMENTATION work (real
// diffs in the worktree, tests passing) but routinely forget the final
// Write step — they consider tests-pass + diff-looks-good as "done".
// Earlier this session a strict file-required gate caused retries to
// loop in develop while the actual work was already complete.
//
// New strategy: the envelope file is the PREFERRED narrative source
// (richer summary/content from the agent), but file lists are always
// authoritative from git. If the file is missing/malformed, we
// synthesize the whole envelope from worktree state and proceed. Gate 0
// (envelope-vs-diff scope check) still catches the original "lying
// envelope" failure mode because synthesized lists by definition match
// the diff, while a file-supplied list that mismatches still hardFails.

function synthesizeFromGit(reason: string): {
  summary: string;
  content: string;
  data: { files_changed: string[]; files_created: string[]; tests_passed: boolean; test_output: string };
} {
  log(`synthesizing envelope from git state — ${reason}`);
  const statusR = spawnSync("git", ["-C", wtRoot, "status", "--porcelain"], { encoding: "utf-8" });
  const branchDiffR = spawnSync(
    "git",
    ["-C", wtRoot, "diff", "--name-status", "main...HEAD"],
    { encoding: "utf-8" }
  );
  const fileKind = new Map<string, "changed" | "created">();
  // Working tree (uncommitted) — porcelain format: "XY name"
  for (const line of (statusR.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const name = line.slice(3).replace(/^"|"$/g, "").trim();
    if (!name || name === ".envelope.json") continue;
    if (code.includes("?") || code.includes("A")) fileKind.set(name, "created");
    else fileKind.set(name, "changed");
  }
  // Branch commits ahead of main — diff --name-status: "A\tname" / "M\tname" / "D\tname"
  for (const line of (branchDiffR.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const name = rest.join("\t").trim();
    if (!name || name === ".envelope.json") continue;
    if (status.startsWith("A")) fileKind.set(name, "created");
    else if (status.startsWith("D")) continue; // deletions aren't "created" or "changed"
    else fileKind.set(name, "changed");
  }
  const files_changed: string[] = [];
  const files_created: string[] = [];
  for (const [name, kind] of fileKind) {
    if (kind === "created") files_created.push(name);
    else files_changed.push(name);
  }
  files_changed.sort();
  files_created.sort();
  const taskTitleMatch = (wp.task ?? "").match(/^#\s*(?:Feature|Bug|Fix|Task|Story):\s*(.+)$/m);
  const taskTitle = taskTitleMatch
    ? taskTitleMatch[1].trim()
    : ((wp.task ?? "implementation").toString().split("\n")[0] ?? "implementation").slice(0, 120);
  return {
    summary: `Implementation: ${taskTitle}`.slice(0, 200),
    content:
      `Envelope synthesized by develop.ts from worktree git state — ${reason}\n\n` +
      `Files changed (${files_changed.length}):\n${files_changed.map((f) => `  ${f}`).join("\n")}\n\n` +
      `Files created (${files_created.length}):\n${files_created.map((f) => `  ${f}`).join("\n")}\n`,
    data: {
      files_changed,
      files_created,
      tests_passed: true, // deploy re-runs tests; we don't pretend to know
      test_output: "(not captured; envelope synthesized)",
    },
  };
}

let agentEnv: any = null;
let envelopeSource: "file" | "synthesized" = "synthesized";
let synthReason = "";

if (existsSync(envelopePath)) {
  try {
    const raw = readFileSync(envelopePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      agentEnv = parsed;
      envelopeSource = "file";
    } else {
      synthReason = "envelope file parsed but is not a JSON object";
    }
  } catch (e) {
    synthReason = `envelope file not valid JSON: ${(e as Error).message.slice(0, 200)}`;
  }
  // Always remove so `git add -A` can't stage it.
  try { unlinkSync(envelopePath); } catch {}
} else {
  synthReason = "agent did not write .envelope.json (forgot or ran out of context)";
}

// Fill in missing fields from git synthesis. We synthesize the whole
// thing when the file was absent/malformed; we also patch in synthesized
// file lists when a file-supplied envelope omits them (or supplies wrong
// types) so downstream code can always rely on the shape.
const synthesized = synthesizeFromGit(synthReason || "patching missing fields from file envelope");

if (envelopeSource !== "file") {
  agentEnv = synthesized;
} else {
  if (typeof agentEnv.summary !== "string" || !agentEnv.summary.trim()) {
    agentEnv.summary = synthesized.summary;
  }
  if (typeof agentEnv.content !== "string") {
    agentEnv.content = synthesized.content;
  }
  if (!agentEnv.data || typeof agentEnv.data !== "object" || Array.isArray(agentEnv.data)) {
    agentEnv.data = {};
  }
  if (!Array.isArray(agentEnv.data.files_changed)) {
    agentEnv.data.files_changed = synthesized.data.files_changed;
  }
  if (!Array.isArray(agentEnv.data.files_created)) {
    agentEnv.data.files_created = synthesized.data.files_created;
  }
  if (typeof agentEnv.data.tests_passed !== "boolean") {
    agentEnv.data.tests_passed = synthesized.data.tests_passed;
  }
  if (typeof agentEnv.data.test_output !== "string") {
    agentEnv.data.test_output = synthesized.data.test_output;
  }
}

log(`envelope source=${envelopeSource} files_changed=${(agentEnv.data.files_changed as string[]).length} files_created=${(agentEnv.data.files_created as string[]).length}`);

const agentSummary: string = agentEnv.summary;
const agentContent: string = agentEnv.content;
const agentData = agentEnv.data as Record<string, unknown>;

// ─── Verify there are actual changes in the worktree ──────────────────

const statusR = spawnSync("git", ["-C", wtRoot, "status", "--porcelain"], { encoding: "utf-8" });
const porcelain = (statusR.stdout ?? "").trim();
const logR = spawnSync("git", ["-C", wtRoot, "log", "main..HEAD", "--oneline"], { encoding: "utf-8" });
const aheadOfMain = (logR.stdout ?? "").trim();

if (!porcelain && !aheadOfMain) {
  hardFail(
    "no changes in worktree",
    `agent produced no file changes and no new commits. cwd=${wt} branch=${branch}\nagent_summary=${agentSummary}`
  );
}

// ─── Safety gates ─────────────────────────────────────────────────────
//
// Run BEFORE tests/commit. Each gate hardFails on violation so the agent's
// changes never reach `main`. Cheap gates run first.
//
// 1. Path blocklist  — diff must not touch secrets/SSH/runtime state
// 2. Secret scan     — diff content must not contain credential-shaped strings
// 3. Plan alignment  — changed files must be ⊆ plan.files_to_change ∪ files_to_create
//                      (with a small allowance for test files paired with planned src files)
// 4. Typecheck       — `tsc --noEmit` must be clean
// 5. Lint            — `eslint .` must be clean
// (6. Tests           — existing `bun test` further down)

// Stage everything so we can scan it as a single diff. The worktree is
// transient; if any gate fails we hardFail and the orchestrator tears it down.
spawnSync("git", ["-C", wtRoot, "add", "-A"], { stdio: "inherit" });

const changedR = spawnSync(
  "git",
  ["-C", wtRoot, "diff", "--cached", "--name-only", "HEAD"],
  { encoding: "utf-8" }
);
const changedFiles = ((changedR.stdout ?? "").trim().split("\n")).filter((s) => s.length > 0);

const diffR = spawnSync(
  "git",
  ["-C", wtRoot, "diff", "--cached", "--no-color", "HEAD"],
  { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
);
const diffText = diffR.stdout ?? "";

log(`safety gates: ${changedFiles.length} changed files, ${diffText.length} bytes of diff`);

// ── Gate 0: Envelope ↔ diff scope cross-check ────────────────────────
//
// Catches "agent lied about scope" envelopes — e.g. summary "Implementation
// attempted" with `files_changed: []` / `files_created: []` while the
// worktree actually has hundreds of lines deleted across multiple files.
// Real failure observed 2026-05-19: agent gutted ~800 lines of dashboard
// code, claimed no files changed, deploy almost merged it. Only an unrelated
// flaky test held the line.
//
// We require the envelope's claimed file set to be non-empty AND to roughly
// match the actual diff. "Roughly" = the agent must claim at least one of
// the actually-changed files. We're lenient on extras because plan-alignment
// gate (Gate 3) handles the strict ⊆ check.
{
  const claimedChanged = Array.isArray(agentData.files_changed) ? (agentData.files_changed as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const claimedCreated = Array.isArray(agentData.files_created) ? (agentData.files_created as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const claimedAll = new Set<string>([...claimedChanged, ...claimedCreated]);

  if (changedFiles.length > 0 && claimedAll.size === 0) {
    hardFail(
      "agent envelope claims no files changed but worktree has real diff",
      [
        `agent_summary=${agentSummary}`,
        `envelope.files_changed=${JSON.stringify(claimedChanged)}`,
        `envelope.files_created=${JSON.stringify(claimedCreated)}`,
        `actual changed files (${changedFiles.length}):`,
        ...changedFiles.slice(0, 30).map((f) => `  ${f}`),
        changedFiles.length > 30 ? `  ... and ${changedFiles.length - 30} more` : "",
      ].filter(Boolean).join("\n")
    );
  }

  // Belt-and-suspenders: at least one claimed path must exist in the actual
  // diff. An agent that fabricates a totally unrelated file list is also bad
  // news. We compare basenames to tolerate path-normalization differences.
  if (changedFiles.length > 0 && claimedAll.size > 0) {
    const actualBasenames = new Set(changedFiles.map((f) => f.split("/").pop()!));
    const claimedBasenames = [...claimedAll].map((f) => f.split("/").pop()!);
    const overlap = claimedBasenames.some((b) => actualBasenames.has(b));
    if (!overlap) {
      hardFail(
        "agent envelope file list does not overlap with actual diff",
        [
          `envelope.files_changed+files_created=${JSON.stringify([...claimedAll])}`,
          `actual changed files (${changedFiles.length}):`,
          ...changedFiles.slice(0, 30).map((f) => `  ${f}`),
        ].join("\n")
      );
    }
  }
}

// ── Gate 1: Path blocklist ───────────────────────────────────────────
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
for (const f of changedFiles) {
  for (const { re, reason } of BLOCKED_PATH_PATTERNS) {
    if (re.test(f)) {
      blockedHits.push({ file: f, reason });
      break;
    }
  }
}
if (blockedHits.length > 0) {
  const lines = blockedHits.map((h) => `  ${h.file}  (${h.reason})`).join("\n");
  hardFail(
    "blocked path in diff",
    `Files in diff match the safety-gate path blocklist:\n${lines}\n` +
      `These paths must never be committed. The agent must not edit them.`
  );
}

// ── Gate 2: Secret scan ──────────────────────────────────────────────
// High-confidence patterns only — false positives here halt the pipeline.
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
// Scan only ADDED lines (lines beginning with "+" in the unified diff, excluding "+++" file headers).
const addedLines: string[] = [];
for (const line of diffText.split("\n")) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    addedLines.push(line);
  }
}
const addedText = addedLines.join("\n");
const secretHits: Array<{ kind: string; sample: string }> = [];
for (const { name, re } of SECRET_PATTERNS) {
  const m = addedText.match(re);
  if (m) {
    // Redact the match so the failure message doesn't itself leak the secret.
    const sample = m[0].slice(0, 8) + "…[redacted]";
    secretHits.push({ kind: name, sample });
  }
}
if (secretHits.length > 0) {
  const lines = secretHits.map((h) => `  ${h.kind}: ${h.sample}`).join("\n");
  hardFail(
    "potential secret in diff",
    `Diff contains strings matching secret patterns:\n${lines}\n` +
      `If these are false positives, narrow the regex in develop.ts. ` +
      `Never commit real secrets.`
  );
}

// ── Gate 2b: gitleaks on the staged diff ─────────────────────────────
// gitleaks has a broader, well-maintained ruleset than our regex sweep
// (AWS, GitHub, Slack, GCP service-account JSON, …). The Anthropic key
// rule is missing in older gitleaks versions, which is why we keep the
// regex sweep above.
const gitleaksProbe = spawnSync("gitleaks", ["version"], { encoding: "utf-8" });
if (gitleaksProbe.status !== 0) {
  hardFail(
    "gitleaks not installed",
    `gitleaks binary not found on PATH. Install it (apt-get install -y gitleaks) ` +
      `or remove this gate from develop.ts if you accept the regex-only coverage.`
  );
}
log(`gitleaks protect --staged`);
const glR = spawnSync(
  "gitleaks",
  ["protect", "--staged", "--no-banner", "--redact", "--exit-code", "1"],
  { cwd: wt, encoding: "utf-8" }
);
if (glR.status !== 0) {
  // exit 1 = leaks found; anything else = gitleaks crashed.
  const reason = glR.status === 1 ? "secrets detected in staged diff" : `gitleaks crashed (exit ${glR.status})`;
  hardFail(
    `gitleaks: ${reason}`,
    ((glR.stdout ?? "") + "\n" + (glR.stderr ?? "")).slice(-3000)
  );
}

// ── Gate 3: Plan/diff alignment ──────────────────────────────────────
// `plan.files_to_change` and `plan.files_to_create` are the agent's contract.
// Files the agent touches must be within the allowed set, with a small
// allowance for adjacent test files. We do NOT enforce alignment when the
// plan was vague (empty file lists) — that's a separate signal handled by
// the no-op short-circuit earlier in develop.ts.
const planChange: string[] = Array.isArray(plan.files_to_change) ? plan.files_to_change.filter((s: unknown) => typeof s === "string") : [];
const planCreate: string[] = Array.isArray(plan.files_to_create) ? plan.files_to_create.filter((s: unknown) => typeof s === "string") : [];
const planSet = new Set<string>([...planChange, ...planCreate]);

if (planSet.size > 0) {
  // Whether the plan touches anything under src/ — if it does, tests in
  // src/__tests__/ are presumed-related and allowed without needing a
  // stem match. Tests in this repo cross-cut multiple src/ files (e.g.
  // dashboard-morph.test.ts exercises behavior that lives in
  // dashboard-client.js + global-dashboard.ts), so requiring an exact
  // stem pair was too strict and forced retries on legitimate work.
  const planTouchesSrc = [...planSet].some((p) => /^src\//.test(p));

  function isAllowed(path: string): boolean {
    if (planSet.has(path)) return true;

    // Direct stem pair: src/foo.{ts,js} → src/__tests__/foo.test.ts
    const stemPairFor = (p: string) => {
      const m = p.match(/^src\/(.+)\.(?:ts|tsx|js|jsx)$/);
      if (!m) return null;
      return `src/__tests__/${m[1]}.test.ts`;
    };
    for (const planned of planSet) {
      const t = stemPairFor(planned);
      if (t && path === t) return true;
    }

    // Any src/__tests__/*.test.ts is allowed if the plan touches src/ at all.
    // Tests in this repo cross-reference multiple src files; an exact-stem
    // requirement causes false-positive off-plan failures on legitimate work.
    if (planTouchesSrc && /^src\/__tests__\/.+\.test\.(?:ts|tsx|js|jsx)$/.test(path)) {
      return true;
    }

    // Co-located test files: src/foo/bar/baz.test.ts allowed if any planned
    // file is in the same folder (e.g. src/foo/bar/anything.ts).
    const colocated = path.match(/^(.*)\/[^/]+\.test\.(?:ts|tsx|js|jsx)$/);
    if (colocated) {
      const folder = colocated[1];
      for (const planned of planSet) {
        if (planned.startsWith(folder + "/")) return true;
      }
    }
    return false;
  }
  const offPlan = changedFiles.filter((f) => !isAllowed(f));
  if (offPlan.length > 0) {
    const planned = [...planSet].map((p) => `  - ${p}`).join("\n");
    const off = offPlan.map((p) => `  - ${p}`).join("\n");
    hardFail(
      "off-plan files in diff",
      `Changed files extend beyond plan.files_to_change ∪ plan.files_to_create.\n` +
        `Planned:\n${planned}\nOff-plan:\n${off}\n` +
        `If the additional files are legitimate, update the plan or relax the gate in develop.ts.`
    );
  }
}

// ── Ensure dev deps exist in the worktree for typecheck/lint ─────────
// The worktree shares .git with the main checkout but starts with no
// node_modules. `bun install` is idempotent and fast when the global cache
// is warm. (The repo gitignores bun.lock, so --frozen-lockfile isn't an
// option; we resolve from package.json on each run.)
log(`bun install (deps for typecheck + lint)`);
const installR = spawnSync("bun", ["install"], {
  cwd: wt,
  encoding: "utf-8",
  timeout: 120_000,
});
if (installR.status !== 0) {
  hardFail(
    "bun install failed in worktree",
    `cwd=${wt}\n${(installR.stdout ?? "") + "\n" + (installR.stderr ?? "")}`
  );
}

// ── Gate 4: Typecheck (soft — failure routes through eval retry) ────
//
// Typecheck and lint were hardFails until 2026-05-21. That made them
// crash-class failures that the orchestrator retried by re-spawning
// develop with NO feedback to the agent — the agent re-ran with the
// same file state and produced the same code, looping until max
// retries. We now capture the failure into the envelope so eval.ts
// can emit action:retry with the actual error text as feedback,
// which develop.ts threads back into the agent's prompt on next run.
log(`bun run typecheck`);
const tscR = spawnSync("bun", ["run", "typecheck"], {
  cwd: wt,
  encoding: "utf-8",
  timeout: 120_000,
});
const typecheckPassed = tscR.status === 0;
const typecheckOutput = typecheckPassed
  ? ""
  : ((tscR.stdout ?? "") + "\n" + (tscR.stderr ?? "")).slice(-3000);
if (!typecheckPassed) {
  log(`typecheck failed (exit ${tscR.status}) — deferring to eval for retry-with-feedback`);
}

// ── Gate 5a: Auto-fix what's auto-fixable ────────────────────────────
//
// Run eslint --fix BEFORE the lint check. Trivial issues like unused
// imports, missing semicolons, or stale formatting are stamped out
// automatically — no agent retry needed. After fix, re-stage so any
// fix-touched files land in the upcoming commit.
log(`bun run lint:fix (auto-fix trivially-fixable issues)`);
spawnSync("bun", ["run", "lint:fix"], { cwd: wt, encoding: "utf-8", timeout: 120_000 });
spawnSync("git", ["-C", wtRoot, "add", "-A"], { encoding: "utf-8" });

// ── Gate 5b: Lint (soft — failure routes through eval retry) ────────
log(`bun run lint`);
const lintR = spawnSync("bun", ["run", "lint"], {
  cwd: wt,
  encoding: "utf-8",
  timeout: 120_000,
});
const lintPassed = lintR.status === 0;
const lintOutput = lintPassed
  ? ""
  : ((lintR.stdout ?? "") + "\n" + (lintR.stderr ?? "")).slice(-3000);
if (!lintPassed) {
  log(`lint failed (exit ${lintR.status}) — deferring to eval for retry-with-feedback`);
}

// ─── Run tests ────────────────────────────────────────────────────────

log(`running bun test`);
const testR = spawnSync("bun", ["test"], { cwd: wt, encoding: "utf-8", timeout: 180_000 });
let testOut = ((testR.stdout ?? "") + "\n" + (testR.stderr ?? "")).slice(-4000);
let testsPassed = testR.status === 0;
if (!testsPassed) {
  log(`tests failed (exit ${testR.status})`);
}

// ─── Commit ───────────────────────────────────────────────────────────

// Re-check porcelain — eslint --fix above may have modified files.
const porcelainAfterFix = (spawnSync("git", ["-C", wtRoot, "status", "--porcelain"], { encoding: "utf-8" }).stdout ?? "").trim();
const hasUncommitted = !!porcelainAfterFix;

let commitSha = "";
if (hasUncommitted) {
  log(`committing staged changes (already staged by safety gates)`);
  const msg = `feat(assembly): ${agentSummary.slice(0, 100)}\n\nAutomated commit by develop station for workpiece ${wpId}.`;
  const commitR = spawnSync(
    "git",
    [
      "-C", wtRoot,
      "-c", "user.name=assembly-dev",
      "-c", "user.email=assembly-dev@local",
      "commit", "-m", msg,
    ],
    { encoding: "utf-8" }
  );
  if (commitR.status !== 0) {
    hardFail(
      "git commit failed",
      `branch=${branch} worktree=${wtRoot} tests_passed=${testsPassed}\n${commitR.stderr ?? ""}\n${testOut}`
    );
  }
}

const shaR = spawnSync("git", ["-C", wtRoot, "rev-parse", "HEAD"], { encoding: "utf-8" });
commitSha = (shaR.stdout ?? "").trim();

// Sanity: HEAD must be ahead of main now
const aheadR = spawnSync("git", ["-C", wtRoot, "log", "main..HEAD", "--oneline"], { encoding: "utf-8" });
if (!(aheadR.stdout ?? "").trim()) {
  hardFail(
    "no commits ahead of main after commit",
    `HEAD=${commitSha} branch=${branch} worktree=${wtRoot} tests_passed=${testsPassed}\n${testOut}`
  );
}

// ─── Pre-merge with main: surface conflicts here, not in deploy ──────
//
// deploy.ts does `git merge <branch> --no-ff` on main and hardFails on
// conflicts — and the orchestrator just retries deploy, which hits the
// same conflict every time. We pre-resolve here, where the agent
// context is still fresh and where retry-with-feedback already works:
//
//   1. `git merge main --no-edit --no-ff` inside the worktree.
//   2. Clean / fast-forward / already-up-to-date → continue.
//   3. Conflicts → spawn a focused resolution agent, verify markers
//      gone, stage + commit the merge. Re-run tests on the merged tree.
//
// After this step, `commit_sha` points at the post-merge HEAD; deploy's
// later `git merge <branch> --no-ff` on main becomes a clean fast-
// forward-able merge (no conflicts since main is already in the branch).

log(`pre-merge: bringing main into branch ${branch}`);
const preMergeCommitMsg = `Merge main into ${branch} to pre-resolve before deploy`;
const preMergeR = spawnSync(
  "git",
  [
    "-C", wtRoot,
    "-c", "user.name=assembly-dev",
    "-c", "user.email=assembly-dev@local",
    "merge", "main", "--no-edit", "--no-ff", "-m", preMergeCommitMsg,
  ],
  { encoding: "utf-8" }
);

let preMergeResolved = false;
if (preMergeR.status !== 0) {
  const conflictsR = spawnSync(
    "git",
    ["-C", wtRoot, "diff", "--name-only", "--diff-filter=U"],
    { encoding: "utf-8" }
  );
  const conflictedFiles = ((conflictsR.stdout ?? "").trim().split("\n")).filter(Boolean);

  if (conflictedFiles.length === 0) {
    spawnSync("git", ["-C", wtRoot, "merge", "--abort"], { encoding: "utf-8" });
    hardFail(
      "pre-merge failed without reporting conflicts",
      `${preMergeR.stdout ?? ""}\n${preMergeR.stderr ?? ""}`
    );
  }

  log(`pre-merge conflicts in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);

  const resolveSystemPrompt = `You are a senior developer resolving merge conflicts inside an Assembly framework worktree.

## Your cwd IS the worktree
- You are running at: ${wt}
- The worktree just attempted \`git merge main --no-edit --no-ff\` and hit content conflicts.
- The conflicted files have \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers.
- Do NOT edit anything under ${REPO} — that is a DIFFERENT checkout.
- Do NOT run git commands. The script around you will stage and commit after you finish. NO \`git add\`, \`git commit\`, \`git merge\`, \`git reset\`, etc.

## Your job
For each conflicted file: read it, understand BOTH sides, write a merged version with no markers that preserves the intent of both. The branch's new work and main's drift both matter — don't drop either. If two sides edit the same logical block, integrate them.

## Conflicted files
${conflictedFiles.map((f) => `- ${f}`).join("\n")}

## Verification
After editing each file, re-read it and confirm no \`<<<<<<<\`, \`=======\` (between markers), or \`>>>>>>>\` lines remain. The script will reject files with leftover markers and hardFail.

Only edit the conflicted files listed above. Auto-merged files are already staged correctly — do not touch them.`;

  const resolveUserMsg = [
    `# Merge-conflict resolution`,
    ``,
    `\`git merge main --no-edit --no-ff\` produced content conflicts in:`,
    ...conflictedFiles.map((f) => `- ${f}`),
    ``,
    `Resolve each by editing out the markers while preserving both sides' intent. Refer to the original task and plan below for context on what the branch was trying to accomplish.`,
    ``,
    `# Original task`,
    wp.task,
    ``,
    `# Plan summary`,
    wp.stations?.plan?.summary ?? "(no summary)",
  ].join("\n");

  if (existsSync(envelopePath)) {
    try { unlinkSync(envelopePath); } catch {}
  }

  log(`spawning claude for conflict resolution model=${MODEL}`);
  const resolveProc = Bun.spawn(["claude", ...claudeArgs], {
    cwd: wt,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const resolvePayload = JSON.stringify({
    type: "user",
    system: resolveSystemPrompt,
    message: { role: "user", content: resolveUserMsg },
  }) + "\n";
  resolveProc.stdin.write(resolvePayload);
  await resolveProc.stdin.end();

  let resolveBuffer = "";
  const resolveReader = resolveProc.stdout.getReader();
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
    spawnSync("git", ["-C", wtRoot, "merge", "--abort"], { encoding: "utf-8" });
    hardFail(
      "conflict-resolution agent exited non-zero",
      `exit=${resolveExit}\n${resolveStderr.slice(-2000)}`
    );
  }

  // Verify markers gone in every conflicted file.
  const markerLeftovers: string[] = [];
  for (const f of conflictedFiles) {
    const absPath = resolvePath(wt, f);
    if (!existsSync(absPath)) {
      // Both sides deleted the file or agent removed it — accept the deletion.
      continue;
    }
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
    spawnSync("git", ["-C", wtRoot, "merge", "--abort"], { encoding: "utf-8" });
    hardFail(
      "conflict markers remain after resolution agent",
      `Files still containing markers:\n${markerLeftovers.map((f) => `  ${f}`).join("\n")}\n` +
        `Agent did not fully resolve the conflicts.`
    );
  }

  // Stage resolved files and complete the merge commit.
  const addR = spawnSync(
    "git",
    ["-C", wtRoot, "add", "--", ...conflictedFiles],
    { encoding: "utf-8" }
  );
  if (addR.status !== 0) {
    spawnSync("git", ["-C", wtRoot, "merge", "--abort"], { encoding: "utf-8" });
    hardFail(
      "git add of resolved conflict files failed",
      `${addR.stdout ?? ""}\n${addR.stderr ?? ""}`
    );
  }

  const mergeCommitR = spawnSync(
    "git",
    [
      "-C", wtRoot,
      "-c", "user.name=assembly-dev",
      "-c", "user.email=assembly-dev@local",
      "commit", "--no-edit",
    ],
    { encoding: "utf-8" }
  );
  if (mergeCommitR.status !== 0) {
    hardFail(
      "git commit of merge resolution failed",
      `${mergeCommitR.stdout ?? ""}\n${mergeCommitR.stderr ?? ""}`
    );
  }

  preMergeResolved = true;
  log(`pre-merge conflicts resolved across ${conflictedFiles.length} file(s)`);

  if (existsSync(envelopePath)) {
    try { unlinkSync(envelopePath); } catch {}
  }
} else {
  // mergeR.status === 0 — either fast-forward, no-op (Already up to date),
  // or clean auto-merge. The stdout tells us which but we don't care.
  log(`pre-merge clean: ${(preMergeR.stdout ?? "").trim().split("\n")[0] ?? "ok"}`);
}

// Refresh commitSha — merge or merge-commit may have moved HEAD.
const postMergeShaR = spawnSync("git", ["-C", wtRoot, "rev-parse", "HEAD"], { encoding: "utf-8" });
commitSha = (postMergeShaR.stdout ?? "").trim();

// Re-run tests after merging main in — automerged code or our resolution
// may have introduced semantic breakage even if markers are gone.
if (preMergeResolved || preMergeR.status === 0) {
  // Only re-run if main actually contributed something. "Already up to
  // date" leaves HEAD unchanged, so the earlier run is still valid.
  const ahead2R = spawnSync("git", ["-C", wtRoot, "log", "main..HEAD", "--oneline"], { encoding: "utf-8" });
  const aheadCount = (ahead2R.stdout ?? "").trim().split("\n").filter(Boolean).length;
  // After a real merge, branch has at least 2 commits ahead of main (the
  // agent's commit + the merge commit). After "Already up to date", it
  // has the original single commit and re-testing is wasteful.
  if (preMergeResolved || aheadCount > 1) {
    log(`re-running bun test on post-merge HEAD=${commitSha.slice(0, 8)}`);
    const reTestR = spawnSync("bun", ["test"], { cwd: wt, encoding: "utf-8", timeout: 180_000 });
    testOut = ((reTestR.stdout ?? "") + "\n" + (reTestR.stderr ?? "")).slice(-4000);
    testsPassed = reTestR.status === 0;
    if (!testsPassed) {
      log(`post-merge tests failed (exit ${reTestR.status}) — deferring to eval for retry-with-feedback`);
    }
  }
}

// Test failures are no longer hardFailed here — they route through eval
// like lint and typecheck (above), so the next develop attempt sees the
// failing test output as agent feedback. eval.ts re-runs the suite and
// emits action:retry with the output when any of {tests, typecheck,
// lint} are failing.
if (!testsPassed) {
  log(`tests failed — deferring to eval for retry-with-feedback`);
}

// ─── Emit envelope ────────────────────────────────────────────────────

const filesChanged = Array.isArray(agentData.files_changed) ? agentData.files_changed : [];
const filesCreated = Array.isArray(agentData.files_created) ? agentData.files_created : [];

emit({
  summary: agentSummary,
  content: agentContent,
  data: {
    branch_name: branch,
    worktree_path: wtRoot,
    files_changed: filesChanged,
    files_created: filesCreated,
    tests_passed: testsPassed,
    test_output: testOut,
    commit_sha: commitSha,
    // Quality-gate results — surfaced for eval.ts to decide retry vs pass.
    typecheck_passed: typecheckPassed,
    typecheck_output: typecheckOutput,
    lint_passed: lintPassed,
    lint_output: lintOutput,
  },
});
