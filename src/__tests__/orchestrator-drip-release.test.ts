import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { loadLine } from "../line";
import { startOrchestrator } from "../orchestrator";
import { __resetUsageGateStateForTest } from "../usage";
import { recordEmit } from "../emit-manifest";

function createScriptLine(
  linePath: string,
  opts: { drip?: string; concurrency?: number; scriptDelayMs?: number } = {}
): void {
  for (const queue of ["inbox", "held", "done", "error", "review"]) {
    mkdirSync(resolve(linePath, "queues", queue), { recursive: true });
  }

  const configLines = [
    "name: drip-test",
    ...(opts.concurrency !== undefined ? [`concurrency: ${opts.concurrency}`] : []),
    ...(opts.drip !== undefined ? [`drip: ${opts.drip}`] : []),
    "sequence:",
    "  - first",
    "",
  ];
  writeFileSync(resolve(linePath, "line.yaml"), configLines.join("\n"));

  const stationDir = resolve(linePath, "stations", "first");
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(
    resolve(stationDir, "AGENT.md"),
    "---\nprovider: script\nscript: ok.ts\n---\n"
  );
  writeFileSync(
    resolve(stationDir, "ok.ts"),
    `${opts.scriptDelayMs ? `await Bun.sleep(${opts.scriptDelayMs});\n` : ""}console.log(JSON.stringify({ summary: "ok" }));\n`
  );
}

function writeInboxPayload(dir: string, fileName: string, task: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fileName), JSON.stringify({ task, input: {} }, null, 2));
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

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

function releaseManifestFiles(linePath: string): string[] {
  const manifestPath = resolve(linePath, "queues", "inbox", ".emitted.jsonl");
  if (!existsSync(manifestPath)) return [];
  return readFileSync(manifestPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.source === "release")
    .map((entry) => entry.filename)
    .sort();
}

const orchestrators: Array<{ stop: () => void | Promise<void> }> = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;

beforeEach(() => {
  const snapDir = resolve("/tmp", `assembly-test-drip-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("line.yaml drip validation", () => {
  test("loadLine accepts positive integer drip", async () => {
    const linePath = resolve("/tmp", `assembly-test-drip-valid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(linePath);
    createScriptLine(linePath, { drip: "2" });

    const { config } = await loadLine(linePath);
    expect(config.drip).toBe(2);
  });

  test.each(["0", "-1", "1.5", "fast"])("loadLine rejects invalid drip %s", async (drip) => {
    const linePath = resolve("/tmp", `assembly-test-drip-invalid-${drip}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(linePath);
    createScriptLine(linePath, { drip });

    await expect(loadLine(linePath)).rejects.toThrow("line.yaml 'drip' must be a positive integer");
  });
});

describe("orchestrator drip release", () => {
  test(
    "releases only the oldest configured batch and records release emits",
    async () => {
      const linePath = resolve("/tmp", `assembly-test-drip-happy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirs.push(linePath);
      createScriptLine(linePath, { drip: "2" });

      const heldDir = resolve(linePath, "queues", "held");
      writeInboxPayload(heldDir, "task-oldest.json", "oldest");
      await Bun.sleep(25);
      writeInboxPayload(heldDir, "task-middle.json", "middle");
      await Bun.sleep(25);
      writeInboxPayload(heldDir, "task-newest.json", "newest");

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);

      const reached = await waitFor(() => {
        const held = jsonFiles(heldDir);
        return (
          held.includes("task-newest.json") &&
          !held.includes("task-oldest.json") &&
          !held.includes("task-middle.json") &&
          releaseManifestFiles(linePath).length === 2
        );
      }, 8_000);
      expect(reached).toBe(true);
      expect(jsonFiles(heldDir)).toEqual(["task-newest.json"]);
      expect(releaseManifestFiles(linePath)).toEqual(["task-middle.json", "task-oldest.json"]);
      const visibleOrDone = [
        ...jsonFiles(resolve(linePath, "queues", "inbox")),
        ...jsonFiles(resolve(linePath, "stations", "first", "queue", "inbox")),
        ...jsonFiles(resolve(linePath, "stations", "first", "queue", "processing")),
        ...jsonFiles(resolve(linePath, "queues", "done")),
      ];
      expect(visibleOrDone).toContain("task-oldest.json");
      expect(visibleOrDone).toContain("task-middle.json");
    },
    15_000
  );

  test(
    "leaves held tasks untouched when drip is omitted",
    async () => {
      const linePath = resolve("/tmp", `assembly-test-drip-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirs.push(linePath);
      createScriptLine(linePath);

      const heldDir = resolve(linePath, "queues", "held");
      writeInboxPayload(heldDir, "task-one.json", "one");
      writeInboxPayload(heldDir, "task-two.json", "two");

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);
      await Bun.sleep(400);

      expect(jsonFiles(heldDir)).toEqual(["task-one.json", "task-two.json"]);
      expect(jsonFiles(resolve(linePath, "queues", "done"))).toEqual([]);
    },
    10_000
  );

  test(
    "does not drip while a line-inbox file is still being claimed and processed",
    async () => {
      const linePath = resolve("/tmp", `assembly-test-drip-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirs.push(linePath);
      createScriptLine(linePath, { drip: "2", concurrency: 1, scriptDelayMs: 800 });

      const lineInbox = resolve(linePath, "queues", "inbox");
      const heldDir = resolve(linePath, "queues", "held");
      writeInboxPayload(lineInbox, "task-pending.json", "pending");
      recordEmit(lineInbox, "task-pending.json", "cli");
      writeInboxPayload(heldDir, "task-held-a.json", "held a");
      await Bun.sleep(25);
      writeInboxPayload(heldDir, "task-held-b.json", "held b");

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);

      await Bun.sleep(200);
      expect(jsonFiles(heldDir)).toEqual(["task-held-a.json", "task-held-b.json"]);

      const reached = await waitFor(() => releaseManifestFiles(linePath).length === 2, 8_000);
      expect(reached).toBe(true);
      expect(jsonFiles(heldDir)).toEqual([]);
      expect(releaseManifestFiles(linePath)).toEqual(["task-held-a.json", "task-held-b.json"]);
    },
    15_000
  );
});
