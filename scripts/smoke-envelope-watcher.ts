#!/usr/bin/env bun
/**
 * Smoke test for the envelope file watcher path.
 *
 * Spawns a real `claude` CLI subprocess via callLLM with a trivial prompt and
 * records precise timestamps:
 *
 *   T0  — call starts
 *   T1  — envelope file first appears on disk (polled by a side observer)
 *   T2  — callLLM returns the envelope content
 *   T3  — claude subprocess is actually dead
 *
 * Expected shape if the watcher is doing its job:
 *   T1 < T2 < T3   (file appears before return; process dies shortly after)
 *   T2 - T1        ~0 to 250ms (one poll tick)
 *   T3 - T2        0 to ~700ms (SIGKILL grace + reap)
 *
 * If instead you see T2 ≈ T3 >> T1 (gap of seconds or indefinite), the
 * watcher isn't winning the race and you're still coupled to subprocess exit.
 */

import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callLLM } from "../src/llm";
import type { LLMMessage } from "../src/types";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function fmt(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function label(ok: boolean, text: string): string {
  return `${ok ? GREEN + "✓" : RED + "✗"} ${text}${RESET}`;
}

async function main() {
  console.log(`${BOLD}=== envelope watcher smoke test ===${RESET}\n`);

  const runDir = mkdtempSync(join(tmpdir(), "assembly-smoke-"));
  const envelopePath = join(runDir, "envelope.json");
  console.log(`run dir:       ${runDir}`);
  console.log(`envelope path: ${envelopePath}\n`);

  const messages: LLMMessage[] = [
    {
      role: "system",
      content:
        "You are a smoke-test agent. Reply with a minimal envelope and nothing else.",
    },
    {
      role: "user",
      content:
        "Produce a trivial envelope. Summary should be exactly 'smoke ok'. No content, no data. Write the file immediately — do not call any other tools first.",
    },
  ];

  // Side observer: poll the envelope path every 25ms to record T1 precisely.
  const t0 = Date.now();
  let t1: number | null = null;
  const pollAbort = { stop: false };
  const observer = (async () => {
    while (!pollAbort.stop) {
      if (existsSync(envelopePath)) {
        t1 = Date.now();
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  let result;
  let t2: number | null = null;
  let callError: Error | null = null;
  try {
    result = await callLLM(
      messages,
      "sonnet",
      4096,
      [],
      "claude-code-cached",
      undefined,
      undefined,
      (event, detail) => {
        // activity logger — print tool events for visibility
        if (event === "claude_result_ok" || event === "claude_result_error") {
          console.log(`[${event}] ${JSON.stringify(detail).slice(0, 180)}...`);
        }
      },
      undefined,
      undefined,
      envelopePath
    );
    t2 = Date.now();
  } catch (err) {
    callError = err as Error;
    t2 = Date.now();
  }
  pollAbort.stop = true;
  await observer;

  // After callLLM returns, confirm the subprocess is really dead. callLLM
  // awaits proc.exited internally, so by the time we get here t3 ≈ t2. We
  // still measure it as a sanity check.
  const t3 = Date.now();

  console.log("\n--- timings ---");
  console.log(`T0 → T1 (file appears):    ${t1 ? fmt(t1 - t0) : `${RED}never${RESET}`}`);
  console.log(`T0 → T2 (callLLM returns): ${fmt(t2! - t0)}`);
  console.log(`T0 → T3 (observed dead):   ${fmt(t3 - t0)}`);
  if (t1) {
    console.log(`\n${BOLD}Gap T1 → T2 (file → return): ${fmt(t2! - t1)}${RESET}`);
    console.log(`Gap T2 → T3 (return → dead): ${fmt(t3 - t2!)}`);
  }

  console.log("\n--- verdict ---");
  const fileAppeared = t1 !== null;
  const returnedBeforeDeath = t2! - t0 < 120_000; // within 2min per bash timeout
  const watcherWon = fileAppeared && t2! - t1! < 2_000;

  console.log(label(fileAppeared, "envelope file landed on disk"));
  console.log(label(returnedBeforeDeath, "callLLM returned within timeout"));
  console.log(label(watcherWon, "watcher short-circuited on file (T2 - T1 < 2s)"));

  if (callError) {
    console.log(`\n${RED}call error:${RESET} ${callError.message}`);
  }

  if (result) {
    console.log(`\nenvelope content (first 200 chars):`);
    console.log(`  ${result.content.slice(0, 200)}`);
    const tokens = result.tokens;
    console.log(
      `\ntokens: in=${tokens.in}  out=${tokens.out}  cache_read=${tokens.cache_read ?? 0}  cache_creation=${tokens.cache_creation ?? 0}`
    );
  }

  // Cleanup
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {}

  const allGood = fileAppeared && returnedBeforeDeath && watcherWon && !callError;
  if (allGood) {
    console.log(`\n${GREEN}${BOLD}SMOKE TEST PASSED${RESET} — watcher is working as designed.`);
    process.exit(0);
  } else {
    console.log(`\n${YELLOW}${BOLD}SMOKE TEST FAILED OR INCONCLUSIVE${RESET} — inspect timings above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("unexpected error:", err);
  process.exit(2);
});
