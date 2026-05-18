/**
 * End-to-end test: a rogue file written directly into a section inbox
 * is quarantined and the worker never spawns on it. This is the
 * integration test that proves the producer-allowlist defense works at
 * the orchestrator layer, not just at the unit-tested manifest module.
 */

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { startOrchestrator } from "../orchestrator";
import { createWorkpiece } from "../workpiece";
import { __resetUsageGateStateForTest } from "../usage";

function createScriptLine(linePath: string, stationName: string): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: rogue-test\nsequence:\n  - ${stationName}\n`
  );
  const stationDir = resolve(linePath, "stations", stationName);
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(
    resolve(stationDir, "AGENT.md"),
    `---\nprovider: script\nscript: ok.ts\n---\n`
  );
  writeFileSync(
    resolve(stationDir, "ok.ts"),
    `console.log(JSON.stringify({ summary: "ok" }));\n`
  );
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

const orchestrators: Array<{ stop: () => void | Promise<void> }> = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;

beforeEach(() => {
  const snapDir = resolve("/tmp", `assembly-test-rogue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(snapDir, { recursive: true });
  tempDirs.push(snapDir);
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = resolve(snapDir, "usage-status.json");

  try {
    const credsDir = join(homedir(), ".claude");
    const credsPath = join(credsDir, ".credentials.json");
    mkdirSync(credsDir, { recursive: true });
    const existing = Bun.file(credsPath);
    if (!(existing.size && existing.size > 0)) {
      writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
    }
  } catch {}

  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : String(url);
    if (urlStr.includes("/api/oauth/usage")) {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" },
          seven_day: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url as any);
  }) as typeof fetch;

  __resetUsageGateStateForTest();
});

afterEach(async () => {
  for (const o of orchestrators.splice(0)) {
    try { await o.stop(); } catch {}
  }
  await new Promise((r) => setTimeout(r, 200));
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  globalThis.fetch = originalFetch;
  if (originalSnapEnv === undefined) delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
  else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalSnapEnv;
  __resetUsageGateStateForTest();
});

describe("producer-allowlist end-to-end", () => {
  test(
    "rogue file dropped into a section inbox is quarantined to .unverified/",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-rogue-line-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      createScriptLine(linePath, "the-station");

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);
      await new Promise((r) => setTimeout(r, 200));

      // Mimic the observed rogue-agent pattern: drop a fake fanout JSON
      // directly into the section inbox via raw writeFileSync, with NO
      // recordEmit. This is what a Bash-armed agent does when it fakes
      // fanout output instead of reporting a real fetch failure.
      const wp = createWorkpiece("rogue-test", "should never run");
      const stationInbox = resolve(linePath, "stations", "the-station", "queue", "inbox");
      const dropPath = resolve(stationInbox, `${wp.id}.json`);
      writeFileSync(dropPath, JSON.stringify(wp, null, 2));

      // The orchestrator's drainInbox must (a) move the file to .unverified/
      // and (b) NOT spawn a worker (no done/ entry, no processing/ entry).
      const unverifiedDir = resolve(stationInbox, ".unverified");
      const reachedQuarantine = await waitFor(
        () => existsSync(unverifiedDir) && readdirSync(unverifiedDir).length > 0,
        5_000
      );
      expect(reachedQuarantine).toBe(true);

      // Original drop path is gone (quarantineUnverified moved it).
      expect(existsSync(dropPath)).toBe(false);

      // Quarantined name is timestamp-prefixed for collision-safety.
      const quarantined = readdirSync(unverifiedDir);
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]).toMatch(new RegExp(`-${wp.id}\\.json$`));

      // No done/, no processing/ — worker never ran.
      const doneDir = resolve(linePath, "queues", "done");
      expect(readdirSync(doneDir).filter((f) => f.endsWith(".json")).length).toBe(0);

      // The activity log should carry a `producer_unknown` event for forensics.
      const logPath = resolve(linePath, "queues", "activity.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const text = await Bun.file(logPath).text();
      expect(text).toContain("producer_unknown");
    },
    15_000
  );
});
