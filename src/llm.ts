import Anthropic from "@anthropic-ai/sdk";
import { unlinkSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join as joinPath } from "path";
import type { LLMMessage, LLMResult, Provider, ProgressCallback, OnEventCallback } from "./types";
import { openSessionLog, appendSessionLogRaw, closeSessionLog } from "./session-log";

export const DEFAULT_REPAIR_MODEL = "claude-haiku-4-5-20251001";
export const REPAIR_MAX_TOKENS = 64000;

/**
 * Defensive env vars passed to every spawned `claude` subprocess.
 *
 * Role in the post-watcher world: these are BELT-AND-SUSPENDERS, not the
 * primary completion signal. When callLLM is invoked with an invocation-
 * scoped `envelopePath`, station completion is driven by the envelope file
 * appearing on disk (see callClaudeCode's watcher path). These watchdogs
 * only matter for the residual cases:
 *
 *   1. Legacy call sites that don't pass envelopePath (still use the /tmp
 *      fallback and stream-end as completion).
 *   2. Catastrophic cases where the envelope never gets written AND the
 *      stream stalls — watchdogs kill the subprocess so the station fails
 *      fast instead of hanging until the orchestrator's station timeout.
 *
 * Upstream bugs these mitigate:
 *   #25629 — stream-json post-result hang (cosmetic once watcher is in use)
 *   #25979 — API streaming stall (watchdog closes stdout → stream ends)
 *   #38437 — MCP proxy silent hang (idle timeout surfaces the wedge)
 */
export const DEFAULT_CLAUDE_ENV: Record<string, string> = {
  CLAUDE_ENABLE_BYTE_WATCHDOG: "1",
  CLAUDE_ENABLE_STREAM_WATCHDOG: "1",
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: "300000",
  API_TIMEOUT_MS: "600000",
  BASH_DEFAULT_TIMEOUT_MS: "120000",
  BASH_MAX_TIMEOUT_MS: "900000",
};

export const CLAUDE_PROMPT_WARN_DEFAULT = 150_000;
export const CLAUDE_STREAM_TEXT_CAP = 256 * 1024;

export function getPromptWarnThreshold(): number {
  const raw = process.env.ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES;
  if (!raw) return CLAUDE_PROMPT_WARN_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CLAUDE_PROMPT_WARN_DEFAULT;
}

export function mergeClaudeEnv(
  lineEnv?: Record<string, string>,
  stationEnv?: Record<string, string>
): Record<string, string> {
  const processOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ASSEMBLY_CLAUDE_") && v !== undefined) {
      // Skip the assembly-level telemetry var — it's not a claude env var
      if (k === "ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES") continue;
      processOverrides[k.replace("ASSEMBLY_CLAUDE_", "")] = v;
    }
  }
  return {
    ...DEFAULT_CLAUDE_ENV,
    ...processOverrides,
    ...(lineEnv ?? {}),
    ...(stationEnv ?? {}),
  };
}

export async function callLLM(
  messages: LLMMessage[],
  model: string,
  maxTokens: number = 4096,
  fallbackModels: string[] = [],
  provider: Provider = "claude-code",
  onProgress?: ProgressCallback,
  claudeEnv?: Record<string, string>,
  logger?: (event: string, detail: Record<string, unknown>) => void,
  sessionLogPath?: string,
  allowedTools?: string[],
  envelopePath?: string,
  onEvent?: OnEventCallback,
  scratchCwd?: string
): Promise<LLMResult> {
  if (provider !== "claude-code" && provider !== "claude-code-cached") {
    throw new Error(
      `Unsupported provider: ${provider}. Only 'claude-code' and 'claude-code-cached' are supported for LLM calls (use 'script' for non-LLM stations).`
    );
  }

  const cacheOptimized = provider === "claude-code-cached";
  const modelsToTry = [model, ...fallbackModels];
  let lastError: Error | null = null;

  for (const currentModel of modelsToTry) {
    try {
      return await callClaudeCode(messages, currentModel, maxTokens, onProgress, claudeEnv, cacheOptimized, logger, sessionLogPath, allowedTools, envelopePath, onEvent, scratchCwd);
    } catch (err) {
      lastError = err as Error;
      const status = (err as any)?.status;

      // Only retry on server errors / rate limits, not client errors
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      console.error(
        `  ⚠ [claude-code] Model ${currentModel} failed: ${lastError.message}. ${fallbackModels.length > 0 ? "Trying fallback..." : ""}`
      );
    }
  }

  throw new Error(
    `All models failed. Last error: ${lastError?.message ?? "unknown"}`
  );
}

// ─── Script Provider (Direct execution, no LLM) ─────────────────────

export async function callScript(
  scriptPath: string,
  workpiecePath: string,
  lastActivityRef?: { ms: number },
  scratchCwd?: string
): Promise<LLMResult> {
  let lastActivityMs = Date.now();
  // Pin cwd to a per-task scratch dir so any sloppy relative-path writes from
  // the script land in a disposable, gitignored location instead of polluting
  // the assembly tree. The script still receives an absolute `workpiecePath`,
  // so cwd does not affect correctness.
  const proc = Bun.spawn(["bun", "run", scriptPath, workpiecePath], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    cwd: scratchCwd,
  });

  const dec = new TextDecoder();
  let stdout = "";
  let stderr = "";

  const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(dec.decode(value, { stream: true }));
      const now = Date.now();
      lastActivityMs = now;
      if (lastActivityRef) lastActivityRef.ms = now;
    }
  };

  await Promise.all([
    drain(proc.stdout, (chunk) => { stdout += chunk; }),
    drain(proc.stderr, (chunk) => { stderr += chunk; }),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Script's FATAL line (from hardFail()) lands near the END of stderr,
    // after many minutes of [develop] log() output. substring(0, 500) showed
    // only the worktree-create + spawn-claude prefix — the actual failure
    // was invisible. Take the tail so the cause is on screen.
    const tail = stderr.length > 2000 ? "…" + stderr.slice(-2000) : stderr;
    throw new Error(
      `Script ${scriptPath} exited with code ${exitCode}: ${tail}`
    );
  }

  if (!stdout.trim()) {
    throw new Error(`Script ${scriptPath} produced no output`);
  }

  return {
    content: stdout.trim(),
    tokens: { in: 0, out: 0 },
    model: "script",
    getLastActivityMs: () => lastActivityMs,
  };
}

// ─── Claude Code Provider (CLI, streaming) ───────────────────────────

export const DEFAULT_ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

// Tools required by the envelope write protocol (tmp file + mv rename).
// When the watcher path is active we auto-inject these so stations with
// a minimal `tools:` list still complete successfully. The alternative is
// a silent hang — the model can't write the envelope, the watcher never
// sees a file, and we wait for the idle timeout with no useful signal.
const ENVELOPE_PROTOCOL_TOOLS = ["Write", "Bash"];

// Built-in claude-code tools we know about. Used to compute an explicit
// disallow list: anything in this universe that's not in the station's
// allow list gets banned by name. Without this, claude-code's CLI treats
// --allowedTools as a soft hint — unlisted tools fall through to the
// session's permissionMode (auto in our case) and get auto-approved
// silently. That has caused real wedges in practice: a station declared
// `tools: [Bash, WebFetch]` but the agent still racked up dozens of Reads,
// Globs, and an Agent call exploring the assembly tree, then timed out.
//
// Keep this list in sync with what `claude --help` advertises as built-in
// tools; new entries silently fall through the disallow list when added.
export const KNOWN_BUILTIN_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "RemoteTrigger",
  "ScheduleWakeup",
  "ShareOnboardingGuide",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
];

// Tools we always block, regardless of station config. Skill resolves to
// arbitrary other skills' instructions and breaks the bounded-station
// contract; previously hardcoded as the only --disallowedTools entry.
const ALWAYS_DISALLOWED = ["Skill"];

function bareToolName(t: string): string {
  // Match on bare tool name — `Bash(git status)` still counts as Bash.
  const paren = t.indexOf("(");
  return paren === -1 ? t : t.slice(0, paren);
}

export function resolveAllowedTools(
  stationTools?: string[],
  usingWatcher = false,
  envelopePath?: string
): string[] {
  // Distinguish "tools not declared" (use defaults) from "tools: []"
  // (explicit empty — station opts out of every capability except the
  // envelope-write protocol). Until 2026-05-18 both collapsed to defaults,
  // which silently re-granted Bash/Read/Write to stations that thought
  // they had opted out — observed when hello-world's greet station, with
  // `tools: []`, used auto-injected Bash to run `git init` in the repo
  // root instead of producing the envelope.
  const base = Array.isArray(stationTools) ? stationTools : DEFAULT_ALLOWED_TOOLS;
  if (!usingWatcher) return base;
  // Ensure Write + Bash are present when the watcher expects the atomic
  // write protocol. Preserves whatever else the station declared.
  //
  // SANDBOX: scope BOTH auto-injected tools to the envelope path so a
  // station that opted out of broad Write/Bash capability (e.g. plan,
  // which declares only [Bash, Read, Glob, Grep]; or hello-world's greet
  // with tools:[]) doesn't inadvertently get unrestricted Write/Bash
  // smuggled in via the envelope-protocol injection.
  // - Write is scoped to `${envelopePath}.tmp` so the agent can't edit
  //   arbitrary files (2026-05-15 fix: a plan agent used the unscoped
  //   auto-Write to commit implementation as a side effect of "planning.")
  // - Bash is scoped to `mv ${envelopePath}.tmp ${envelopePath}` so the
  //   agent can't shell out to do anything but the final atomic rename
  //   (2026-05-18 fix: hello-world greet ran `git init` via auto-Bash.)
  // Stations that declare Write or Bash explicitly keep their unscoped
  // declaration — they asked for the capability.
  const merged = [...base];
  for (const required of ENVELOPE_PROTOCOL_TOOLS) {
    const hasIt = merged.some((t) => bareToolName(t) === required);
    if (!hasIt) {
      if (required === "Write" && envelopePath) {
        merged.push(`Write(${envelopePath}.tmp)`);
      } else if (required === "Bash" && envelopePath) {
        merged.push(`Bash(mv ${envelopePath}.tmp ${envelopePath})`);
      } else {
        merged.push(required);
      }
    }
  }
  return merged;
}

// Compute the disallow list. When the station declares an explicit
// `tools:` list, we ban every known built-in that's not on it. Without
// an explicit list, the station opted into DEFAULT_ALLOWED_TOOLS — we
// still ban anything outside that set so drift to Agent/Skill/Cron/etc
// is blocked everywhere.
export function resolveDisallowedTools(
  stationTools?: string[],
  usingWatcher = false,
  envelopePath?: string
): string[] {
  const allowed = new Set(resolveAllowedTools(stationTools, usingWatcher, envelopePath).map(bareToolName));
  const disallow = new Set<string>(ALWAYS_DISALLOWED);
  for (const tool of KNOWN_BUILTIN_TOOLS) {
    if (!allowed.has(tool)) disallow.add(tool);
  }
  return [...disallow];
}

async function callClaudeCode(
  messages: LLMMessage[],
  model: string,
  maxTokens: number,
  onProgress?: ProgressCallback,
  claudeEnv?: Record<string, string>,
  cacheOptimized: boolean = false,
  logger?: (event: string, detail: Record<string, unknown>) => void,
  sessionLogPath?: string,
  allowedTools?: string[],
  envelopePath?: string,
  onEvent?: OnEventCallback,
  scratchCwd?: string
): Promise<LLMResult> {
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const userMsg = messages.find((m) => m.role === "user")?.content ?? "";

  // When a caller-provided envelopePath is supplied, use it as the authoritative
  // output location — that gives station completion a stable filesystem signal
  // decoupled from subprocess lifecycle. Otherwise fall back to the legacy
  // /tmp path so existing call sites and tests keep working.
  const outputFile = envelopePath
    ? envelopePath
    : `/tmp/assembly-envelope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const usingWatcher = Boolean(envelopePath);

  // Clean slate: loops and retries can reuse the same envelopePath. An old
  // file from a prior attempt would race-win the watcher and return stale
  // content. Delete it SYNCHRONOUSLY — async rm can race the watcher's
  // first poll tick and leak stale envelope content through.
  if (usingWatcher) {
    try {
      unlinkSync(outputFile);
    } catch {
      // ENOENT is expected on the common path (no prior file)
    }
  }

  // Atomic write protocol. The mv rename on the same filesystem is atomic,
  // so the watcher never observes a partially-written file. For the legacy
  // /tmp path this is also cheap robustness; for the invocation-scoped path
  // it's what makes the watcher race safe against the Write tool's write.
  const fileInstruction = `

## Envelope Contract — READ THIS FIRST

Your task ends ONLY when you have written a JSON envelope file at the EXACT path below. The envelope file is the entire output of this station; nothing in your text reply is read by the framework.

### The path (use this EXACT absolute path)

  ${outputFile}

### The write protocol (two tool calls, in this order)

1. Write tool → ${outputFile}.tmp   (contents: the JSON envelope)
2. Bash tool  → mv "${outputFile}.tmp" "${outputFile}"

The mv must be the LAST tool call you make. If you have not run the mv, the station has not finished, regardless of what your text reply says.

DO NOT cat the envelope to stdout. DO NOT print the envelope JSON in your text reply. DO NOT read framework source files to "figure out" the shape — the shape is below.

### The envelope shape (the universal wrapper)

{
  "summary": "<REQUIRED one-line string>",
  "content": "<optional markdown/text>",
  "data": { /* optional structured fields, schema per this station's AGENT.md */ }
}

The fields inside "data" are described by the station's own output schema (in its AGENT.md). The wrapper above is the same for every station.

### If you cannot produce real data

Write an envelope anyway. Use "summary" to explain why and set the required data array (e.g. data.jobs) to []. Empty is acceptable; a missing envelope file is not — the harness will then synthesize one for you, usually badly.

## Writable paths

- ${outputFile} — the envelope path above (absolute; works from any cwd)
- /tmp/* — ad-hoc scratch (firecrawl payloads, intermediate JSON, log captures)
- Your cwd — pinned to a disposable /tmp/assembly-scratch-* by the harness; safe to write to but discarded after the task

Never write under the line/station tree (anywhere under lines/) outside the envelope path above. No FANOUT-*-RESULT.json, *-SUMMARY.md, or other deliverable sidefiles in line/station dirs. Everything goes in the envelope's "content" / "data" fields.`;

  // When cache-optimized, keep the system prompt stable (no per-call unique path)
  // and move the file instruction to the user message instead.
  const effectiveSystemPrompt = cacheOptimized ? systemMsg : systemMsg + fileInstruction;
  const effectiveUserMsg = cacheOptimized ? userMsg + fileInstruction : userMsg;

  // Write the system prompt to a per-call tempfile and pass
  // --append-system-prompt-file. Until 2026-05-18 we sent `system` inside the
  // stdin stream-json payload, but empirically claude-code IGNORES that field
  // — the agent only saw its own default "interactive assistant" system
  // prompt plus our user message. The AGENT.md body and ENVELOPE_INSTRUCTION
  // were never delivered. Production pipelines worked anyway because the
  // user message ends with "Produce your output now" and contains enough
  // structured input to coerce a JSON reply, but smaller stations (hello-
  // world's greet) regressed into chat mode.
  //
  // We use `--append-system-prompt-file` rather than `--system-prompt-file`
  // because the default system prompt carries claude-code's own permission
  // affordances (filesystem sandbox, tool gating, etc). Replacing it
  // outright with just AGENT.md content caused Write to be permission-
  // prompted on every call and the station hung.
  //
  // A file (not inline `--append-system-prompt <prompt>`) keeps us under
  // ARG_MAX and avoids tripping the argv-contains-prompt tripwire below.
  const sysPromptDir = mkdtempSync(joinPath(tmpdir(), "assembly-sysprompt-"));
  const sysPromptPath = joinPath(sysPromptDir, "system-prompt.txt");
  writeFileSync(sysPromptPath, effectiveSystemPrompt);

  // User message still goes through stdin (--input-format stream-json) so we
  // never E2BIG on large workpieces. Linux ARG_MAX is ~128 KB and individual
  // user messages can be a sizeable multiple of that.
  // Whitelist the envelope's directory so claude-code's filesystem sandbox
  // (which by default only allows writes under cwd) doesn't block the agent
  // from creating the envelope file. The envelope lives under
  // ~/.assembly/runs/, well outside whatever cwd the harness pins.
  const addDirs: string[] = [];
  if (usingWatcher && envelopePath) {
    const envelopeDir = envelopePath.slice(0, envelopePath.lastIndexOf("/"));
    if (envelopeDir) addDirs.push(envelopeDir);
  }

  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    mapModelToClaudeCode(model),
    "--input-format",
    "stream-json",
    "--append-system-prompt-file", sysPromptPath,
    ...(addDirs.length > 0 ? ["--add-dir", ...addDirs] : []),
    "--allowedTools", ...resolveAllowedTools(allowedTools, usingWatcher, usingWatcher ? outputFile : undefined),
    "--disallowedTools", ...resolveDisallowedTools(allowedTools, usingWatcher, usingWatcher ? outputFile : undefined),
    // Lock down the agent's environment so user-level claude-code config
    // doesn't leak into assembly runs:
    //   - strict-mcp-config: ignore the user's MCP servers entirely. Without
    //     this, every spawned agent inherits Gmail/Calendar/Drive/Linear/
    //     Notion/M365 MCP tools from the operator's claude-code settings,
    //     and the agent picks up tasks it shouldn't have (observed: hello-
    //     world's greet station deciding to "draft an email to Sam" instead
    //     of producing the envelope).
    //   - disable-slash-commands: skills are already on ALWAYS_DISALLOWED,
    //     but disabling the whole subsystem stops slash-command discovery
    //     from running on every spawn and keeps the agent's tool surface
    //     identical across machines.
    "--strict-mcp-config",
    "--disable-slash-commands",
    // Auto-accept file writes within --add-dir boundaries. Default mode
    // prompts the user for every Write call — non-interactive sessions
    // can't respond, so the station hangs until the watcher timeout.
    // The agent's filesystem reach is still bounded by --add-dir and its
    // tool set is bounded by --allowedTools/--disallowedTools.
    "--permission-mode", "acceptEdits",
    "--no-session-persistence",
  ];

  // Prompt-size telemetry
  const systemBytes = Buffer.byteLength(effectiveSystemPrompt, "utf8");
  const userBytes = Buffer.byteLength(effectiveUserMsg, "utf8");
  const totalBytes = systemBytes + userBytes;
  const warnThreshold = getPromptWarnThreshold();
  if (logger && totalBytes > warnThreshold) {
    logger("prompt_size_warn", {
      model,
      system_bytes: systemBytes,
      user_bytes: userBytes,
      total_bytes: totalBytes,
      threshold: warnThreshold,
    });
  }

  // Developer tripwire: ensure no prompt content is in argv
  for (const a of args) {
    if (a === effectiveUserMsg || a === effectiveSystemPrompt || a.length > 8192) {
      throw new Error("argv contains prompt content");
    }
  }

  // Merge claude env vars
  const effectiveClaudeEnv = claudeEnv ?? mergeClaudeEnv();
  const env = { ...process.env, ...effectiveClaudeEnv };
  // Strip Anthropic API keys so the claude CLI uses the Claude Code
  // subscription instead of billing the direct API. ASSEMBLY_ANTHROPIC_API_KEY
  // is ours (used only for the direct-SDK envelope repair path below).
  delete env.ANTHROPIC_API_KEY;
  delete env.ASSEMBLY_ANTHROPIC_API_KEY;

  let lastActivityMs = Date.now();
  let turns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let costUsd = 0;
  // Accumulate every assistant text block for salvage when the envelope file
  // is not written. Capped at CLAUDE_STREAM_TEXT_CAP bytes; oldest trimmed so
  // trailing JSON (usually at the end of the session) is preserved.
  let textFallback = "";
  // Per-message usage accumulators. The canonical totals come from the
  // `result` event; these are a fallback for streams that die before result.
  let fallbackInputTokens = 0;
  let fallbackOutputTokens = 0;
  let fallbackCacheRead = 0;
  let fallbackCacheCreation = 0;

  const sessionStartedAt = Date.now();
  if (sessionLogPath) {
    openSessionLog(sessionLogPath, {
      model: mapModelToClaudeCode(model),
      system_bytes: systemBytes,
      user_bytes: userBytes,
      cache_optimized: cacheOptimized,
      args,
    });
  }

  // Pin cwd to a per-task scratch dir (typically /tmp/assembly-scratch-<id>/)
  // so the agent's relative-path writes land in a disposable, gitignored
  // location. The envelope path is absolute, so cwd doesn't affect correctness.
  const proc = Bun.spawn(["claude", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: scratchCwd,
  });

  // Schedule cleanup of the per-call system-prompt tempfile. We can't wrap
  // the rest of this function in try/finally without an invasive refactor,
  // so use the subprocess's lifecycle as the signal: once `claude` has
  // exited it no longer needs the file. Errors are swallowed because the
  // file lives in /tmp and will be GC'd by the OS regardless.
  proc.exited.finally(() => {
    try {
      unlinkSync(sysPromptPath);
    } catch {}
    try {
      // mkdtempSync's parent dir is /tmp; rmdir is enough.
      require("fs").rmdirSync(sysPromptDir);
    } catch {}
  });

  // ── Stdout-idle watchdog ──────────────────────────────────────────
  // Belt-and-suspenders to upstream CLAUDE_STREAM_IDLE_TIMEOUT_MS, which
  // has been observed not to fire — observed 2026-05-21 when an em-prospector
  // score task hung 24h with `child_live: false` from heartbeat #1 onward.
  // Without this, callClaudeCode's `Promise.race(envelopeWatch, streamPromise)`
  // can deadlock forever: streamPromise's reader.read() blocks until stdout
  // closes, and envelopeWatch polls forever for a file the dead-silent agent
  // can't write. SIGKILL closes stdout, which unblocks streamPromise and
  // resolves the race naturally.
  //
  // Threshold is intentionally a bit larger than the env-var CLAUDE_STREAM_IDLE_TIMEOUT_MS
  // we hand to claude (300s) so claude's own watchdog gets first shot.
  const STREAM_STALL_MS = parseInt(
    process.env.ASSEMBLY_CLAUDE_STREAM_STALL_MS ?? "420000",
    10
  );
  let stallKilled = false;
  const stallWatchdog = setInterval(() => {
    if (Date.now() - lastActivityMs >= STREAM_STALL_MS) {
      stallKilled = true;
      if (logger) {
        try {
          logger("claude_stream_stall_kill", {
            silent_ms: Date.now() - lastActivityMs,
            threshold_ms: STREAM_STALL_MS,
          });
        } catch {}
      }
      try { proc.kill("SIGKILL"); } catch {}
      clearInterval(stallWatchdog);
    }
  }, 15_000);
  // Don't keep the event loop alive on the watchdog alone.
  if ((stallWatchdog as unknown as { unref?: () => void }).unref) {
    (stallWatchdog as unknown as { unref: () => void }).unref();
  }
  proc.exited.finally(() => clearInterval(stallWatchdog));

  // Write the stream-json payload via stdin (user message only — the system
  // prompt is supplied via --system-prompt-file above, which claude-code
  // actually honors; stdin's `system` field is silently dropped).
  const payload = JSON.stringify({
    type: "user",
    message: { role: "user", content: effectiveUserMsg },
  }) + "\n";
  const writer = proc.stdin as unknown as { write: (data: string) => void; end: () => Promise<void> | void };
  writer.write(payload);
  await writer.end();

  // Stream-parse stdout line by line. Captured as a promise so we can race it
  // against the envelope file watcher when `usingWatcher` is true.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamResultError: Error | null = null;
  let streamSawResult = false;

  const streamPromise: Promise<void> = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lastActivityMs = Date.now();
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          if (sessionLogPath) appendSessionLogRaw(sessionLogPath, line);

          try {
            const event = JSON.parse(line);

            if (event.type === "assistant" && event.message?.content) {
              turns++;
              // Accumulate per-message usage as a fallback for the case where
              // the stream dies before the final `result` event fires. Without
              // this, failures like billing_error / stream-wedge end up with
              // tokens=0 in the workpiece even though assistant turns actually
              // consumed tokens. The `result` event, when it arrives, sets
              // exact totals and overwrites these accumulated values.
              const msgUsage = event.message.usage ?? {};
              if (typeof msgUsage.input_tokens === "number") {
                fallbackInputTokens += msgUsage.input_tokens
                  + (msgUsage.cache_creation_input_tokens ?? 0)
                  + (msgUsage.cache_read_input_tokens ?? 0);
                fallbackCacheRead += msgUsage.cache_read_input_tokens ?? 0;
                fallbackCacheCreation += msgUsage.cache_creation_input_tokens ?? 0;
              }
              if (typeof msgUsage.output_tokens === "number") {
                fallbackOutputTokens += msgUsage.output_tokens;
              }
              for (const block of event.message.content) {
                if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                  textFallback += (textFallback ? "\n\n" : "") + block.text;
                  if (textFallback.length > CLAUDE_STREAM_TEXT_CAP) {
                    textFallback = textFallback.slice(textFallback.length - CLAUDE_STREAM_TEXT_CAP);
                  }
                  if (onEvent) {
                    try {
                      const summary = block.text.length > 200
                        ? block.text.slice(0, 199) + "…"
                        : block.text;
                      const detail = block.text.length > 4096
                        ? block.text.slice(0, 4096)
                        : block.text;
                      onEvent({ kind: "message", summary, detail });
                    } catch {}
                  }
                }
                if (block.type === "tool_use") {
                  const detail = summarizeToolUse(block.name, block.input);
                  const toolInput = extractToolInput(block.name, block.input);
                  if (onProgress) {
                    onProgress({
                      detail,
                      tool: block.name,
                      tool_input: toolInput,
                      tokens: { in: totalInputTokens, out: totalOutputTokens },
                      cost_usd: costUsd,
                      turns,
                    });
                  }
                  if (onEvent) {
                    try {
                      const inputStr = JSON.stringify(block.input ?? {});
                      onEvent({
                        kind: "tool_call",
                        summary: detail,
                        detail: {
                          tool_name: block.name,
                          tool_use_id: block.id,
                          input_bytes: inputStr.length,
                          input_preview: inputStr.slice(0, 1024),
                        },
                      });
                    } catch {}
                  }
                }
              }
            }

            if (event.type === "result") {
              streamSawResult = true;
              const usage = event.usage ?? {};
              const cacheRead = usage.cache_read_input_tokens ?? 0;
              const cacheCreation = usage.cache_creation_input_tokens ?? 0;
              totalInputTokens =
                (usage.input_tokens ?? 0) + cacheRead + cacheCreation;
              totalOutputTokens = usage.output_tokens ?? 0;
              totalCacheRead += cacheRead;
              totalCacheCreation += cacheCreation;
              costUsd = event.cost_usd ?? 0;

              if (event.is_error) {
                const detail = {
                  subtype: event.subtype,
                  result:
                    typeof event.result === "string"
                      ? event.result.slice(0, 500)
                      : undefined,
                  num_turns: event.num_turns,
                  stop_reason: event.stop_reason,
                  duration_ms: event.duration_ms,
                  duration_api_ms: event.duration_api_ms,
                  tokens: {
                    in: totalInputTokens,
                    out: totalOutputTokens,
                    cache_read: totalCacheRead,
                    cache_creation: totalCacheCreation,
                  },
                  cost_usd: costUsd,
                  model,
                };
                try {
                  logger?.("claude_result_error", detail);
                } catch {}
                if (sessionLogPath) {
                  closeSessionLog(sessionLogPath, {
                    outcome: "error",
                    kind: "claude_result_error",
                    subtype: event.subtype,
                    stop_reason: event.stop_reason,
                    num_turns: event.num_turns,
                    duration_ms: Date.now() - sessionStartedAt,
                  });
                }
                // Don't throw from inside the stream consumer — let the race
                // decide. An envelope-file win with a later error event should
                // still succeed (file is truth). Surface via captured error.
                streamResultError = new Error(
                  `Claude Code error: ${event.subtype ?? event.result ?? "unknown"} (turns=${event.num_turns ?? "?"}, stop=${event.stop_reason ?? "?"})`
                );
                return;
              }

              try {
                logger?.("claude_result_ok", {
                  num_turns: event.num_turns,
                  duration_ms: event.duration_ms,
                  duration_api_ms: event.duration_api_ms,
                  tokens: {
                    in: totalInputTokens,
                    out: totalOutputTokens,
                    cache_read: totalCacheRead,
                    cache_creation: totalCacheCreation,
                  },
                  cost_usd: costUsd,
                  model,
                });
              } catch {}
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  })();

  // ─── Envelope watcher path (new) ─────────────────────────────────────
  // When an invocation-scoped envelopePath is provided, poll it for
  // appearance + valid JSON. Resolving this first means station completion
  // is decoupled from subprocess lifecycle — hangs after the result event
  // (claude-code #25629) become cosmetic: we have the envelope, we SIGKILL.
  //
  // In this path, stream-json stdout is TELEMETRY ONLY: it feeds token
  // counts, tool-use progress events, and textFallback for salvage. It does
  // NOT gate station completion. Errors reported on the stream are captured
  // into `streamResultError` but only surface if the envelope file never
  // appeared — a successful envelope file always wins over a later stream
  // error, because the file is the contract.
  let envelopeFromWatcher: string | null = null;
  if (usingWatcher) {
    const pollAbort = { aborted: false };
    const envelopeWatch: Promise<string | null> = (async () => {
      const intervalMs = 250;
      while (!pollAbort.aborted) {
        try {
          const f = Bun.file(outputFile);
          if (await f.exists()) {
            const text = (await f.text()).trim();
            if (text) {
              try {
                JSON.parse(text);
                return text;
              } catch {
                // Partial write or not-yet-valid JSON; wait + retry.
              }
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return null;
    })();

    // Race: envelope appears vs stream ends. Whichever fires first wins.
    const winner = await Promise.race([
      envelopeWatch.then((content) => ({ kind: "envelope" as const, content })),
      streamPromise.then(() => ({ kind: "stream" as const, content: null })),
    ]);

    if (winner.kind === "envelope" && winner.content) {
      envelopeFromWatcher = winner.content;
      // File is committed; reap the subprocess. But we want the stream's
      // final `result` event (carries token usage for cost attribution) to
      // land BEFORE we kill. Two exit conditions, whichever comes first:
      //   - streamSawResult becomes true → tokens are captured, kill now
      //   - POST_ENVELOPE_GRACE_MS elapses → kill anyway (hang protection)
      const POST_ENVELOPE_GRACE_MS = 3_000;
      const graceDeadline = Date.now() + POST_ENVELOPE_GRACE_MS;
      (async () => {
        while (!streamSawResult && Date.now() < graceDeadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        try { proc.kill("SIGKILL"); } catch {}
      })();
    } else {
      // Stream ended first. The envelope might have been written moments
      // before — between our last poll tick and the stream's close — so do
      // a final synchronous check before giving up on the file path. This
      // eliminates a sub-250ms race window where the poller wouldn't tick
      // again in time.
      try {
        const f = Bun.file(outputFile);
        if (await f.exists()) {
          const text = (await f.text()).trim();
          if (text) {
            try {
              JSON.parse(text);
              envelopeFromWatcher = text;
            } catch {}
          }
        }
      } catch {}
    }

    // Stop the poller either way.
    pollAbort.aborted = true;

    // Drain the stream consumer so textFallback and usage are captured.
    // Bounded wait — if the subprocess hangs after result, SIGKILL above
    // will close stdout and the reader loop will exit with done=true.
    try {
      await Promise.race([
        streamPromise,
        new Promise((r) => setTimeout(r, 10_000)),
      ]);
    } catch {}

    // Ensure subprocess is truly dead before we return.
    try { proc.kill("SIGKILL"); } catch {}
  } else {
    // Legacy path: wait for stream to finish naturally.
    try {
      await streamPromise;
    } catch (err) {
      throw err;
    }
    if (streamResultError) throw streamResultError;
  }

  // In the watcher path, if the file never appeared AND the stream reported
  // an error, surface that error — we have nothing to salvage from disk.
  if (usingWatcher && !envelopeFromWatcher && streamResultError) {
    throw streamResultError;
  }

  // The stall watchdog SIGKILL'd the subprocess due to stdout silence past
  // the threshold AND no envelope ever appeared. Surface a clear error so
  // the orchestrator routes this to error/ with a meaningful failure class
  // (rather than the generic "exit code N" path below).
  if (stallKilled && !envelopeFromWatcher) {
    throw new Error(
      `claude stream stalled (no stdout activity for ${Math.floor(STREAM_STALL_MS / 1000)}s) — killed by assembly stall watchdog`
    );
  }

  // Wait for process exit (bounded — SIGKILL above guarantees it dies).
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // When the watcher captured the envelope, the subprocess was SIGKILL'd.
  // A non-zero exit in that case is expected (signal death), not a failure
  // — skip the legacy exit-code guard.
  const suppressExitCheck = usingWatcher && envelopeFromWatcher !== null;
  if (!suppressExitCheck && exitCode !== 0 && !totalOutputTokens) {
    if (sessionLogPath) {
      closeSessionLog(sessionLogPath, {
        outcome: "error",
        kind: "exit_nonzero",
        exit_code: exitCode,
        stderr_preview: stderr.slice(0, 2000),
        duration_ms: Date.now() - sessionStartedAt,
      });
    }
    throw new Error(
      `claude exited with code ${exitCode}: ${stderr.substring(0, 300)}`
    );
  }

  // Read the envelope. Watcher content wins if present (we already validated
  // it as JSON during polling). Otherwise read from disk as before.
  // `textFallback` is returned separately as `fallbackContent` so callers can
  // attempt salvage when the file is missing/empty.
  let content: string;
  if (envelopeFromWatcher) {
    content = envelopeFromWatcher.trim();
  } else {
    try {
      const file = Bun.file(outputFile);
      content = (await file.text()).trim();
    } catch {
      content = "";
    }
  }
  try {
    // Best-effort cleanup. For the watcher path, the file lives in the run
    // directory and is useful for debugging — leave it. For /tmp legacy,
    // clear it.
    if (!usingWatcher) {
      await Bun.write(outputFile, "");
      Bun.spawn(["rm", "-f", outputFile]);
    }
  } catch {}

  const fallback = textFallback.trim();

  // If the stream died before the `result` event, totals from `event.usage`
  // were never applied. Back-fill from per-message accumulators so the
  // workpiece records real usage for billing / idle-timeout / wedge cases.
  if (!streamSawResult) {
    totalInputTokens = fallbackInputTokens;
    totalOutputTokens = fallbackOutputTokens;
    totalCacheRead = fallbackCacheRead;
    totalCacheCreation = fallbackCacheCreation;
  }

  if (sessionLogPath) {
    closeSessionLog(sessionLogPath, {
      outcome: "success",
      exit_code: exitCode,
      duration_ms: Date.now() - sessionStartedAt,
      content_bytes: content.length,
      fallback_bytes: fallback.length,
      stderr_preview: stderr.slice(0, 1000),
      tokens: { in: totalInputTokens, out: totalOutputTokens, cache_read: totalCacheRead, cache_creation: totalCacheCreation },
      tokens_from_fallback: !streamSawResult,
      cost_usd: costUsd,
    });
  }

  return {
    content,
    fallbackContent: fallback ? fallback : undefined,
    tokens: { in: totalInputTokens, out: totalOutputTokens, cache_read: totalCacheRead, cache_creation: totalCacheCreation },
    model: `claude-code:${model}`,
    cost_usd: costUsd,
    getLastActivityMs: () => lastActivityMs,
  };
}

/**
 * Map Anthropic model names to Claude Code model aliases.
 */
function mapModelToClaudeCode(model: string): string {
  // Claude Code accepts both full names and aliases
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return model; // pass through
}

/**
 * Inverse of `mapModelToClaudeCode`: map short aliases the station configs use
 * (`opus`, `sonnet`, `haiku`) to full Anthropic Messages API model IDs. The
 * direct SDK rejects bare aliases with `404 not_found_error: model: opus`,
 * which is what broke envelope_nudge for the assembly-dev plan station.
 *
 * Pinned to current 4.x family IDs. Updating these is a deliberate model bump,
 * not a config change — keep in sync with the latest model release.
 */
function mapModelToAnthropicId(model: string): string {
  if (model === "opus") return "claude-opus-4-7";
  if (model === "sonnet") return "claude-sonnet-4-6";
  if (model === "haiku") return "claude-haiku-4-5-20251001";
  return model; // already a full ID or unknown — let the SDK surface the error
}

export function summarizeToolUse(name: string, input: any): string {
  switch (name) {
    case "Read": return `Reading ${input?.file_path ?? "file"}`;
    case "Edit": return `Editing ${input?.file_path ?? "file"}`;
    case "Write": return `Writing ${input?.file_path ?? "file"}`;
    case "Bash": return `Running: ${(input?.command ?? "").slice(0, 60)}`;
    case "Grep": return `Searching for "${(input?.pattern ?? "").slice(0, 40)}"`;
    case "Glob": return `Finding files: ${input?.pattern ?? ""}`;
    case "WebFetch": return `Fetching ${(input?.url ?? "").slice(0, 60)}`;
    case "WebSearch": return `Searching: ${(input?.query ?? "").slice(0, 50)}`;
    default: return `${name}`;
  }
}

export function extractToolInput(name: string, input: any): string {
  switch (name) {
    case "Read": case "Edit": case "Write": return input?.file_path ?? "";
    case "Bash": return (input?.command ?? "").slice(0, 80);
    case "Grep": return input?.pattern ?? "";
    case "Glob": return input?.pattern ?? "";
    case "WebFetch": return (input?.url ?? "").slice(0, 80);
    case "WebSearch": return (input?.query ?? "").slice(0, 60);
    default: return JSON.stringify(input ?? {}).slice(0, 80);
  }
}

// ─── Anthropic Direct API (Repair Path) ─────────────────────────────

export interface AnthropicRepairOptions {
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  client?: Pick<Anthropic, "messages">;
}

/**
 * Direct Anthropic SDK call for envelope repair. Uses Haiku by default —
 * repair is a pure reformat, so the heavyweight claude-code CLI is wasteful.
 *
 * Marks the system block as `cache_control: ephemeral` so repeated repairs
 * within the 5-min TTL hit cache. Throws if no API key is available; callers
 * are expected to fall back to the CLI repair path.
 */
export async function callAnthropicRepair(
  messages: LLMMessage[],
  opts: AnthropicRepairOptions = {}
): Promise<LLMResult> {
  const apiKey = opts.apiKey ?? process.env.ASSEMBLY_ANTHROPIC_API_KEY;
  if (!opts.client && !apiKey) {
    throw new Error("ASSEMBLY_ANTHROPIC_API_KEY not set");
  }

  const model = mapModelToAnthropicId(opts.model ?? DEFAULT_REPAIR_MODEL);
  const maxTokens = opts.maxTokens ?? REPAIR_MAX_TOKENS;

  const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const client = opts.client ?? new Anthropic({ apiKey });

  // The Anthropic API rejects `cache_control` on empty text blocks
  // (`system.0: cache_control cannot be set for empty text blocks`). When the
  // reconstructed history has no system message (e.g. session log missing the
  // first user envelope with `system: "..."`), pass `system` as undefined so
  // the call still succeeds — there's nothing to cache anyway.
  const systemBlocks = systemContent
    ? [{ type: "text" as const, text: systemContent, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  let lastActivityMs = Date.now();
  const response = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages: conversation,
  }).finalMessage();
  lastActivityMs = Date.now();

  const content = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  const usage = response.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = (usage.input_tokens ?? 0) + cacheRead + cacheCreation;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    content,
    tokens: {
      in: inputTokens,
      out: outputTokens,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
    },
    model: `anthropic:${model}`,
    getLastActivityMs: () => lastActivityMs,
  };
}

