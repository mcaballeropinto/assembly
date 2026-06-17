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
import { callLLM } from "../../../../src/llm";
import type { LLMMessage, ProgressCallback } from "../../../../src/types";
import { bootstrapStationEnv, resolveAssemblyRepoRoot } from "../../../../src/assembly-dev-station-utils";

bootstrapStationEnv();

let REPO: string;
try {
  REPO = resolveAssemblyRepoRoot(import.meta.dir);
  process.env.ASSEMBLY_REPO_ROOT = REPO;
} catch (e) {
  process.stderr.write(`[develop] ${(e as Error).message}\n`);
  process.exit(2);
}
const MODEL = process.env.ASSEMBLY_DEV_MODEL ?? "reasoning";

// Base branch new feature branches fork from + that deploy merges into.
// Default "main" preserves the pre-2026-05-26 single-clone behavior; assembly's
// setup overrides with ASSEMBLY_DEPLOY_BRANCH=production once REPO is split
// from the user's personal /root/assembly checkout.
const BASE = process.env.ASSEMBLY_DEPLOY_BRANCH ?? "main";

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

async function runCodexAgent(
  phase: string,
  system: string,
  user: string,
  cwd: string,
  envelopeFile?: string
) {
  const onProgress: ProgressCallback = (evt) => {
    log(
      `${phase}.${evt.tool ?? "progress"} ${evt.detail}` +
        (evt.tool_input ? ` ${evt.tool_input}` : "")
    );
  };
  const logger = (event: string, detail: Record<string, unknown>) => {
    log(`${phase}.${event} ${JSON.stringify(detail).slice(0, 500)}`);
  };
  const messages: LLMMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  return await callLLM(
    messages,
    MODEL,
    32768,
    [],
    "codex",
    onProgress,
    undefined,
    logger,
    undefined,
    ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    envelopeFile,
    undefined,
    cwd
  );
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
// Either way: no worktree, no Codex spawn, no tests, no commit. The flag
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
    content: `Develop skipped — plan signalled no_op (explicit or inferred from empty file lists).\n\nReason: ${noOp.reason}\n\nNo worktree, no Codex spawn, no tests, no commit.`,
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

// Clear git metadata for deleted /tmp worktrees before branch claiming.
// Without this, retries can fail with "branch is already used by worktree"
// even when the path is gone and marked prunable by `git worktree list`.
const pruneR = spawnSync("git", ["-C", REPO, "worktree", "prune"], { encoding: "utf-8" });
if (pruneR.status !== 0) {
  hardFail("git worktree prune failed", pruneR.stderr ?? "");
}

// Auto-cleanup of stale worktrees holding the same branch.
//
// Plan generates content-based branch names (e.g. assembly-dev/station-
// health-indicator), so retries of the same task — or re-runs of similar
// tasks — try to claim a branch already checked out in a leftover
// worktree from a prior failed run. `git worktree add` refuses with
// "branch X is already used by worktree at Y". We auto-remove any such
// orphan if its branch has NO commits ahead of BASE (i.e. the agent's
// session produced no committed work — just transient edits that
// already cost us a failed run). Worktrees with real ahead-of-BASE
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
  const aheadR = spawnSync("git", ["-C", REPO, "log", `${BASE}..${branch}`, "--oneline"], { encoding: "utf-8" });
  const aheadOfBase = (aheadR.stdout ?? "").trim();
  if (!aheadOfBase) {
    log(`stale worktree at ${stalePath} holds branch ${branch} with no commits ahead of ${BASE} — removing`);
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", stalePath], { encoding: "utf-8" });
    spawnSync("git", ["-C", REPO, "branch", "-D", branch], { encoding: "utf-8" });
  } else {
    hardFail(
      "branch already checked out in another worktree with unmerged commits",
      `branch=${branch} stale_worktree=${stalePath}\n` +
        `That worktree has commits ahead of ${BASE} — refusing to auto-remove.\n` +
        `Inspect the commits there and either merge them, abandon the branch ` +
        `(git -C ${REPO} worktree remove --force ${stalePath} && git -C ${REPO} branch -D ${branch}), ` +
        `or pick a different branch name in the plan.\n` +
        `Commits ahead of ${BASE}:\n${aheadOfBase}`
    );
  }
}

if (existsSync(wtRoot)) {
  log(`removing previous worktree for fresh develop attempt`);
  const removeR = spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", wtRoot], { encoding: "utf-8" });
  if (removeR.status !== 0) {
    hardFail("git worktree remove failed", `worktree=${wtRoot}\n${removeR.stderr}`);
  }
  spawnSync("git", ["-C", REPO, "worktree", "prune"], { encoding: "utf-8" });
}

const branchExists = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", branch]).status === 0;
const args = branchExists
  ? ["-C", REPO, "worktree", "add", wtRoot, branch]
  : ["-C", REPO, "worktree", "add", wtRoot, "-b", branch, BASE];
const r = spawnSync("git", args, { encoding: "utf-8" });
if (r.status !== 0) {
  hardFail("git worktree add failed", `branch=${branch}\n${r.stderr}`);
}
log(`fresh worktree created`);

if (!existsSync(wt) || !statSync(wt).isDirectory()) {
  hardFail("worktree missing", `expected ${wt}; branch=${branch}`);
}

function restoreOffPlanFiles(paths: string[]): void {
  if (paths.length === 0) return;
  log(`restoring ${paths.length} off-plan file(s) after plan-alignment failure: ${paths.join(", ")}`);
  for (const path of paths) {
    const headHasPath = spawnSync("git", ["-C", wtRoot, "cat-file", "-e", `HEAD:${path}`], { encoding: "utf-8" }).status === 0;
    if (headHasPath) {
      spawnSync("git", ["-C", wtRoot, "restore", "--staged", "--worktree", "--", path], { encoding: "utf-8" });
    } else {
      spawnSync("git", ["-C", wtRoot, "rm", "-f", "--cached", "--ignore-unmatch", "--", path], { encoding: "utf-8" });
      spawnSync("git", ["-C", wtRoot, "clean", "-fd", "--", path], { encoding: "utf-8" });
    }
  }
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

## Repository guidance
Before editing, read \`AGENTS.md\`. If your task touches AI/contributor
behavior, test stability, generated bundles, or deploy hygiene, also read
\`docs/ai-agent-guidelines.md\` and follow it.

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

// ─── Spawn codex with cwd=worktree ────────────────────────────────────

// Clear any stale envelope from a prior failed run in this worktree —
// otherwise we'd read the old agent's output and skip the live one's failure.
if (existsSync(envelopePath)) {
  try { unlinkSync(envelopePath); } catch {}
}

log(`spawning codex cwd=${wt} model=${MODEL} envelope=${envelopePath}`);

try {
  await runCodexAgent("codex", systemPrompt, userMsg, wt, envelopePath);
} catch (e) {
  hardFail(
    "codex exited non-zero",
    `branch=${branch} worktree=${wtRoot}\n${String((e as Error).message ?? e).slice(-2000)}`
  );
}

function worktreeHasChanges(): boolean {
  const statusR = spawnSync("git", ["-C", wtRoot, "status", "--porcelain"], { encoding: "utf-8" });
  const porcelain = (statusR.stdout ?? "").trim();
  const logR = spawnSync("git", ["-C", wtRoot, "log", `${BASE}..HEAD`, "--oneline"], { encoding: "utf-8" });
  const aheadOfBase = (logR.stdout ?? "").trim();
  return Boolean(porcelain || aheadOfBase);
}

if (!worktreeHasChanges()) {
  log("codex returned a clean worktree for a non-no-op plan — running one repair pass");
  try { unlinkSync(envelopePath); } catch {}
  const repairMsg = [
    userMsg,
    "",
    "# Repair feedback",
    "Your previous attempt exited without changing any files or creating a commit.",
    "This plan is not marked no-op. Re-read the implementation steps and make the requested edits now.",
    "If the requested work is already present, write .envelope.json with data.no_op=true and a no_op_reason explaining the exact existing implementation.",
  ].join("\n");
  try {
    await runCodexAgent("codex-repair", systemPrompt, repairMsg, wt, envelopePath);
  } catch (e) {
    hardFail(
      "codex repair exited non-zero",
      `branch=${branch} worktree=${wtRoot}\n${String((e as Error).message ?? e).slice(-2000)}`
    );
  }
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
    ["-C", wtRoot, "diff", "--name-status", `${BASE}...HEAD`],
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
  // Branch commits ahead of BASE — diff --name-status: "A\tname" / "M\tname" / "D\tname"
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

if (agentEnv?.data?.no_op === true && !worktreeHasChanges()) {
  const reason = typeof agentEnv.data.no_op_reason === "string"
    ? agentEnv.data.no_op_reason
    : "agent reported no-op after inspecting the worktree";
  log(`no-op from agent: ${reason}`);
  emit({
    summary: `No-op: ${reason.slice(0, 140)}`,
    content: `Develop skipped after agent inspection.\n\nReason: ${reason}\n\nNo commit was created.`,
    data: {
      no_op: true,
      no_op_reason: reason,
      branch_name: "",
      worktree_path: "",
      commit_sha: "",
      files_changed: [],
      files_created: [],
      tests_passed: true,
    },
  });
}

const agentSummary: string = agentEnv.summary;
const agentContent: string = agentEnv.content;
const agentData = agentEnv.data as Record<string, unknown>;

// ─── Soft gate failure helper ─────────────────────────────────────────
// Captures a gate failure in the envelope so eval.ts can format retry-with-
// feedback, which develop.ts threads into the agent's prompt on the next run.
// This mirrors the typecheck/lint soft-failure pattern (line 799 onwards).
let gateFailed = false;
function softGateFail(gate: string, details: string): void {
  log(`gate '${gate}' failed (soft) — deferring to eval for retry-with-feedback`);
  if (!agentEnv.data) agentEnv.data = {};
  agentEnv.data.gate_failure = { gate, details: details.slice(0, 3000) };
  agentEnv.data.tests_passed = false;
  gateFailed = true;
}

// ─── Verify there are actual changes in the worktree ──────────────────

const statusR = spawnSync("git", ["-C", wtRoot, "status", "--porcelain"], { encoding: "utf-8" });
const porcelain = (statusR.stdout ?? "").trim();
const logR = spawnSync("git", ["-C", wtRoot, "log", `${BASE}..HEAD`, "--oneline"], { encoding: "utf-8" });
const aheadOfBase = (logR.stdout ?? "").trim();

if (!porcelain && !aheadOfBase) {
  hardFail(
    "no changes in worktree",
    `agent produced no file changes and no new commits after the repair pass. cwd=${wt} branch=${branch}\nagent_summary=${agentSummary}`
  );
}

// ─── Safety gates ─────────────────────────────────────────────────────
//
// Run BEFORE tests/commit. Each gate hardFails on violation so the agent's
// changes never reach BASE. Cheap gates run first.
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
    softGateFail("envelope-scope", [
      `agent_summary=${agentSummary}`,
      `envelope.files_changed=${JSON.stringify(claimedChanged)}`,
      `envelope.files_created=${JSON.stringify(claimedCreated)}`,
      `actual changed files (${changedFiles.length}):`,
      ...changedFiles.slice(0, 30).map((f) => `  ${f}`),
      changedFiles.length > 30 ? `  ... and ${changedFiles.length - 30} more` : "",
    ].filter(Boolean).join("\n"));
  }

  // Belt-and-suspenders: at least one claimed path must exist in the actual
  // diff. An agent that fabricates a totally unrelated file list is also bad
  // news. We compare basenames to tolerate path-normalization differences.
  if (changedFiles.length > 0 && claimedAll.size > 0) {
    const actualBasenames = new Set(changedFiles.map((f) => f.split("/").pop()!));
    const claimedBasenames = [...claimedAll].map((f) => f.split("/").pop()!);
    const overlap = claimedBasenames.some((b) => actualBasenames.has(b));
    if (!overlap) {
      softGateFail("envelope-scope", [
        `envelope.files_changed+files_created=${JSON.stringify([...claimedAll])}`,
        `actual changed files (${changedFiles.length}):`,
        ...changedFiles.slice(0, 30).map((f) => `  ${f}`),
      ].join("\n"));
    }
  }
}

// Skip remaining gates after a soft failure — the agent can only fix one feedback loop at a time.
if (gateFailed) {
  log(`skipping remaining safety gates — soft gate failure already recorded`);
}

// ── Gate 1: Path blocklist ───────────────────────────────────────────
if (!gateFailed) {
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
}

// ── Gate 2: Secret scan ──────────────────────────────────────────────
if (!gateFailed) {
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
}

// ── Gate 3: Plan/diff alignment ──────────────────────────────────────
if (!gateFailed) {
// `plan.files_to_change` and `plan.files_to_create` are the agent's contract.
// Files the agent touches must be within the allowed set, with a small
// allowance for adjacent test files. We do NOT enforce alignment when the
// plan was vague (empty file lists) — that's a separate signal handled by
// the no-op short-circuit earlier in develop.ts.
const planChange: string[] = Array.isArray(plan.files_to_change) ? plan.files_to_change.filter((s: unknown) => typeof s === "string") : [];
const planCreate: string[] = Array.isArray(plan.files_to_create) ? plan.files_to_create.filter((s: unknown) => typeof s === "string") : [];
function normalizePlanPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return normalized;
}

const planSpecs = [...planChange, ...planCreate].map(normalizePlanPath).filter((s): s is string => s !== null);
const planSet = new Set<string>(planSpecs);

if (planSet.size > 0) {
  // Whether the plan touches anything under src/ — if it does, tests in
  // src/__tests__/ are presumed-related and allowed without needing a
  // stem match. Tests in this repo cross-cut multiple src/ files (e.g.
  // dashboard-morph.test.ts exercises behavior that lives in
  // dashboard-client.js + global-dashboard.ts), so requiring an exact
  // stem pair was too strict and forced retries on legitimate work.
  const planTouchesSrc = [...planSet].some((p) => /^src\//.test(p));

  function isAllowed(path: string): boolean {
    const normalizedPath = normalizePlanPath(path);
    if (!normalizedPath) return false;
    if (planSet.has(normalizedPath)) return true;

    for (const planned of planSet) {
      if (planned.endsWith("/**")) {
        const prefix = planned.slice(0, -2);
        if (normalizedPath.startsWith(prefix) && normalizedPath.length > prefix.length) return true;
      }
      if (planned.endsWith("/")) {
        if (normalizedPath.startsWith(planned) && normalizedPath.length > planned.length) return true;
      }
      // Directory specs are sometimes normalized without a trailing slash
      // (`web/dist` instead of `web/dist/`). Treat extensionless planned
      // paths as directory prefixes so generated assets do not false-positive.
      if (!planned.split("/").pop()?.includes(".")) {
        const prefix = planned + "/";
        if (normalizedPath.startsWith(prefix) && normalizedPath.length > prefix.length) return true;
      }
    }

    // Dashboard builds generate hashed asset names. Any explicit web/dist
    // plan entry should cover all descendants, even if the planner omitted
    // the trailing slash.
    if ((planSet.has("web/dist") || planSet.has("web/dist/")) && normalizedPath.startsWith("web/dist/")) {
      return true;
    }

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
    softGateFail("plan-alignment",
      `Changed files extend beyond plan.files_to_change ∪ plan.files_to_create.\n` +
        `Planned:\n${planned}\nOff-plan:\n${off}\n` +
        `Do NOT touch these off-plan files on the next attempt. Restrict edits to the files listed in the plan.`);
    restoreOffPlanFiles(offPlan);
  }
}
}

// ── Skip build/test/commit after soft gate failure ───────────────────
// When a soft gate has fired, skip downstream work and emit the envelope
// with the gate_failure captured. The agent can only fix one feedback loop
// at a time — no point building/testing code that violates the gate.

// Declare variables used in emit() that are conditionally initialized below.
let typecheckPassed: boolean | undefined = undefined;
let typecheckOutput: string | undefined = undefined;
let lintPassed: boolean | undefined = undefined;
let lintOutput: string | undefined = undefined;
let testsPassed = false;
let testOut = "(skipped — gate failure)";
let commitSha = "";

if (!gateFailed) {

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
typecheckPassed = tscR.status === 0;
typecheckOutput = typecheckPassed
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
lintPassed = lintR.status === 0;
lintOutput = lintPassed
  ? ""
  : ((lintR.stdout ?? "") + "\n" + (lintR.stderr ?? "")).slice(-3000);
if (!lintPassed) {
  log(`lint failed (exit ${lintR.status}) — deferring to eval for retry-with-feedback`);
}

// ─── Run tests ────────────────────────────────────────────────────────

const REQUIRED_TESTS = ["src/__tests__/improver.test.ts"];
log(`running bun test ${REQUIRED_TESTS.join(" ")}`);
const targetedTestR = spawnSync("bun", ["test", ...REQUIRED_TESTS], {
  cwd: wt,
  encoding: "utf-8",
  timeout: 300_000,
});
const targetedTestOut = (targetedTestR.stdout ?? "") + "\n" + (targetedTestR.stderr ?? "");
if (targetedTestR.status !== 0) {
  testsPassed = false;
  testOut = targetedTestOut.slice(-4000);
  log(`required improver tests failed (exit ${targetedTestR.status})`);
}

log(`running bun test`);
const testR = spawnSync("bun", ["test"], { cwd: wt, encoding: "utf-8", timeout: 180_000 });
const fullTestOut = (testR.stdout ?? "") + "\n" + (testR.stderr ?? "");
testOut = (targetedTestR.status === 0 ? fullTestOut : `${targetedTestOut}\n\n${fullTestOut}`).slice(-4000);
testsPassed = targetedTestR.status === 0 && testR.status === 0;
if (!testsPassed) {
  log(`tests failed (exit ${testR.status})`);
}

// ─── Commit ───────────────────────────────────────────────────────────

// Re-check porcelain — eslint --fix above may have modified files.
const porcelainAfterFix = (spawnSync("git", ["-C", wtRoot, "status", "--porcelain"], { encoding: "utf-8" }).stdout ?? "").trim();
const hasUncommitted = !!porcelainAfterFix;

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

// Sanity: HEAD must be ahead of BASE now
const aheadR = spawnSync("git", ["-C", wtRoot, "log", `${BASE}..HEAD`, "--oneline"], { encoding: "utf-8" });
if (!(aheadR.stdout ?? "").trim()) {
  hardFail(
    `no commits ahead of ${BASE} after commit`,
    `HEAD=${commitSha} branch=${branch} worktree=${wtRoot} tests_passed=${testsPassed}\n${testOut}`
  );
}

// ─── Pre-rebase onto origin/BASE: surface conflicts here, not in deploy ─
//
// Linear history: feature's commit(s) get re-applied on top of the latest
// origin/${BASE}, no merge commits. Mirrors deploy's rebase — by surfacing
// conflicts here (with fresh agent context + the retry-with-feedback path
// already wired) we avoid them landing on deploy.
//
// Flow:
//   1. `git fetch origin ${BASE}` so origin/${BASE} is current.
//   2. `git rebase origin/${BASE}` inside the worktree.
//   3. Clean (already on top, or no overlap) → continue.
//   4. Rebase pause (conflict) → spawn focused resolution agent, verify
//      markers gone, `git add` + `git rebase --continue`. Loop until
//      rebase exits 0 (each iteration handles one paused commit).
//
// After this step, `commit_sha` points at the post-rebase HEAD. Deploy's
// later rebase against origin/${BASE} is a no-op (feature already on top).

log(`pre-rebase: fetching origin/${BASE}`);
const fetchPreRebaseR = spawnSync(
  "git",
  ["-C", wtRoot, "fetch", "origin", BASE],
  { encoding: "utf-8" }
);
if (fetchPreRebaseR.status !== 0) {
  hardFail(
    `git fetch origin ${BASE} failed`,
    `${fetchPreRebaseR.stdout ?? ""}\n${fetchPreRebaseR.stderr ?? ""}`
  );
}

log(`pre-rebase: rebasing ${branch} onto origin/${BASE}`);
let preRebaseR = spawnSync(
  "git",
  [
    "-C", wtRoot,
    "-c", "user.name=assembly-dev",
    "-c", "user.email=assembly-dev@local",
    "-c", "core.editor=true",
    "rebase", `origin/${BASE}`,
  ],
  { encoding: "utf-8" }
);

let preRebaseResolved = false;
let preRebaseResolutionCount = 0;
const MAX_REBASE_RESOLUTIONS = 20;

while (preRebaseR.status !== 0 && preRebaseResolutionCount < MAX_REBASE_RESOLUTIONS) {
  const conflictsR = spawnSync(
    "git",
    ["-C", wtRoot, "diff", "--name-only", "--diff-filter=U"],
    { encoding: "utf-8" }
  );
  const conflictedFiles = ((conflictsR.stdout ?? "").trim().split("\n")).filter(Boolean);

  if (conflictedFiles.length === 0) {
    spawnSync("git", ["-C", wtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    hardFail(
      "pre-rebase failed without reporting conflicts",
      `${preRebaseR.stdout ?? ""}\n${preRebaseR.stderr ?? ""}`
    );
  }

  preRebaseResolutionCount++;
  log(`pre-rebase pause #${preRebaseResolutionCount}: conflicts in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);

  const resolveSystemPrompt = `You are a senior developer resolving rebase conflicts inside an Assembly framework worktree.

## Your cwd IS the worktree
- You are running at: ${wt}
- The worktree is mid-rebase: \`git rebase origin/${BASE}\` paused on a conflicted commit.
- The conflicted files have \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers (HEAD = origin/${BASE}'s tip; the incoming side is your feature's commit being replayed).
- Do NOT edit anything under ${REPO} — that is a DIFFERENT checkout.
- Do NOT run git commands. The script around you will stage and continue the rebase after you finish. NO \`git add\`, \`git commit\`, \`git rebase\`, \`git reset\`, etc.

## Your job
For each conflicted file: read it, understand BOTH sides, write a merged version with no markers that preserves the intent of both. The feature commit's new work and origin/${BASE}'s drift both matter — don't drop either. If two sides edit the same logical block, integrate them.

## Conflicted files
${conflictedFiles.map((f) => `- ${f}`).join("\n")}

## Verification
After editing each file, re-read it and confirm no \`<<<<<<<\`, \`=======\` (between markers), or \`>>>>>>>\` lines remain. The script will reject files with leftover markers and hardFail.

Only edit the conflicted files listed above. Auto-merged files are already staged correctly — do not touch them.`;

  const resolveUserMsg = [
    `# Rebase-conflict resolution (pause #${preRebaseResolutionCount})`,
    ``,
    `\`git rebase origin/${BASE}\` paused with content conflicts in:`,
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

  log(`spawning codex for rebase conflict resolution model=${MODEL}`);
  try {
    await runCodexAgent("resolve", resolveSystemPrompt, resolveUserMsg, wt, envelopePath);
  } catch (e) {
    spawnSync("git", ["-C", wtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    hardFail(
      "conflict-resolution agent exited non-zero",
      String((e as Error).message ?? e).slice(-2000)
    );
  }

  // Verify markers gone in every conflicted file.
  const markerLeftovers: string[] = [];
  for (const f of conflictedFiles) {
    const absPath = resolvePath(wt, f);
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
    spawnSync("git", ["-C", wtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    hardFail(
      "conflict markers remain after resolution agent",
      `Files still containing markers:\n${markerLeftovers.map((f) => `  ${f}`).join("\n")}`
    );
  }

  // Stage resolved files; rebase --continue commits with the original message.
  const addR = spawnSync(
    "git",
    ["-C", wtRoot, "add", "--", ...conflictedFiles],
    { encoding: "utf-8" }
  );
  if (addR.status !== 0) {
    spawnSync("git", ["-C", wtRoot, "rebase", "--abort"], { encoding: "utf-8" });
    hardFail(
      "git add of resolved conflict files failed",
      `${addR.stdout ?? ""}\n${addR.stderr ?? ""}`
    );
  }

  preRebaseR = spawnSync(
    "git",
    [
      "-C", wtRoot,
      "-c", "user.name=assembly-dev",
      "-c", "user.email=assembly-dev@local",
      "-c", "core.editor=true",
      "rebase", "--continue",
    ],
    { encoding: "utf-8" }
  );
  preRebaseResolved = true;

  if (existsSync(envelopePath)) {
    try { unlinkSync(envelopePath); } catch {}
  }
}

if (preRebaseR.status !== 0) {
  spawnSync("git", ["-C", wtRoot, "rebase", "--abort"], { encoding: "utf-8" });
  softGateFail("rebase-conflict",
    `pre-rebase exhausted ${MAX_REBASE_RESOLUTIONS} resolution attempts without completing.\n` +
    `${((preRebaseR.stdout ?? "") + "\n" + (preRebaseR.stderr ?? "")).slice(-2000)}\n` +
    `Re-implement the changes to avoid conflicting with the current state of origin/${BASE}.`);
}

if (preRebaseResolved) {
  log(`pre-rebase completed after ${preRebaseResolutionCount} resolution(s)`);
} else {
  log(`pre-rebase clean (already on origin/${BASE}'s tip or no overlap)`);
}

// Refresh commitSha — rebase rewrites commit SHAs.
const postMergeShaR = spawnSync("git", ["-C", wtRoot, "rev-parse", "HEAD"], { encoding: "utf-8" });
commitSha = (postMergeShaR.stdout ?? "").trim();

// Re-run tests after rebasing onto origin/BASE — the replayed commit may
// behave differently against the new base (semantic conflicts even when
// markers were resolved cleanly, or no markers at all if the rebase was
// auto-clean but origin/BASE drifted under the feature).
//
// Skip the re-run if the rebase didn't move HEAD relative to the original
// commit — i.e. origin/BASE was already an ancestor of HEAD (rebase no-op).
const headChangedR = spawnSync(
  "git",
  ["-C", wtRoot, "rev-parse", "HEAD"],
  { encoding: "utf-8" }
);
const headAfterRebase = (headChangedR.stdout ?? "").trim();
// commitSha was just refreshed; pre-rebase original was the agent's commit.
// If we ran any resolution OR origin/BASE contributed commits, re-test.
const rebaseChangedHead = preRebaseResolved || (preRebaseR.status === 0 && headAfterRebase !== commitSha);
if (preRebaseResolved || preRebaseR.status === 0) {
  if (rebaseChangedHead || preRebaseResolved) {
    log(`re-running bun test on post-rebase HEAD=${commitSha.slice(0, 8)}`);
    const reTestR = spawnSync("bun", ["test"], { cwd: wt, encoding: "utf-8", timeout: 180_000 });
    testOut = ((reTestR.stdout ?? "") + "\n" + (reTestR.stderr ?? "")).slice(-4000);
    testsPassed = reTestR.status === 0;
    if (!testsPassed) {
      log(`post-rebase tests failed (exit ${reTestR.status}) — deferring to eval for retry-with-feedback`);
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

} else {
  log(`skipping build/test/commit/rebase — soft gate failure recorded; deferring to eval`);
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
    tests_passed: gateFailed ? false : testsPassed,
    test_output: gateFailed ? "(skipped — gate failure)" : testOut,
    commit_sha: gateFailed ? "" : commitSha,
    // Quality-gate results — surfaced for eval.ts to decide retry vs pass.
    typecheck_passed: gateFailed ? undefined : typecheckPassed,
    typecheck_output: gateFailed ? undefined : typecheckOutput,
    lint_passed: gateFailed ? undefined : lintPassed,
    lint_output: gateFailed ? undefined : lintOutput,
    gates_passed: !gateFailed,
    ...(agentEnv.data?.gate_failure ? { gate_failure: agentEnv.data.gate_failure } : {}),
  },
});
