import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { startOrchestrator } from "../orchestrator";
import { createWorkpiece } from "../workpiece";
import { __resetUsageGateStateForTest } from "../usage";
import { recordEmit } from "../emit-manifest";
import { LineName } from "../ids";

/**
 * Create a minimal line with `provider: script` stations that immediately
 * emit a valid envelope. Lets the orchestrator boot without any LLM deps.
 */
function createScriptLine(linePath: string, stationNames: string[]): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });

  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: inbox-watcher-test\nsequence:\n${stationNames.map((n) => `  - ${n}`).join("\n")}\n`
  );

  for (const name of stationNames) {
    const stationDir = resolve(linePath, "stations", name);
    mkdirSync(stationDir, { recursive: true });
    writeFileSync(
      resolve(stationDir, "AGENT.md"),
      `---\nprovider: script\nscript: ok.ts\n---\n`
    );
    writeFileSync(
      resolve(stationDir, "ok.ts"),
      `console.log(JSON.stringify({ summary: "ok from ${name}" }));\n`
    );
  }
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
  // Redirect usage-snapshot writes away from the real ~/.assembly path.
  const snapDir = resolve("/tmp", `assembly-test-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(snapDir, { recursive: true });
  tempDirs.push(snapDir);
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = resolve(snapDir, "usage-status.json");

  // Seed a fake OAuth token so the usage gate's token read doesn't throw.
  try {
    const credsDir = join(homedir(), ".claude");
    const credsPath = join(credsDir, ".credentials.json");
    mkdirSync(credsDir, { recursive: true });
    const existing = Bun.file(credsPath);
    if (!(existing.size && existing.size > 0)) {
      writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
    }
  } catch {}

  // Stub the OAuth usage fetch so the orchestrator gate always reports healthy.
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
  // Small delay so child workers from spawnSync settle before we rm their cwd.
  await new Promise((r) => setTimeout(r, 200));
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  globalThis.fetch = originalFetch;
  if (originalSnapEnv === undefined) delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
  else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalSnapEnv;
  __resetUsageGateStateForTest();
});

describe("section inbox watcher", () => {
  test(
    "workpiece dropped into station inbox mid-run is claimed and completes",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-section-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      createScriptLine(linePath, ["station-a", "station-b"]);

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);

      // Give the orchestrator a moment to wire its watchers.
      await new Promise((r) => setTimeout(r, 200));

      // Drop a workpiece directly into station-b's inbox (skipping station-a
      // and the line inbox). Authorized via recordEmit — without that, the
      // 2026-05-04 producer-allowlist would quarantine it as `producer_unknown`.
      // This simulates an admin recovery script: the legitimate path for
      // dropping work into a mid-line section.
      const wp = createWorkpiece(LineName("inbox-watcher-test"), "drop test");
      const stationBInbox = resolve(linePath, "stations", "station-b", "queue", "inbox");
      const dropPath = resolve(stationBInbox, `${wp.id}.json`);
      const dropFileName = `${wp.id}.json`;
      recordEmit(stationBInbox, dropFileName, "recovery");
      writeFileSync(dropPath, JSON.stringify(wp, null, 2));

      // The watcher should wake station-b → claim file into processing →
      // script runs → moves to output → orchestrator routes to done (last
      // section). Whole cycle should take well under 5s.
      const doneDir = resolve(linePath, "queues", "done");
      const reached = await waitFor(
        () => readdirSync(doneDir).some((f) => f.endsWith(".json")),
        5_000
      );

      expect(reached).toBe(true);
      // Original drop should no longer be in the inbox.
      expect(existsSync(dropPath)).toBe(false);

      // station-a never saw this workpiece — only station-b ran.
      const doneFiles = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
      expect(doneFiles.length).toBe(1);
      const finalWp = JSON.parse(
        await Bun.file(resolve(doneDir, doneFiles[0])).text()
      );
      expect(finalWp.stations["station-b"]?.status).toBe("done");
      expect(finalWp.stations["station-a"]).toBeUndefined();
    },
    15_000
  );
});
