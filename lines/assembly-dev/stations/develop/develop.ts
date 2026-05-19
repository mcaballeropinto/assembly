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
import { readFileSync, existsSync, statSync } from "fs";
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

const systemPrompt = `You are a senior developer implementing a plan inside an Assembly framework worktree.

## Your cwd IS the worktree
- You are already running at: ${wt}
- All edits target files under this directory. Use relative paths or paths starting with ${wt}/.
- Do NOT edit anything under ${REPO} — that is a DIFFERENT checkout and your changes would bypass the merge pipeline.
- Do NOT create git commits, worktrees, or merges — the script around you handles that after you finish.
- Do NOT run git add, git commit, git merge, systemctl, or anything that modifies git state.

## Your job
Read the plan, implement it inside the current directory, run \`bun test\` until it passes. That is all.

## When you finish
Your entire final assistant response MUST be a single JSON object with exactly these fields:

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

No preamble, no code fences, no trailing text. Tool output does not count — only your final assistant message.`;

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
    ? `# Dashboard affected\nYes. After you change dashboard-related files, run \`bun run src/cli.ts dashboard --port 4199 &\` briefly to confirm it starts without errors. Kill it when done.`
    : `# Dashboard affected\nNo.`,
  ``,
  pendingFeedback ?? "",
].join("\n");

if (pendingFeedback) {
  log(`retry with prior-attempt feedback (${pendingFeedback.length} chars)`);
}

// ─── Spawn claude with cwd=worktree ───────────────────────────────────

log(`spawning claude cwd=${wt} model=${MODEL}`);

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

// Stream stdout, extract final "result" event
let finalResult = "";
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
      if (ev.type === "result" && typeof ev.result === "string") {
        finalResult = ev.result;
      }
      // Tee a compact progress line to stderr
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

// ─── Parse agent envelope ─────────────────────────────────────────────

let agentEnv: any = null;
if (finalResult) {
  const cleaned = finalResult.trim();
  // Try direct parse, then fenced, then first-brace-to-last-brace
  const attempts: string[] = [cleaned];
  const fence = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) attempts.push(fence[1].trim());
  const i0 = cleaned.indexOf("{");
  const i1 = cleaned.lastIndexOf("}");
  if (i0 !== -1 && i1 > i0) attempts.push(cleaned.slice(i0, i1 + 1));
  for (const a of attempts) {
    try {
      agentEnv = JSON.parse(a);
      break;
    } catch {
      /* try next */
    }
  }
}

const agentSummary: string = agentEnv?.summary ?? "Implementation attempted";
const agentContent: string = agentEnv?.content ?? finalResult.slice(0, 4000);
const agentData = (agentEnv?.data ?? {}) as Record<string, unknown>;

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
  function isAllowed(path: string): boolean {
    if (planSet.has(path)) return true;
    // Allow test files paired with planned source files:
    //   src/foo.ts → src/__tests__/foo.test.ts (and similar)
    const testFor = (p: string) => {
      const m = p.match(/^src\/(.+)\.ts$/);
      if (!m) return [];
      const stem = m[1];
      return [
        `src/__tests__/${stem}.test.ts`,
        `src/__tests__/${stem}-${"".padEnd(0)}.test.ts`,
      ];
    };
    for (const planned of planSet) {
      for (const t of testFor(planned)) {
        if (path === t) return true;
      }
    }
    // Allow co-located tests in the same folder.
    const colocated = path.match(/^(.*)\/[^/]+\.test\.ts$/);
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

// ── Gate 4: Typecheck ────────────────────────────────────────────────
log(`bun run typecheck`);
const tscR = spawnSync("bun", ["run", "typecheck"], {
  cwd: wt,
  encoding: "utf-8",
  timeout: 120_000,
});
if (tscR.status !== 0) {
  const tail = ((tscR.stdout ?? "") + "\n" + (tscR.stderr ?? "")).slice(-3000);
  hardFail(
    `typecheck failed (exit ${tscR.status})`,
    `branch=${branch} worktree=${wtRoot}\n${tail}`
  );
}

// ── Gate 5: Lint ─────────────────────────────────────────────────────
log(`bun run lint`);
const lintR = spawnSync("bun", ["run", "lint"], {
  cwd: wt,
  encoding: "utf-8",
  timeout: 120_000,
});
if (lintR.status !== 0) {
  const tail = ((lintR.stdout ?? "") + "\n" + (lintR.stderr ?? "")).slice(-3000);
  hardFail(
    `lint failed (exit ${lintR.status})`,
    `branch=${branch} worktree=${wtRoot}\n${tail}`
  );
}

// ─── Run tests ────────────────────────────────────────────────────────

log(`running bun test`);
const testR = spawnSync("bun", ["test"], { cwd: wt, encoding: "utf-8", timeout: 180_000 });
const testOut = ((testR.stdout ?? "") + "\n" + (testR.stderr ?? "")).slice(-4000);
const testsPassed = testR.status === 0;
if (!testsPassed) {
  log(`tests failed (exit ${testR.status})`);
}

// ─── Commit ───────────────────────────────────────────────────────────

let commitSha = "";
if (porcelain) {
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

// ─── Gate on tests ────────────────────────────────────────────────────

// Develop owns the "tests pass before we hand off" contract. A test failure
// is a real failure of the station — we hard-fail (exit 1) so the orchestrator
// marks the station failed and skips eval + deploy. The inner agent is
// responsible for writing code that passes; if it didn't, this attempt is
// done and the orchestrator's retry policy (crash class) decides whether to
// re-run develop from scratch.
if (!testsPassed) {
  hardFail(
    `tests failed (exit ${testR.status})`,
    `branch=${branch} commit=${commitSha.slice(0, 8)} worktree=${wtRoot}\n${testOut}`
  );
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
  },
});
