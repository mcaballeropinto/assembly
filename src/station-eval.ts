import { resolve } from "path";
import { callScript, callLLM } from "./llm";
import { buildEvalPrompt } from "./prompt";
import { parseEvalResponse } from "./envelope";
import { calculateCostWithCache } from "./pricing";
import type {
  Workpiece,
  StationEnvelope,
  EvalResult,
  EvalConfig,
  Provider,
} from "./types";

/**
 * Run a station's eval against the just-produced envelope and decide what
 * should happen next. Used by both:
 *   - runner.ts (the `assembly run` CLI path)
 *   - section-worker.ts (the daemon path)
 *
 * Shared so the two execution paths obey the same EVAL.md contract.
 */
export async function runStationEval(
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
    // envelope spliced into stations[stationName] so it can read
    // `workpiece.stations.<station>.data` as if the station had been written.
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
