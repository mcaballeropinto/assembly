import { resolve } from "path";
import { mkdirSync, appendFileSync } from "fs";
import { loadLine } from "./line";
import { GLOBAL_RUNS_DIR } from "./paths";
import {
  createWorkpiece,
  writeStation,
  failStation,
  escalateStation,
  saveWorkpiece,
  loadWorkpiece,
  getRunDir,
} from "./workpiece";
import { buildPrompt, buildEvalPrompt, buildEvalRetryPrompt } from "./prompt";
import { callLLM, callScript } from "./llm";
import {
  parseEnvelope,
  parseEvalResponse,
  validateGuardrails,
  buildRepairPrompt,
  EnvelopeError,
} from "./envelope";
import { Logger } from "./logger";
import { writeEvalToMemory } from "./memory";
import { calculateCostWithCache, formatCost } from "./pricing";
import { writeProgress, classifyError } from "./section-worker";
import { sessionLogPathFor } from "./session-log";
import type {
  Workpiece,
  StationConfig,
  StationEnvelope,
  EvalResult,
  EvalConfig,
  LineConfig,
  SequenceStep,
  Provider,
  ProgressCallback,
} from "./types";

export interface RunOptions {
  linePath: string;
  task: string;
  input?: Record<string, unknown>;
  resumeFrom?: string; // workpiece.json path
  fromStation?: string; // resume from this station
  onlyStation?: string; // re-run only this station
  dryRun?: boolean;
}

export async function run(options: RunOptions): Promise<Workpiece> {
  const startTime = Date.now();
  const { config, stations } = await loadLine(options.linePath);

  const defaultProvider: Provider = config.defaults?.provider ?? "api";
  const defaultModel = config.defaults?.model ?? "claude-sonnet-4-20250514";
  const maxTokens = config.defaults?.max_tokens ?? 4096;
  const fallbackModels = config.defaults?.fallback ?? [];
  const contextMode = (config.context as "full" | "summary" | "explicit") ?? "full";

  // Create or resume workpiece
  let workpiece: Workpiece;
  if (options.resumeFrom) {
    workpiece = await loadWorkpiece(options.resumeFrom);
    console.log(`\n📋 Resuming run: ${workpiece.id}`);
  } else {
    workpiece = createWorkpiece(config.name, options.task, options.input);
    console.log(`\n🏭 Starting line: ${config.name}`);
    console.log(`📋 Run ID: ${workpiece.id}`);
  }

  // Set up run directory in ~/.assembly/runs/
  const runDir = getRunDir(GLOBAL_RUNS_DIR, workpiece);
  mkdirSync(runDir, { recursive: true });

  const logger = new Logger(runDir);
  logger.runStart(config.name, options.task);

  // Central activity log for this run — mirrors `queues/activity.jsonl` in the
  // orchestrator path. Receives prompt-size warnings, envelope salvage /
  // nudge events, claude_result_error/ok, etc. from callLLM.
  const activityLogPath = resolve(runDir, "activity.jsonl");

  console.log(`📁 Run dir: ${runDir}`);
  console.log(`📝 Task: ${options.task}\n`);

  if (options.dryRun) {
    return dryRun(config, stations, workpiece);
  }

  // Flatten sequence into executable steps
  const steps = flattenSequence(config.sequence, workpiece);

  // Filter steps if resuming
  let stepsToRun = steps;
  if (options.onlyStation) {
    stepsToRun = steps.filter((s) => s === options.onlyStation);
    if (stepsToRun.length === 0) {
      throw new Error(
        `Station "${options.onlyStation}" not found in sequence`
      );
    }
  } else if (options.fromStation) {
    const idx = steps.indexOf(options.fromStation);
    if (idx === -1) {
      throw new Error(
        `Station "${options.fromStation}" not found in sequence`
      );
    }
    stepsToRun = steps.slice(idx);
  }

  // Track total tokens and cost
  const totalTokens = { in: 0, out: 0, cache_read: 0, cache_creation: 0 };
  let totalCost = 0;

  // Execute each station
  for (let i = 0; i < stepsToRun.length; i++) {
    const stationName = stepsToRun[i];
    const station = stations.get(stationName);

    if (!station) {
      throw new Error(`Station "${stationName}" not found`);
    }

    const stationProvider = station.provider ?? defaultProvider;
    const stationModel = station.model ?? defaultModel;

    console.log(
      `▶ [${i + 1}/${stepsToRun.length}] Running station: ${stationName} (${stationProvider}/${stationModel})`
    );
    logger.stationStart(stationName, `${stationProvider}:${stationModel}`);

    const stationStarted = new Date().toISOString();

    try {
      const effectiveContextMode =
        station.reads && station.reads.length > 0 ? "explicit" : contextMode;

      const maxAttempts = station.eval
        ? 1 + (station.eval.max_retries ?? 1)
        : 1;

      let envelope: StationEnvelope | undefined;
      let evalResult: EvalResult | undefined;
      const cumulativeTokens = { in: 0, out: 0, cache_read: 0, cache_creation: 0 };
      let stationCost = 0;
      const evalTokens = { in: 0, out: 0, cache_read: 0, cache_creation: 0 };
      let evalCost = 0;
      let lastModel = stationModel;
      let evalFeedback: string | undefined;
      let lastRawResponse = "";

      if (stationProvider === "script") {
        // Script provider with optional eval+retry loop. Each attempt:
        //   1. Write workpiece (carrying prior eval feedback when retrying) to
        //      a temp file the script reads.
        //   2. Run the script; parse its stdout envelope.
        //   3. Run eval (script or LLM) if configured; decide retry/fail/etc.
        // Scripts see prior attempts via `workpiece._pending_eval_feedback` —
        // an ephemeral field the runner sets between retries and clears once
        // the attempt completes.
        if (!station.script) {
          throw new Error(
            `Station "${stationName}" uses script provider but has no script field in AGENT.md frontmatter`
          );
        }
        const scriptPath = resolve(station.dir, station.script);
        lastModel = "script";

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          // Save workpiece — include evalFeedback from the prior attempt so
          // the script can thread it into its own agent prompt.
          const wpForScript = evalFeedback
            ? { ...workpiece, _pending_eval_feedback: { station: stationName, feedback: evalFeedback, attempt } }
            : workpiece;
          const tempWorkpiecePath = `/tmp/assembly-workpiece-${workpiece.id}-${stationName}-${attempt}.json`;
          await Bun.write(tempWorkpiecePath, JSON.stringify(wpForScript, null, 2));

          try {
            const response = await callScript(scriptPath, tempWorkpiecePath);
            envelope = parseEnvelope(response.content);
          } finally {
            try {
              await Bun.write(tempWorkpiecePath, "");
              Bun.spawn(["rm", "-f", tempWorkpiecePath]);
            } catch {}
          }

          // Validate guardrails
          const guardrailErrors = validateGuardrails(envelope, station);
          if (guardrailErrors.length > 0) {
            console.log(`  ⚠ Guardrail warnings: ${guardrailErrors.join(", ")}`);
          }

          if (!station.eval) break;

          const decision = await runStationEval(
            station.eval,
            stationName,
            station.dir,
            envelope,
            workpiece,
            stationProvider,
            stationModel,
            maxTokens,
            attempt,
            maxAttempts
          );

          evalResult = decision.evalResult;
          evalTokens.in += decision.tokens.in;
          evalTokens.out += decision.tokens.out;
          evalTokens.cache_read += decision.tokens.cache_read ?? 0;
          evalTokens.cache_creation += decision.tokens.cache_creation ?? 0;
          evalCost += decision.cost_usd;
          cumulativeTokens.in += decision.tokens.in;
          cumulativeTokens.out += decision.tokens.out;
          cumulativeTokens.cache_read += decision.tokens.cache_read ?? 0;
          cumulativeTokens.cache_creation += decision.tokens.cache_creation ?? 0;
          stationCost += decision.cost_usd;

          if (decision.outcome === "pass") break;
          if (decision.outcome === "warn") break;
          if (decision.outcome === "fail") {
            throw new Error(`Eval failed: ${evalResult.feedback}`);
          }
          if (decision.outcome === "escalate" || (decision.outcome === "retry" && attempt === maxAttempts)) {
            const reason = decision.outcome === "escalate"
              ? evalResult.feedback
              : `Max retries exhausted. Last eval: ${evalResult.feedback}`;
            console.log(decision.outcome === "escalate"
              ? `  🚨 Eval requested escalation`
              : `  🚨 Max retries exhausted — auto-escalating`);
            console.log(`  📋 Feedback: ${evalResult.feedback}`);
            workpiece = escalateStation(workpiece, stationName, reason, {
              model: lastModel,
              tokens: cumulativeTokens,
              cost_usd: stationCost,
              started_at: stationStarted,
              finished_at: new Date().toISOString(),
            });
            workpiece.stations[stationName].eval = { ...evalResult, tokens: evalTokens, cost_usd: evalCost };
            totalTokens.in += cumulativeTokens.in;
            totalTokens.out += cumulativeTokens.out;
            totalTokens.cache_read += cumulativeTokens.cache_read;
            totalTokens.cache_creation += cumulativeTokens.cache_creation;
            totalCost += stationCost;
            logger.stationEnd(stationName, "escalated", cumulativeTokens);
            await saveWorkpiece(workpiece, runDir);
            workpiece = { ...workpiece, totals: { tokens: totalTokens, cost_usd: totalCost } };
            await saveWorkpiece(workpiece, runDir);
            const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
            logger.runEnd("escalated", totalTokens, duration);
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`🚨 Pipeline escalated at station: ${stationName}`);
            console.log(`   Reason: ${evalResult.feedback}`);
            console.log(`   Workpiece: ${resolve(runDir, "workpiece.json")}`);
            console.log(`   Resume with: assembly run <line> --resume ${resolve(runDir, "workpiece.json")} --from ${stationName}\n`);
            return workpiece;
          }

          // retry
          evalFeedback = evalResult.feedback;
          console.log(`  🔄 Retrying station with eval feedback (attempt ${attempt + 1}/${maxAttempts})…`);
        }
      } else {
        // Invocation-scoped envelope path lives under the run directory per
        // station. Same-named loop iterations and retries overwrite this file
        // (callClaudeCode deletes it pre-call for a clean slate).
        const stationEnvelopeDir = resolve(runDir, "stations", stationName);
        mkdirSync(stationEnvelopeDir, { recursive: true });
        const envelopePath = resolve(stationEnvelopeDir, "envelope.json");

        // Per-station diagnostic logs — identical shape to the orchestrator
        // path (section-worker.ts), just rooted at the runDir instead of the
        // queue. session.jsonl gets the raw claude-code stream-json + meta;
        // progress.jsonl gets summarized tool ticks; activityLogPath
        // accumulates cross-station events.
        const sessionLogPath = sessionLogPathFor(resolve(stationEnvelopeDir, "workpiece"));
        const progressPath = resolve(stationEnvelopeDir, "progress.jsonl");
        const lastActivityRef = { ms: Date.now() };
        const stationStartMs = Date.now();

        const activityLogger = (event: string, detail: Record<string, unknown>) => {
          try {
            appendFileSync(activityLogPath, JSON.stringify({
              ts: new Date().toISOString(),
              event,
              station: stationName,
              run_id: workpiece.id,
              ...detail,
            }) + "\n");
          } catch {}
        };

        const onProgress: ProgressCallback = (evt) => {
          writeProgress(progressPath, stationStartMs, lastActivityRef, "llm", "running", evt.detail, {
            tool: evt.tool,
            tool_input: evt.tool_input,
            tokens: evt.tokens,
            cost_usd: evt.cost_usd,
            turns: evt.turns,
          });
        };

        // Existing LLM-based attempt loop
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          // Build the prompt (with eval feedback on retries)
          const messages =
            attempt === 1 || !evalFeedback
              ? buildPrompt(station, workpiece, effectiveContextMode)
              : buildEvalRetryPrompt(
                  station,
                  workpiece,
                  lastRawResponse,
                  evalFeedback
                );

          writeProgress(progressPath, stationStartMs, lastActivityRef, "llm", "started", `${stationProvider} (${stationModel})`);

          // Call the LLM
          const response = await callLLM(
            messages,
            stationModel,
            maxTokens,
            fallbackModels,
            stationProvider,
            onProgress,
            undefined,
            activityLogger,
            sessionLogPath,
            station.tools,
            envelopePath
          );

          writeProgress(progressPath, stationStartMs, lastActivityRef, "llm", "done", `${response.tokens.out} tokens out`, {
            tokens: response.tokens,
          });

          cumulativeTokens.in += response.tokens.in;
          cumulativeTokens.out += response.tokens.out;
          cumulativeTokens.cache_read += response.tokens.cache_read ?? 0;
          cumulativeTokens.cache_creation += response.tokens.cache_creation ?? 0;
          stationCost += calculateCostWithCache(response.model, response.tokens.in, response.tokens.out, response.tokens.cache_read ?? 0, response.tokens.cache_creation ?? 0);
          lastModel = response.model;
          lastRawResponse = response.content;

          // Parse the envelope
          try {
            envelope = parseEnvelope(response.content);
          } catch (err) {
            if (err instanceof EnvelopeError) {
              console.log(
                `  ⚠ Invalid envelope, retrying with repair prompt...`
              );
              const repairPrompt = buildRepairPrompt(
                response.content,
                err.message
              );
              const retryMessages = [
                messages[0],
                { role: "user" as const, content: repairPrompt },
              ];
              writeProgress(progressPath, stationStartMs, lastActivityRef, "repair", "started", "Retrying with repair prompt");
              const retryResponse = await callLLM(
                retryMessages,
                stationModel,
                maxTokens,
                fallbackModels,
                stationProvider,
                onProgress,
                undefined,
                activityLogger,
                sessionLogPath,
                station.tools,
                envelopePath
              );
              writeProgress(progressPath, stationStartMs, lastActivityRef, "repair", "done", `${retryResponse.tokens.out} tokens out`);
              envelope = parseEnvelope(retryResponse.content);
              cumulativeTokens.in += retryResponse.tokens.in;
              cumulativeTokens.out += retryResponse.tokens.out;
              cumulativeTokens.cache_read += retryResponse.tokens.cache_read ?? 0;
              cumulativeTokens.cache_creation += retryResponse.tokens.cache_creation ?? 0;
              stationCost += calculateCostWithCache(retryResponse.model, retryResponse.tokens.in, retryResponse.tokens.out, retryResponse.tokens.cache_read ?? 0, retryResponse.tokens.cache_creation ?? 0);
            } else {
              throw err;
            }
          }

          // Validate guardrails
          const guardrailErrors = validateGuardrails(envelope, station);
          if (guardrailErrors.length > 0) {
            console.log(
              `  ⚠ Guardrail warnings: ${guardrailErrors.join(", ")}`
            );
          }

          // Run eval if configured
          if (station.eval) {
            const evalProvider = station.eval.provider ?? stationProvider;
            const evalModel = station.eval.model ?? stationModel;

            console.log(
              `  🔍 Evaluating output (attempt ${attempt}/${maxAttempts})...`
            );

            const evalMessages = buildEvalPrompt(
              station.eval,
              stationName,
              envelope,
              workpiece
            );

            writeProgress(progressPath, stationStartMs, lastActivityRef, "eval", "started", `${evalProvider} (${evalModel})`);
            const evalResponse = await callLLM(
              evalMessages,
              evalModel,
              maxTokens,
              [],
              evalProvider,
              onProgress,
              undefined,
              activityLogger,
              sessionLogPath
            );
            writeProgress(progressPath, stationStartMs, lastActivityRef, "eval", "done", `${evalResponse.tokens.out} tokens out`);

            cumulativeTokens.in += evalResponse.tokens.in;
            cumulativeTokens.out += evalResponse.tokens.out;
            cumulativeTokens.cache_read += evalResponse.tokens.cache_read ?? 0;
            cumulativeTokens.cache_creation += evalResponse.tokens.cache_creation ?? 0;
            evalTokens.in += evalResponse.tokens.in;
            evalTokens.out += evalResponse.tokens.out;
            evalTokens.cache_read += evalResponse.tokens.cache_read ?? 0;
            evalTokens.cache_creation += evalResponse.tokens.cache_creation ?? 0;
            const thisEvalCost = calculateCostWithCache(evalResponse.model, evalResponse.tokens.in, evalResponse.tokens.out, evalResponse.tokens.cache_read ?? 0, evalResponse.tokens.cache_creation ?? 0);
            stationCost += thisEvalCost;
            evalCost += thisEvalCost;

            try {
              evalResult = parseEvalResponse(evalResponse.content);
            } catch {
              console.log(`  ⚠ Could not parse eval response, treating as pass`);
              evalResult = {
                pass: true,
                feedback: "Eval response unparseable — skipped",
              };
            }

            const scoreStr =
              evalResult.score !== undefined ? ` (score: ${evalResult.score})` : "";

            if (evalResult.pass) {
              console.log(`  ✅ Eval passed${scoreStr}: ${evalResult.feedback}`);
              break;
            }

            // Eval failed
            console.log(
              `  ❌ Eval failed${scoreStr}: ${evalResult.feedback}`
            );

            // Determine action: eval's action field overrides, frontmatter on_fail is fallback
            const evalAction = evalResult.action ?? station.eval.on_fail ?? "retry";

            if (evalAction === "warn") {
              console.log(`  ⚠ on_fail=warn — continuing with current output`);
              break;
            }

            if (evalAction === "fail") {
              throw new Error(
                `Eval failed: ${evalResult.feedback}`
              );
            }

            if (evalAction === "escalate") {
              console.log(`  🚨 Eval requested escalation — stopping pipeline`);
              console.log(`  📋 Feedback: ${evalResult.feedback}`);
              workpiece = escalateStation(workpiece, stationName, evalResult.feedback, {
                model: lastModel,
                tokens: cumulativeTokens,
                cost_usd: stationCost,
                started_at: stationStarted,
                finished_at: new Date().toISOString(),
              });
              workpiece.stations[stationName].eval = {
                ...evalResult,
                tokens: evalTokens,
                cost_usd: evalCost,
              };
              totalTokens.in += cumulativeTokens.in;
              totalTokens.out += cumulativeTokens.out;
              totalTokens.cache_read += cumulativeTokens.cache_read;
              totalTokens.cache_creation += cumulativeTokens.cache_creation;
              totalCost += stationCost;
              logger.stationEnd(stationName, "escalated", cumulativeTokens);
              await saveWorkpiece(workpiece, runDir);
              workpiece = { ...workpiece, totals: { tokens: totalTokens, cost_usd: totalCost } };
              await saveWorkpiece(workpiece, runDir);
              const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
              logger.runEnd("escalated", totalTokens, duration);
              console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
              console.log(`🚨 Pipeline escalated at station: ${stationName}`);
              console.log(`   Reason: ${evalResult.feedback}`);
              console.log(`   Workpiece: ${resolve(runDir, "workpiece.json")}`);
              console.log(`   Resume with: assembly run <line> --resume ${resolve(runDir, "workpiece.json")} --from ${stationName}\n`);
              return workpiece;
            }

            // evalAction === "retry"
            if (attempt < maxAttempts) {
              evalFeedback = evalResult.feedback;
              console.log(`  🔄 Retrying station with eval feedback...`);
            } else {
              // Max retries exhausted — auto-escalate instead of silently using last output
              console.log(`  🚨 Max retries exhausted — auto-escalating`);
              workpiece = escalateStation(workpiece, stationName, `Max retries exhausted. Last eval: ${evalResult.feedback}`, {
                model: lastModel,
                tokens: cumulativeTokens,
                cost_usd: stationCost,
                started_at: stationStarted,
                finished_at: new Date().toISOString(),
              });
              workpiece.stations[stationName].eval = {
                ...evalResult,
                tokens: evalTokens,
                cost_usd: evalCost,
              };
              totalTokens.in += cumulativeTokens.in;
              totalTokens.out += cumulativeTokens.out;
              totalTokens.cache_read += cumulativeTokens.cache_read;
              totalTokens.cache_creation += cumulativeTokens.cache_creation;
              totalCost += stationCost;
              logger.stationEnd(stationName, "escalated", cumulativeTokens);
              await saveWorkpiece(workpiece, runDir);
              workpiece = { ...workpiece, totals: { tokens: totalTokens, cost_usd: totalCost } };
              await saveWorkpiece(workpiece, runDir);
              const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
              logger.runEnd("escalated", totalTokens, duration);
              console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
              console.log(`🚨 Pipeline escalated at station: ${stationName} (max retries exhausted)`);
              console.log(`   Reason: ${evalResult.feedback}`);
              console.log(`   Workpiece: ${resolve(runDir, "workpiece.json")}`);
              console.log(`   Resume with: assembly run <line> --resume ${resolve(runDir, "workpiece.json")} --from ${stationName}\n`);
              return workpiece;
            }
          }
        }
      }

      // Write to workpiece
      workpiece = writeStation(workpiece, stationName, envelope!, {
        model: lastModel,
        tokens: cumulativeTokens,
        cost_usd: stationCost,
        started_at: stationStarted,
        finished_at: new Date().toISOString(),
      });

      // Attach eval result if present
      if (evalResult) {
        workpiece.stations[stationName].eval = {
          ...evalResult,
          tokens: evalTokens,
          cost_usd: evalCost,
        };

        // Write eval feedback to station memory
        if (evalResult.feedback) {
          await writeEvalToMemory(station, evalResult);
        }
      }

      totalTokens.in += cumulativeTokens.in;
      totalTokens.out += cumulativeTokens.out;
      totalTokens.cache_read += cumulativeTokens.cache_read;
      totalTokens.cache_creation += cumulativeTokens.cache_creation;
      totalCost += stationCost;

      logger.stationEnd(stationName, "done", cumulativeTokens);

      console.log(`  ✓ ${envelope!.summary}`);
      console.log(
        `    tokens: ${cumulativeTokens.in} in / ${cumulativeTokens.out} out | cost: ${formatCost(stationCost)}${evalCost > 0 ? ` (eval: ${formatCost(evalCost)})` : ""}\n`
      );
    } catch (err) {
      const error = err as Error;
      const failureClass = classifyError(error);
      console.error(`  ✗ Station failed [${failureClass}]: ${error.message}\n`);

      workpiece = failStation(workpiece, stationName, error.message, {
        model: stationModel,
        tokens: { in: 0, out: 0 },
        started_at: stationStarted,
        finished_at: new Date().toISOString(),
      }, failureClass);

      logger.stationEnd(stationName, "failed", { in: 0, out: 0 });

      try {
        appendFileSync(activityLogPath, JSON.stringify({
          ts: new Date().toISOString(),
          event: "station_failed",
          station: stationName,
          run_id: workpiece.id,
          failure_class: failureClass,
          error: error.message.slice(0, 500),
        }) + "\n");
      } catch {}
    }

    // Checkpoint — save after every station
    await saveWorkpiece(workpiece, runDir);
  }

  // Save totals to workpiece
  workpiece = {
    ...workpiece,
    totals: {
      tokens: totalTokens,
      cost_usd: totalCost,
    },
  };
  await saveWorkpiece(workpiece, runDir);

  const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  const allDone = Object.values(workpiece.stations).every(
    (s) => s.status === "done"
  );

  logger.runEnd(allDone ? "done" : "partial", totalTokens, duration);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${allDone ? "✅" : "⚠️"} Line complete: ${config.name}`);
  console.log(
    `   Tokens: ${totalTokens.in} in / ${totalTokens.out} out`
  );
  console.log(`   Cost: ${formatCost(totalCost)}`);
  console.log(`   Duration: ${duration}`);
  console.log(`   Workpiece: ${resolve(runDir, "workpiece.json")}\n`);

  return workpiece;
}

/**
 * Run a station's eval — LLM or script — and return a routing decision.
 *
 * The eval's `provider` decides transport: "script" runs a binary that writes
 * `{pass, feedback, score?, action?}` JSON to stdout; anything else falls back
 * to the LLM path. Script evals are cheaper and deterministic — ideal for
 * gates like "do tests pass?" where an LLM adds no value. The eval's own
 * `action` field wins over `on_fail` frontmatter when both are set.
 */
async function runStationEval(
  evalConfig: EvalConfig,
  stationName: string,
  stationDir: string,
  envelope: StationEnvelope,
  workpiece: Workpiece,
  stationProvider: Provider,
  stationModel: string,
  maxTokens: number,
  attempt: number,
  maxAttempts: number
): Promise<{
  outcome: "pass" | "warn" | "fail" | "retry" | "escalate";
  evalResult: EvalResult;
  tokens: { in: number; out: number; cache_read: number; cache_creation: number };
  cost_usd: number;
}> {
  console.log(`  🔍 Evaluating output (attempt ${attempt}/${maxAttempts})...`);

  let evalResult: EvalResult;
  const tokens = { in: 0, out: 0, cache_read: 0, cache_creation: 0 };
  let cost_usd = 0;

  if (evalConfig.provider === "script") {
    if (!evalConfig.script) {
      throw new Error(
        `Eval for station "${stationName}" uses provider="script" but has no "script" field in EVAL.md frontmatter`
      );
    }
    const evalScriptPath = resolve(stationDir, evalConfig.script);
    // The eval script sees the full workpiece including the just-produced
    // envelope. Merging envelope into a synthetic "pending" slot would be
    // confusing — instead, we write the station's current envelope into its
    // own key so the eval can read `workpiece.stations.<station>.data` as if
    // the station had just been written normally.
    const wpForEval: Workpiece = {
      ...workpiece,
      stations: {
        ...workpiece.stations,
        [stationName]: {
          status: "done",
          summary: envelope.summary,
          content: envelope.content,
          data: envelope.data,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          model: "script",
          tokens: { in: 0, out: 0 },
          cost_usd: 0,
        },
      },
    };
    const tempEvalWorkpiece = `/tmp/assembly-eval-${workpiece.id}-${stationName}-${attempt}.json`;
    await Bun.write(tempEvalWorkpiece, JSON.stringify(wpForEval, null, 2));
    try {
      const evalResponse = await callScript(evalScriptPath, tempEvalWorkpiece);
      try {
        evalResult = parseEvalResponse(evalResponse.content);
      } catch {
        console.log(`  ⚠ Could not parse eval response, treating as pass`);
        evalResult = { pass: true, feedback: "Eval response unparseable — skipped" };
      }
    } finally {
      try {
        await Bun.write(tempEvalWorkpiece, "");
        Bun.spawn(["rm", "-f", tempEvalWorkpiece]);
      } catch {}
    }
  } else {
    const evalProvider = evalConfig.provider ?? stationProvider;
    const evalModel = evalConfig.model ?? stationModel;
    const evalMessages = buildEvalPrompt(evalConfig, stationName, envelope, workpiece);
    const evalResponse = await callLLM(evalMessages, evalModel, maxTokens, [], evalProvider);
    tokens.in = evalResponse.tokens.in;
    tokens.out = evalResponse.tokens.out;
    tokens.cache_read = evalResponse.tokens.cache_read ?? 0;
    tokens.cache_creation = evalResponse.tokens.cache_creation ?? 0;
    cost_usd = calculateCostWithCache(evalResponse.model, tokens.in, tokens.out, tokens.cache_read, tokens.cache_creation);
    try {
      evalResult = parseEvalResponse(evalResponse.content);
    } catch {
      console.log(`  ⚠ Could not parse eval response, treating as pass`);
      evalResult = { pass: true, feedback: "Eval response unparseable — skipped" };
    }
  }

  const scoreStr = evalResult.score !== undefined ? ` (score: ${evalResult.score})` : "";

  if (evalResult.pass) {
    console.log(`  ✅ Eval passed${scoreStr}: ${evalResult.feedback}`);
    return { outcome: "pass", evalResult, tokens, cost_usd };
  }

  console.log(`  ❌ Eval failed${scoreStr}: ${evalResult.feedback}`);

  const action = evalResult.action ?? evalConfig.on_fail ?? "retry";
  if (action === "warn") {
    console.log(`  ⚠ on_fail=warn — continuing with current output`);
    return { outcome: "warn", evalResult, tokens, cost_usd };
  }
  if (action === "fail") return { outcome: "fail", evalResult, tokens, cost_usd };
  if (action === "escalate") return { outcome: "escalate", evalResult, tokens, cost_usd };
  return { outcome: "retry", evalResult, tokens, cost_usd };
}

/**
 * Flatten sequence into a simple list of station names to execute.
 * Handles parallel (runs sequentially for now), gates, and loops.
 */
function flattenSequence(
  sequence: SequenceStep[],
  _workpiece: Workpiece
): string[] {
  const result: string[] = [];

  for (const step of sequence) {
    if (typeof step === "string") {
      result.push(step);
    } else if ("parallel" in step) {
      // TODO: actual parallel execution
      // For now, run sequentially
      result.push(...step.parallel);
    } else if ("gate" in step) {
      // Gates are evaluated at runtime during execution
      // For flattening, include both paths (actual selection happens in execute)
      // For now, we'll add a placeholder — real gate logic in v2
      result.push(step.gate.if_true);
    } else if ("loop" in step) {
      // Loops expand at runtime — for now, add stations once
      result.push(...step.loop.stations);
    }
  }

  return result;
}

/**
 * Dry run — show what would execute without calling any models.
 */
function dryRun(
  config: LineConfig,
  stations: Map<string, StationConfig>,
  workpiece: Workpiece
): Workpiece {
  console.log(`🔍 Dry run — showing execution plan:\n`);

  const steps = flattenSequence(config.sequence, workpiece);

  for (let i = 0; i < steps.length; i++) {
    const name = steps[i];
    const station = stations.get(name);
    const provider = station?.provider ?? config.defaults?.provider ?? "api";
    const model = station?.model ?? config.defaults?.model ?? "claude-sonnet-4-20250514";
    const reads = station?.reads?.join(", ") ?? "(all previous)";

    console.log(`  ${i + 1}. ${name}`);
    console.log(`     Provider: ${provider}`);
    console.log(`     Model: ${model}`);
    console.log(`     Reads: ${reads}`);
    if (provider === "script" && station?.script) {
      console.log(`     Script: ${station.script}`);
    }
    if (station?.guardrails) {
      console.log(`     Guardrails: ✓`);
    }
    if (station?.eval) {
      const evalProvider = station.eval.provider ?? provider;
      const evalModel = station.eval.model ?? model;
      const onFail = station.eval.on_fail ?? "retry";
      const maxRetries = station.eval.max_retries ?? 1;
      console.log(`     Eval: ✓ (${evalProvider}/${evalModel}, on_fail=${onFail}, max_retries=${maxRetries})`);
    }
    console.log();
  }

  // Show on_complete triggers if configured
  if (config.on_complete?.length) {
    console.log(`  On Complete Triggers:`);
    for (const trigger of config.on_complete) {
      const passKeys = trigger.pass ? Object.keys(trigger.pass).join(", ") : "(none)";
      const cond = trigger.condition ? ` [if ${trigger.condition}]` : "";
      const label = trigger.target ?? `<dynamic via ${trigger.target_path}>`;
      console.log(`    → ${label}${cond}`);
      console.log(`      Pass: ${passKeys}`);
    }
    console.log();
  }

  console.log(`Total stations: ${steps.length}`);
  return workpiece;
}
