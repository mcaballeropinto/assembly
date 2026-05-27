#!/usr/bin/env bun
/**
 * Section Worker ��� Standalone process spawned by the orchestrator.
 *
 * Usage: bun run section-worker.ts <station-dir> <workpiece-path>
 *
 * 1. Reads the workpiece from the given path (already in queue/processing/)
 * 2. Loads AGENT.md from the station dir
 * 3. Calls the LLM
 * 4. Writes the result back to the workpiece
 * 5. Moves the workpiece to queue/output/
 */

import { resolve, basename } from "path";
import { renameSync, appendFileSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import YAML from "yaml";
import { loadStation } from "./station";
import { buildPrompt } from "./prompt";
import { callLLM, callScript, mergeClaudeEnv, callAnthropicRepair, DEFAULT_REPAIR_MODEL } from "./llm";
import { calculateCostWithCache } from "./pricing";
import { parseEnvelope, EnvelopeError, GuardrailError, buildRepairPrompt, buildGuardrailRepairPrompt, validateGuardrails } from "./envelope";
import { nudgeForEnvelope } from "./envelope-nudge";
import { writeStation, failStation, escalateStation } from "./workpiece";
import { runStationEval } from "./station-eval";
import { loadEnvFiles } from "./paths";
import { sessionLogPathFor, unlinkSessionLog, moveSessionLogAlongside } from "./session-log";
import { unlinkStderrLog, moveStderrLogAlongside } from "./stderr-log";
import { computeRoundsFromProgress } from "./tool-rounds";
import type { Workpiece, Provider, ProgressCallback, ProgressEvent, HeartbeatConfig, LLMMessage, LLMResult, RepairConfig, FailureClass, OnEventCallback, StationEnvelope, EvalResult } from "./types";
import { appendTaskEvent, initTaskEventDir, updateTaskEventIndex } from "./task-events";

const HEARTBEAT_MS = 30_000;

// ─── Repair Helpers ──────────────────────────────────────────────────

export type RepairTransport =
  | { kind: "anthropic"; model: string }
  | { kind: "cli"; reason: "disabled" | "no_api_key" };

/**
 * Decide which transport to use for envelope repair.
 *
 * Direct Anthropic API + Haiku is the default — cheaper and faster than
 * respawning the full claude-code CLI for a pure JSON reformat. Falls back
 * to the CLI when the line opts out (`repair.enabled: false`) or when no
 * API key is available.
 */
export function selectRepairTransport(
  repairConfig: RepairConfig | undefined,
  env: { ASSEMBLY_ANTHROPIC_API_KEY?: string | undefined }
): RepairTransport {
  const enabled = repairConfig?.enabled !== false;
  if (!enabled) return { kind: "cli", reason: "disabled" };
  if (!env.ASSEMBLY_ANTHROPIC_API_KEY) return { kind: "cli", reason: "no_api_key" };
  return { kind: "anthropic", model: repairConfig?.model ?? DEFAULT_REPAIR_MODEL };
}

export type RepairSeedSource = "content" | "fallback" | "none";

export interface RepairPlan {
  messages: LLMMessage[];
  seedSource: RepairSeedSource;
  seedBytes: number;
}

/**
 * Build the message stack and seed telemetry for a repair call.
 *
 * Stack: [system, original user, seeded assistant, repair instruction].
 * Seed order: response.content → response.fallbackContent → placeholder.
 * The assistant turn gives the model the broken output to reformat; the
 * original user turn restores task context that the old single-message
 * repair call dropped.
 */
export function buildRepairPlan(
  originalMessages: LLMMessage[],
  response: Pick<LLMResult, "content" | "fallbackContent">,
  errorMessage: string
): RepairPlan {
  const content = response.content ?? "";
  const fallback = response.fallbackContent ?? "";
  const seedText = content || fallback || "";
  const seedSource: RepairSeedSource = content
    ? "content"
    : fallback
    ? "fallback"
    : "none";
  const repairPrompt = buildRepairPrompt(content, errorMessage, fallback || undefined);
  const messages: LLMMessage[] = [
    originalMessages[0],
    originalMessages[1],
    { role: "assistant", content: seedText || "(no output captured)" },
    { role: "user", content: repairPrompt },
  ];
  return { messages, seedSource, seedBytes: seedText.length };
}

/**
 * Build a repair plan for a guardrail failure — the JSON was valid but the
 * shape didn't match the station's schema. Seeds the assistant turn with the
 * (valid) envelope JSON that failed validation so Haiku can fix it in place,
 * and uses `buildGuardrailRepairPrompt` which references the schema contract
 * explicitly rather than lecturing about JSON formatting.
 */
export function buildGuardrailRepairPlan(
  originalMessages: LLMMessage[],
  envelopeJson: string,
  violations: string[],
  guardrails: { required?: string[]; forbidden?: string[]; schema?: Record<string, unknown> } | undefined
): RepairPlan {
  const repairPrompt = buildGuardrailRepairPrompt(envelopeJson, violations, guardrails);
  const messages: LLMMessage[] = [
    originalMessages[0],
    originalMessages[1],
    { role: "assistant", content: envelopeJson || "(no output captured)" },
    { role: "user", content: repairPrompt },
  ];
  return { messages, seedSource: "content", seedBytes: envelopeJson.length };
}

// ─── Failure Classification ──────────────────────────────────────────

/**
 * Classify a thrown error into a FailureClass for the orchestrator retry policy.
 *
 * The orchestrator uses the class to pick a retry budget:
 *   envelope  — in-station repair already ran; a full re-run rarely helps
 *   guardrail — envelope parsed but violated the station's schema, and repair failed too
 *   provider  — upstream API transient; keep a generous retry budget
 *   crash     — process exited non-zero; worth a retry or two
 *   timeout   — handled separately by the SIGTERM path, but kept here for completeness
 *   unknown   — conservative fallback (legacy behaviour)
 *
 * Classification order: instanceof check first, then message inspection so
 * subclassed errors keep their canonical class regardless of wording.
 */
export function classifyError(err: Error): FailureClass {
  if (err instanceof GuardrailError) return "guardrail";
  if (err instanceof EnvelopeError) return "envelope";
  const msg = err.message ?? "";
  // Provider/API signatures — rate limits, auth, overload, network.
  if (/\b(rate[- ]?limit|overloaded|ANTHROPIC_API_KEY|API (?:error|key)|HTTP 4\d{2}|HTTP 5\d{2}|ETIMEDOUT|ECONNRESET|ECONNREFUSED|429|5\d{2}\b)/i.test(msg)) {
    return "provider";
  }
  // Worker process signatures — non-zero exit, signal death, missing output.
  if (/exited with code|All models failed|produced no output|killed by signal|SIGKILL|SIGTERM/i.test(msg)) {
    return "crash";
  }
  // Assembly's in-process stdout-idle watchdog (llm.ts) — conceptually the same
  // as a station-level idle timeout, just enforced one layer deeper. Use the
  // same FailureClass so retry policy treats it identically.
  if (/stream stalled|stall watchdog/i.test(msg)) {
    return "timeout";
  }
  return "unknown";
}

// ─── Progress File Writer ────────────────────────────────────────────

export function writeProgress(
  progressPath: string,
  stationStart: number,
  lastActivityRef: { ms: number },
  phase: string,
  status: string,
  detail?: string,
  extra?: Record<string, unknown>
) {
  lastActivityRef.ms = Date.now();
  const event: ProgressEvent = {
    ts: new Date().toISOString(),
    phase: phase as ProgressEvent["phase"],
    status: status as ProgressEvent["status"],
    detail,
    elapsed_s: Math.round((Date.now() - stationStart) / 1000),
    ...extra,
  };
  try {
    appendFileSync(progressPath, JSON.stringify(event) + "\n");
  } catch {}
}

// ─── Heartbeat ───────────────────��───────────────────────────────────

/**
 * Periodically append a `station_heartbeat` event to the line's activity log
 * while the station is running. Lets the dashboard distinguish "still alive"
 * from "wedged" for long-running stations that won't emit anything else until
 * they finish.
 *
 * When lastActivityRef is provided, heartbeats carry child-liveness annotations:
 *   child_live: boolean — true if last activity was within one interval
 *   last_activity_ts: ISO string — when the child last produced output
 *   silent_s: number — seconds since last child activity
 */
export function startHeartbeat(
  linePath: string,
  stationName: string,
  workpieceName: string,
  startedAtMs: number,
  lastActivityRef?: { ms: number },
  heartbeatConfig?: HeartbeatConfig,
  onTick?: (tick: number, elapsedS: number, silentS: number) => void
): () => void {
  const activityLogPath = resolve(linePath, "queues", "activity.jsonl");
  const intervalMs = heartbeatConfig?.interval_ms ?? HEARTBEAT_MS;
  const emitWhenSilent = heartbeatConfig?.emit_when_silent ?? true;
  let tick = 0;

  const timer = setInterval(() => {
    tick++;

    // Compute child liveness fields if ref is available
    let livenessFields: Record<string, unknown> = {};
    if (lastActivityRef) {
      const silentMs = Date.now() - lastActivityRef.ms;
      const child_live = silentMs < intervalMs;
      const silent_s = Math.floor(silentMs / 1000);
      const last_activity_ts = new Date(lastActivityRef.ms).toISOString();

      // Optionally suppress heartbeats during silence
      if (!child_live && !emitWhenSilent) return;

      livenessFields = { child_live, last_activity_ts, silent_s };
    }

    const entry = {
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: stationName,
      workpiece: workpieceName,
      tick,
      elapsed_s: Math.floor((Date.now() - startedAtMs) / 1000),
      ...livenessFields,
    };
    try {
      appendFileSync(activityLogPath, JSON.stringify(entry) + "\n");
    } catch {
      // best-effort — heartbeat must never throw
    }
    if (onTick) {
      try {
        const silentS = lastActivityRef ? Math.floor((Date.now() - lastActivityRef.ms) / 1000) : 0;
        onTick(tick, entry.elapsed_s, silentS);
      } catch {}
    }
  }, intervalMs || HEARTBEAT_MS);
  return () => clearInterval(timer);
}

async function main() {
  loadEnvFiles();

  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      "Usage: section-worker.ts <station-dir> <workpiece-path>"
    );
    process.exit(1);
  }

  const stationDir = resolve(args[0]);
  const workpiecePath = resolve(args[1]);
  const stationName = basename(stationDir);
  const outputDir = resolve(stationDir, "queue", "output");
  // stationDir is <linePath>/stations/<stationName>, so linePath is two levels up
  const linePath = resolve(stationDir, "..", "..");

  // Load station config
  const station = await loadStation(stationDir, stationName);

  // Load workpiece
  let workpiece: Workpiece = JSON.parse(
    await Bun.file(workpiecePath).text()
  );

  const provider: Provider = station.provider ?? "claude-code";
  const model = station.model ?? "sonnet";
  const maxTokens = 16384;

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  // Per-task scratch dir. Pinned as cwd for both script and claude-code
  // providers so any sloppy relative-path writes from station agents land in
  // a disposable /tmp location instead of polluting the assembly tree.
  // The workpiece id + basename keeps collisions impossible across concurrent
  // tasks; the rmSync(...) call at the end of every exit path drops it.
  const scratchCwd = resolve(
    tmpdir(),
    `assembly-scratch-${workpiece.id}-${basename(workpiecePath, ".json")}`
  );
  mkdirSync(scratchCwd, { recursive: true });
  // Single registration covers every exit path (normal return, process.exit,
  // uncaught throw) — avoids threading cleanup through ~10 exit sites.
  process.on("exit", () => {
    try { rmSync(scratchCwd, { recursive: true, force: true }); } catch {}
  });

  // Stations that read a known codebase can override cwd to that repo so
  // cwd-relative tools (Glob, Bash `find`) hit the right files. Falls back
  // to the scratch dir when not set.
  const effectiveCwd = station.cwd && existsSync(station.cwd) ? station.cwd : scratchCwd;

  // Progress + session diagnostic tracking
  const progressPath = workpiecePath + ".progress.jsonl";
  const sessionLogPath = sessionLogPathFor(workpiecePath);
  // Invocation-scoped envelope sidecar. Lives next to the workpiece so it
  // travels through queue rename moves (inbox → processing → output). Unique
  // per invocation because each section-worker owns one workpiecePath at a
  // time; loops/retries get fresh workpiece files.
  const envelopePath = workpiecePath + ".envelope.json";
  const lastActivityRef = { ms: Date.now() };

  // ─── Load line-level config for claude_env and heartbeat ───────────
  let lineClaudeEnv: Record<string, string> | undefined;
  let stationClaudeEnv: Record<string, string> | undefined;
  let heartbeatConfig: HeartbeatConfig | undefined;
  let repairConfig: RepairConfig | undefined;
  try {
    const lineYaml = YAML.parse(await Bun.file(resolve(linePath, "line.yaml")).text());
    lineClaudeEnv = lineYaml?.defaults?.claude_env;
    heartbeatConfig = lineYaml?.heartbeat;
    repairConfig = lineYaml?.defaults?.repair;
    // Check for per-station overrides in sequence
    for (const step of lineYaml?.sequence ?? []) {
      if (typeof step === 'object' && 'station' in step && step.station?.name === stationName) {
        stationClaudeEnv = step.station.claude_env;
        if (step.station.heartbeat) heartbeatConfig = { ...heartbeatConfig, ...step.station.heartbeat };
        if (step.station.repair) repairConfig = { ...repairConfig, ...step.station.repair };
      }
    }
  } catch {}

  const effectiveClaudeEnv = (provider === 'claude-code' || provider === 'claude-code-cached') ? mergeClaudeEnv(lineClaudeEnv, stationClaudeEnv) : undefined;

  // Emit claude_provider_spawned activity event
  const activityLogPath = resolve(linePath, "queues", "activity.jsonl");
  if ((provider === 'claude-code' || provider === 'claude-code-cached') && effectiveClaudeEnv) {
    try {
      appendFileSync(activityLogPath, JSON.stringify({
        ts: new Date().toISOString(),
        event: "claude_provider_spawned",
        station: stationName,
        workpiece: basename(workpiecePath),
        effective_env: effectiveClaudeEnv,
      }) + "\n");
    } catch {}
  }

  // Initialise task-events storage and emit lifecycle started event
  initTaskEventDir(linePath, workpiece.id);
  updateTaskEventIndex(linePath, workpiece.id, stationName, "running", startedAt);
  appendTaskEvent(linePath, workpiece.id, stationName, {
    kind: "lifecycle",
    summary: "Started",
    detail: { subtype: "started", model, provider },
  });

  // Create onProgress callback for LLM calls
  const onProgress: ProgressCallback = (evt) => {
    writeProgress(progressPath, startedAtMs, lastActivityRef, "llm", "running", evt.detail, {
      tool: evt.tool,
      tool_input: evt.tool_input,
      tokens: evt.tokens,
      cost_usd: evt.cost_usd,
      turns: evt.turns,
    });
  };

  // onEvent callback: persist AI activity events to task-events storage
  const onEvent: OnEventCallback = (evt) => {
    appendTaskEvent(linePath, workpiece.id, stationName, evt);
  };

  // Emit heartbeats while the work runs. `stopHeartbeat` must be called before
  // every return/exit/throw path so timers don't linger.
  const stopHeartbeat = startHeartbeat(
    linePath,
    stationName,
    basename(workpiecePath),
    startedAtMs,
    lastActivityRef,
    heartbeatConfig,
    (tick, elapsedS, silentS) => {
      appendTaskEvent(linePath, workpiece.id, stationName, {
        kind: "heartbeat",
        summary: `tick ${tick} · elapsed ${elapsedS}s · silent ${silentS}s`,
      });
    },
  );

  // Helper: clean up progress file
  function cleanupProgress() {
    try { unlinkSync(progressPath); } catch {}
  }

  // Envelope sidecar lifecycle. The sidecar at `workpiecePath + ".envelope.json"`
  // is the LLM's structured output; once the station finalizes, its content is
  // baked into `workpiece.stations[stationName]` so the sidecar is redundant.
  // Mirror the session-log pattern: drop on success, preserve alongside on
  // failure for post-mortem. Without these calls the file orphans in
  // processing/ and inflates the daemon's flow counters even though the task
  // already moved to done/ or error/.
  function unlinkEnvelopeSidecar() {
    try { unlinkSync(envelopePath); } catch {}
  }
  function moveEnvelopeSidecarAlongside(newWorkpiecePath: string) {
    try { renameSync(envelopePath, newWorkpiecePath + ".envelope.json"); } catch {}
  }

  // Helper: roll up the progress sidecar into stations[stationName].rounds.
  // Called immediately before writing the workpiece to disk at every finalize
  // path so the rounds summary survives the progress-file unlink.
  function attachRounds(wp: Workpiece): Workpiece {
    const rounds = computeRoundsFromProgress(progressPath);
    if (rounds && wp.stations[stationName]) {
      wp.stations[stationName].rounds = rounds;
    }
    return wp;
  }

  // --- Graceful-flush handlers ---
  //
  // SIGTERM: orchestrator's idle/wall-clock watchdog fired. Classify as
  // `timeout` (the worker really did go silent past the threshold).
  //
  // SIGUSR2: orchestrator is shutting down. Classify as `aborted` (we're
  // killing the worker by choice, not because anything broke). The
  // orchestrator's stop() sends SIGUSR2 to every active worker before
  // SIGKILL'ing stragglers.
  //
  // Both handlers re-read the workpiece from disk (may be more current
  // than the in-memory copy, e.g. partial writes), then either flush a
  // completed result or write a failStation envelope and move to output/.
  let flushing = false;
  function gracefulFlush(reason: "timeout" | "aborted") {
    if (flushing) return; // guard against re-entry / both signals firing
    flushing = true;
    try {
      const diskData = readFileSync(workpiecePath, 'utf-8');
      const diskWorkpiece = JSON.parse(diskData) as Workpiece;
      const stationResult = diskWorkpiece.stations[stationName];

      if (stationResult?.status === 'done') {
        const outPath = resolve(outputDir, basename(workpiecePath));
        renameSync(workpiecePath, outPath);
        // Successful flush — keep nothing extra. unlink before the post-rename
        // move so the file moves out of processing/ cleanly. Idempotent.
        unlinkStderrLog(workpiecePath);
        unlinkEnvelopeSidecar();
        const flushFinishedAt = new Date().toISOString();
        appendTaskEvent(linePath, diskWorkpiece.id, stationName, {
          kind: "lifecycle",
          summary: "Finished",
          detail: { subtype: "finished" },
        });
        updateTaskEventIndex(linePath, diskWorkpiece.id, stationName, "ok", startedAt, flushFinishedAt);
        stopHeartbeat();
        cleanupProgress();
        console.log(JSON.stringify({
          status: reason === "timeout" ? 'timeout_flushed' : 'aborted_flushed',
          station: stationName,
          summary: 'Station completed before signal — flushing to output',
        }));
        process.exit(0);
      } else {
        const elapsedS = Math.floor((Date.now() - startedAtMs) / 1000);
        const summary = reason === "timeout"
          ? `idle timeout after ${elapsedS}s`
          : `aborted by daemon shutdown after ${elapsedS}s`;
        const failed = attachRounds(failStation(diskWorkpiece, stationName, summary, {
          model: `${provider}:${model}`,
          tokens: { in: 0, out: 0 },
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        }, reason));
        writeFileSync(workpiecePath, JSON.stringify(failed, null, 2));
        const outPath = resolve(outputDir, basename(workpiecePath));
        renameSync(workpiecePath, outPath);
        // Failure flush — preserve stderr for post-mortem.
        moveStderrLogAlongside(workpiecePath, outPath);
        moveEnvelopeSidecarAlongside(outPath);
        const flushFailedAt = new Date().toISOString();
        const flushStatus = reason === "timeout" ? "timeout" : "aborted";
        appendTaskEvent(linePath, diskWorkpiece.id, stationName, {
          kind: "lifecycle",
          summary: reason === "timeout" ? `Timeout: ${summary}` : `Aborted: ${summary}`,
          detail: { subtype: flushStatus, elapsed_s: elapsedS },
        });
        updateTaskEventIndex(linePath, diskWorkpiece.id, stationName, flushStatus, startedAt, flushFailedAt);
        stopHeartbeat();
        cleanupProgress();
        console.log(JSON.stringify({
          status: reason === "timeout" ? 'timeout_failed' : 'aborted_failed',
          station: stationName,
          error: summary,
        }));
        process.exit(1);
      }
    } catch (err) {
      console.error(`${reason} flush failed: ${(err as Error).message}`);
      stopHeartbeat();
      process.exit(1);
    }
  }
  // Signal protocol:
  //   SIGUSR1 — orchestrator's idle watchdog fired → "timeout"
  //   SIGUSR2 — orchestrator's explicit graceful shutdown (stop()) → "aborted"
  //   SIGTERM — systemd KillMode=control-group cascade (or anything external).
  //             Always treated as "aborted" because systemd never sends
  //             SIGUSR1; if we got SIGTERM, the daemon isn't asking us to die,
  //             something outside the daemon is. Previously this used a
  //             parent-alive heuristic that raced with the zombie window
  //             after SIGKILL on the daemon and misclassified 161 aborts as
  //             timeouts across one 12-hour run.
  process.on('SIGUSR1', () => gracefulFlush("timeout"));
  process.on('SIGUSR2', () => gracefulFlush("aborted"));
  process.on('SIGTERM', () => gracefulFlush("aborted"));

  // Script provider — no LLM, no prompt. With optional eval+retry loop:
  // when EVAL.md is present, after each script run we invoke the station's
  // eval and, on `action: retry`, thread its feedback into the workpiece's
  // ephemeral `_pending_eval_feedback` slot so the script can show it to its
  // own agent on the next attempt. Mirrors runner.ts's script-provider loop
  // so the daemon and CLI paths obey the same EVAL.md contract.
  if (provider === "script") {
    if (!station.script) {
      stopHeartbeat();
      throw new Error(
        `Station "${stationName}" uses script provider but has no script field`
      );
    }
    const scriptPath = resolve(stationDir, station.script);
    const maxAttempts = station.eval ? 1 + (station.eval.max_retries ?? 1) : 1;

    let envelope: StationEnvelope | undefined;
    let evalResult: EvalResult | undefined;
    let evalFeedback: string | undefined;
    const evalTokens = { in: 0, out: 0, cache_read: 0, cache_creation: 0 };
    let evalCost = 0;
    type Outcome = "pass" | "warn" | "fail" | "retry" | "escalate";
    let outcome: Outcome = "pass";

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Thread prior eval feedback through `_pending_eval_feedback` on the
        // workpiece file the script reads. Develop/plan scripts already look
        // for this slot (develop.ts:262) and surface it in their agent prompt.
        if (evalFeedback) {
          const wpWithFeedback = {
            ...workpiece,
            _pending_eval_feedback: { station: stationName, feedback: evalFeedback, attempt },
          };
          await Bun.write(workpiecePath, JSON.stringify(wpWithFeedback, null, 2));
        }

        const attemptLabel = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";
        writeProgress(progressPath, startedAtMs, lastActivityRef, "script", "started", `Running ${station.script}${attemptLabel}`);
        const response = await callScript(scriptPath, workpiecePath, lastActivityRef, effectiveCwd);
        writeProgress(progressPath, startedAtMs, lastActivityRef, "script", "done", `Script completed${attemptLabel}`);
        envelope = parseEnvelope(response.content);

        if (!station.eval) {
          outcome = "pass";
          break;
        }

        writeProgress(progressPath, startedAtMs, lastActivityRef, "eval", "started", `Evaluating attempt ${attempt}/${maxAttempts}`);
        const decision = await runStationEval(
          station.eval,
          stationName,
          stationDir,
          envelope,
          workpiece,
          provider,
          model,
          maxTokens,
          attempt,
          maxAttempts
        );
        writeProgress(progressPath, startedAtMs, lastActivityRef, "eval", "done", `outcome=${decision.outcome}`);

        evalResult = decision.evalResult;
        evalTokens.in += decision.tokens.in;
        evalTokens.out += decision.tokens.out;
        evalTokens.cache_read += decision.tokens.cache_read;
        evalTokens.cache_creation += decision.tokens.cache_creation;
        evalCost += decision.cost_usd;

        outcome = decision.outcome;
        if (outcome === "pass" || outcome === "warn") break;
        if (outcome === "fail") {
          throw new Error(`Eval failed: ${evalResult.feedback}`);
        }
        if (outcome === "escalate") break;
        // retry — exhaust check, otherwise loop with feedback threaded in
        if (attempt === maxAttempts) {
          outcome = "escalate"; // auto-escalate on retry exhaustion (mirrors runner.ts:227)
          break;
        }
        evalFeedback = evalResult.feedback;
        console.log(`  🔄 Retrying station with eval feedback (attempt ${attempt + 1}/${maxAttempts})…`);
      }

      const finishedAt = new Date().toISOString();
      const outputPath = resolve(outputDir, basename(workpiecePath));

      if (outcome === "escalate") {
        const reason = evalResult?.feedback ?? "Eval requested escalation";
        const wasExhausted = (station.eval && evalResult && evalResult.action !== "escalate");
        const escalationReason = wasExhausted
          ? `Max retries exhausted (${maxAttempts}). Last eval: ${reason}`
          : reason;

        workpiece = escalateStation(workpiece, stationName, escalationReason, {
          model: "script",
          tokens: evalTokens,
          cost_usd: evalCost,
          started_at: startedAt,
          finished_at: finishedAt,
        });
        workpiece.stations[stationName].eval = { ...evalResult!, tokens: evalTokens, cost_usd: evalCost };
        workpiece = attachRounds(workpiece);
        await Bun.write(workpiecePath, JSON.stringify(workpiece, null, 2));
        renameSync(workpiecePath, outputPath);
        moveStderrLogAlongside(workpiecePath, outputPath);
        moveEnvelopeSidecarAlongside(outputPath);

        console.log(
          JSON.stringify({
            status: "escalated",
            station: stationName,
            summary: escalationReason.slice(0, 200),
          })
        );
        cleanupProgress();
        appendTaskEvent(linePath, workpiece.id, stationName, {
          kind: "lifecycle",
          summary: "Escalated: " + escalationReason.slice(0, 200),
          detail: { subtype: "escalated", reason: escalationReason.slice(0, 500) },
        });
        updateTaskEventIndex(linePath, workpiece.id, stationName, "escalated", startedAt, finishedAt);
        stopHeartbeat();
        return;
      }

      // pass or warn — write the station as done with eval cost/tokens folded in
      workpiece = writeStation(workpiece, stationName, envelope!, {
        model: "script",
        tokens: { in: evalTokens.in, out: evalTokens.out },
        cost_usd: evalCost,
        started_at: startedAt,
        finished_at: finishedAt,
      });
      if (station.eval && evalResult) {
        workpiece.stations[stationName].eval = { ...evalResult, tokens: evalTokens, cost_usd: evalCost };
      }

      workpiece = attachRounds(workpiece);
      await Bun.write(workpiecePath, JSON.stringify(workpiece, null, 2));
      renameSync(workpiecePath, outputPath);
      unlinkStderrLog(workpiecePath);
      unlinkEnvelopeSidecar();

      console.log(
        JSON.stringify({
          status: "done",
          station: stationName,
          summary: envelope!.summary,
          tokens: { in: evalTokens.in, out: evalTokens.out },
        })
      );
      cleanupProgress();
      appendTaskEvent(linePath, workpiece.id, stationName, {
        kind: "lifecycle",
        summary: "Finished",
        detail: { subtype: "finished" },
      });
      updateTaskEventIndex(linePath, workpiece.id, stationName, "ok", startedAt, finishedAt);
      stopHeartbeat();
      return; // Exit early — don't fall through to LLM path
    } catch (err) {
      const error = err as Error;
      const failureClass = classifyError(error);

      workpiece = failStation(workpiece, stationName, error.message, {
        model: "script",
        tokens: { in: evalTokens.in, out: evalTokens.out },
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      }, failureClass);

      workpiece = attachRounds(workpiece);
      await Bun.write(workpiecePath, JSON.stringify(workpiece, null, 2));
      const outputPath = resolve(outputDir, basename(workpiecePath));
      renameSync(workpiecePath, outputPath);
      moveStderrLogAlongside(workpiecePath, outputPath);
      moveEnvelopeSidecarAlongside(outputPath);

      console.log(
        JSON.stringify({
          status: "failed",
          station: stationName,
          error: error.message,
          failure_class: failureClass,
        })
      );

      cleanupProgress();
      const scriptFailedAt = new Date().toISOString();
      appendTaskEvent(linePath, workpiece.id, stationName, {
        kind: "lifecycle",
        summary: "Failed: " + error.message.slice(0, 200),
        detail: { subtype: "failed", error: error.message.slice(0, 500), failure_class: failureClass },
      });
      updateTaskEventIndex(linePath, workpiece.id, stationName, "error", startedAt, scriptFailedAt);
      stopHeartbeat();
      process.exit(1);
    }
  }

  try {
    // Build prompt
    const contextMode =
      station.reads && station.reads.length > 0 ? "explicit" : "full";
    const messages = buildPrompt(station, workpiece, contextMode);

    writeProgress(progressPath, startedAtMs, lastActivityRef, "prompt", "started", "Building prompt");
    writeProgress(progressPath, startedAtMs, lastActivityRef, "prompt", "done", `Prompt built: ${messages.length} messages`);

    // Build activity logger for prompt-size telemetry
    const activityLogger = (event: string, detail: Record<string, unknown>) => {
      try {
        appendFileSync(activityLogPath, JSON.stringify({
          ts: new Date().toISOString(),
          event,
          station: stationName,
          workpiece: basename(workpiecePath),
          ...detail,
        }) + "\n");
      } catch {}
    };

    // Call LLM
    writeProgress(progressPath, startedAtMs, lastActivityRef, "llm", "started", `${provider} (${model})`);
    const response = await callLLM(messages, model, maxTokens, [], provider, onProgress, effectiveClaudeEnv, activityLogger, sessionLogPath, station.tools, envelopePath, onEvent, effectiveCwd);
    writeProgress(progressPath, startedAtMs, lastActivityRef, "llm", "done", `${response.tokens.out} tokens out`, {
      tokens: response.tokens,
    });

    // Parse envelope. The envelope file is authoritative; if it's missing or
    // unparseable, try salvaging JSON from the assistant text blocks captured
    // during streaming before paying for a repair call.
    let envelope;
    try {
      envelope = parseEnvelope(response.content);
    } catch (err) {
      if (!(err instanceof EnvelopeError)) {
        throw err;
      }

      // Stage 1: salvage from streamed assistant text
      if (response.fallbackContent) {
        try {
          envelope = parseEnvelope(response.fallbackContent);
          activityLogger("envelope_salvaged_from_stream", {
            file_empty: !response.content,
            fallback_bytes: response.fallbackContent.length,
          });
        } catch {
          // Fall through to repair path below
        }
      }

      // Stage 1.5: in-session nudge — replay message history + one JSON-only turn.
      if (!envelope) {
        try {
          activityLogger("envelope_nudge_started", {
            session_log: sessionLogPath,
          });
          writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "started", "In-session nudge for envelope");
          const nudgeResult = await nudgeForEnvelope({
            sessionLogPath,
            station,
            errorMessage: err.message,
            model,
          });
          if (nudgeResult) {
            envelope = parseEnvelope(nudgeResult.content);
            activityLogger("envelope_nudged_in_session", {
              tokens_in: nudgeResult.tokens.in,
              tokens_out: nudgeResult.tokens.out,
            });
            // Merge nudge tokens + cost into the station result.
            response.tokens.in += nudgeResult.tokens.in;
            response.tokens.out += nudgeResult.tokens.out;
            response.tokens.cache_read = (response.tokens.cache_read ?? 0) + (nudgeResult.tokens.cache_read ?? 0);
            response.tokens.cache_creation = (response.tokens.cache_creation ?? 0) + (nudgeResult.tokens.cache_creation ?? 0);

            const nudgeCost = calculateCostWithCache(
              model,
              nudgeResult.tokens.in,
              nudgeResult.tokens.out,
              nudgeResult.tokens.cache_read ?? 0,
              nudgeResult.tokens.cache_creation ?? 0,
            );
            activityLogger("nudge_provider", {
              provider: "anthropic",
              model,
              tokens: nudgeResult.tokens,
              cost_usd: nudgeCost,
            });
            writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "done", "Envelope nudged in-session");
          }
        } catch (nudgeErr) {
          activityLogger("envelope_nudge_failed", {
            error: (nudgeErr as Error).message?.slice(0, 300),
          });
          // Fall through to Stage 2.
        }
      }

      // Stage 2: repair prompt (only if salvage didn't produce an envelope).
      if (!envelope) {
        const plan = buildRepairPlan(messages, response, err.message);
        activityLogger("envelope_repair_started", {
          seed_source: plan.seedSource,
          seed_bytes: plan.seedBytes,
        });
        writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "started", "Envelope parse failed, retrying");

        const transport = selectRepairTransport(repairConfig, {
          ASSEMBLY_ANTHROPIC_API_KEY: process.env.ASSEMBLY_ANTHROPIC_API_KEY,
        });

        let retryResponse: LLMResult;
        let repairProvider: string;
        let repairModelUsed: string;

        if (transport.kind === "anthropic") {
          repairProvider = "anthropic";
          repairModelUsed = transport.model;
          retryResponse = await callAnthropicRepair(plan.messages, { model: transport.model });
        } else {
          activityLogger("repair_skipped_direct_api", { reason: transport.reason });
          writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "failed", `skipped: ${transport.reason}`);
          throw err;
        }

        const repairCost = calculateCostWithCache(
          repairModelUsed,
          retryResponse.tokens.in,
          retryResponse.tokens.out,
          retryResponse.tokens.cache_read ?? 0,
          retryResponse.tokens.cache_creation ?? 0,
        );
        activityLogger("repair_provider", {
          provider: repairProvider,
          model: repairModelUsed,
          tokens: retryResponse.tokens,
          cost_usd: repairCost,
          response_bytes: retryResponse.content.length,
        });

        try {
          envelope = parseEnvelope(retryResponse.content);
        } catch (parseErr) {
          activityLogger("repair_parse_failed", {
            error: (parseErr as Error).message,
            response_bytes: retryResponse.content.length,
          });
          throw parseErr;
        }

        response.tokens.in += retryResponse.tokens.in;
        response.tokens.out += retryResponse.tokens.out;
        response.tokens.cache_read = (response.tokens.cache_read ?? 0) + (retryResponse.tokens.cache_read ?? 0);
        response.tokens.cache_creation = (response.tokens.cache_creation ?? 0) + (retryResponse.tokens.cache_creation ?? 0);

        writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "done", "Envelope repaired");
      }
    }

    // ─── Guardrail validation ───────────────────────────────────────
    // The envelope parsed, but the shape may still be wrong (e.g. a score
    // station emitting `data.enriched_items` instead of `data.scored_items`).
    // When `guardrails.output` is declared in AGENT.md frontmatter, validate
    // here and — on failure — run the same Haiku repair path we use for parse
    // errors, but with a shape-aware prompt. One repair attempt; if it still
    // fails, throw a GuardrailError classified as `failure_class: "guardrail"`.
    const guardrailErrors = validateGuardrails(envelope, station);
    if (guardrailErrors.length > 0) {
      activityLogger("envelope_guardrail_failed", {
        violations: guardrailErrors,
      });
      writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "started", `Guardrail failed: ${guardrailErrors.length} violations`);

      const transport = selectRepairTransport(repairConfig, {
        ASSEMBLY_ANTHROPIC_API_KEY: process.env.ASSEMBLY_ANTHROPIC_API_KEY,
      });

      if (transport.kind !== "anthropic") {
        activityLogger("guardrail_repair_skipped", { reason: transport.reason });
        throw new GuardrailError(guardrailErrors);
      }

      const envelopeJson = JSON.stringify(envelope);
      const guardrailPlan = buildGuardrailRepairPlan(
        messages,
        envelopeJson,
        guardrailErrors,
        station.guardrails?.output
      );

      let repaired;
      try {
        const retryResponse = await callAnthropicRepair(guardrailPlan.messages, { model: transport.model });
        const repairCost = calculateCostWithCache(
          transport.model,
          retryResponse.tokens.in,
          retryResponse.tokens.out,
          retryResponse.tokens.cache_read ?? 0,
          retryResponse.tokens.cache_creation ?? 0,
        );
        activityLogger("guardrail_repair_provider", {
          provider: "anthropic",
          model: transport.model,
          tokens: retryResponse.tokens,
          cost_usd: repairCost,
          response_bytes: retryResponse.content.length,
        });
        response.tokens.in += retryResponse.tokens.in;
        response.tokens.out += retryResponse.tokens.out;
        response.tokens.cache_read = (response.tokens.cache_read ?? 0) + (retryResponse.tokens.cache_read ?? 0);
        response.tokens.cache_creation = (response.tokens.cache_creation ?? 0) + (retryResponse.tokens.cache_creation ?? 0);
        repaired = parseEnvelope(retryResponse.content);
      } catch (repairErr) {
        activityLogger("guardrail_repair_failed", {
          error: (repairErr as Error).message,
        });
        throw new GuardrailError(guardrailErrors);
      }

      const stillBroken = validateGuardrails(repaired, station);
      if (stillBroken.length > 0) {
        activityLogger("guardrail_repair_failed", {
          violations_before: guardrailErrors,
          violations_after: stillBroken,
        });
        throw new GuardrailError(stillBroken);
      }

      envelope = repaired;
      activityLogger("envelope_guardrail_repaired", {
        violations_before: guardrailErrors,
      });
      writeProgress(progressPath, startedAtMs, lastActivityRef, "repair", "done", "Guardrail repaired");
    }

    // Write success to workpiece
    workpiece = writeStation(workpiece, stationName, envelope, {
      model: response.model,
      tokens: response.tokens,
      cost_usd: response.cost_usd ?? 0,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });

    // Write result and move to output
    workpiece = attachRounds(workpiece);
    await Bun.write(workpiecePath, JSON.stringify(workpiece, null, 2));
    const outputPath = resolve(outputDir, basename(workpiecePath));
    renameSync(workpiecePath, outputPath);
    // Station succeeded — drop the session diagnostic log and stderr sidecar.
    unlinkSessionLog(workpiecePath);
    unlinkStderrLog(workpiecePath);
    unlinkEnvelopeSidecar();

    // Report success to stdout (orchestrator reads this)
    console.log(
      JSON.stringify({
        status: "done",
        station: stationName,
        summary: envelope.summary,
        tokens: response.tokens,
      })
    );
    cleanupProgress();
    const finishedAt = new Date().toISOString();
    appendTaskEvent(linePath, workpiece.id, stationName, {
      kind: "lifecycle",
      summary: "Finished",
      detail: { subtype: "finished" },
    });
    updateTaskEventIndex(linePath, workpiece.id, stationName, "ok", startedAt, finishedAt);
    stopHeartbeat();
  } catch (err) {
    const error = err as Error;
    const failureClass = classifyError(error);

    // Write failure to workpiece
    workpiece = failStation(workpiece, stationName, error.message, {
      model: `${provider}:${model}`,
      tokens: { in: 0, out: 0 },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    }, failureClass);

    // Write result and move to output (orchestrator decides retry vs error).
    // Session log travels with the workpiece so post-mortem is possible from
    // wherever it lands (output/ → error/ via orchestrator routing).
    workpiece = attachRounds(workpiece);
    await Bun.write(workpiecePath, JSON.stringify(workpiece, null, 2));
    const outputPath = resolve(outputDir, basename(workpiecePath));
    renameSync(workpiecePath, outputPath);
    moveSessionLogAlongside(workpiecePath, outputPath);
    moveStderrLogAlongside(workpiecePath, outputPath);
    moveEnvelopeSidecarAlongside(outputPath);

    // Report failure to stdout
    console.log(
      JSON.stringify({
        status: "failed",
        station: stationName,
        error: error.message,
        failure_class: failureClass,
      })
    );

    cleanupProgress();
    const failedAt = new Date().toISOString();
    appendTaskEvent(linePath, workpiece.id, stationName, {
      kind: "lifecycle",
      summary: "Failed: " + error.message.slice(0, 200),
      detail: { subtype: "failed", error: error.message.slice(0, 500), failure_class: failureClass },
    });
    updateTaskEventIndex(linePath, workpiece.id, stationName, "error", startedAt, failedAt);
    stopHeartbeat();
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported for testing)
if (import.meta.main) {
  main().catch((err) => {
    console.error(`Section worker fatal: ${err.message}`);
    process.exit(1);
  });
}
