import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { startOrchestrator } from "../orchestrator";
import { createWorkpiece, failStation } from "../workpiece";
import type { FailureClass, Workpiece } from "../types";
import { __resetUsageGateStateForTest } from "../usage";

function createRetryTestLine(linePath: string, stationName: string): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });

  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: sweep-test\nsequence:\n  - ${stationName}\n`
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

function buildFailedWorkpiece(
  stationName: string,
  failureClass: FailureClass
): Workpiece {
  const wp = createWorkpiece("sweep-test", "sweep-task");
  return failStation(
    wp,
    stationName,
    `seeded ${failureClass} failure`,
    {
      model: "test:test",
      tokens: { in: 0, out: 0 },
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z",
    },
    failureClass
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

beforeEach(() => {
  const snapDir = resolve(
    "/tmp",
    `assembly-test-sweep-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(snapDir, { recursive: true });
  tempDirs.push(snapDir);
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = resolve(snapDir, "usage-status.json");

  try {
    const credsDir = join(homedir(), ".claude");
    const credsPath = join(credsDir, ".credentials.json");
    mkdirSync(credsDir, { recursive: true });
    const existing = Bun.file(credsPath);
    if (!(existing.size && existing.size > 0)) {
      writeFileSync(
        credsPath,
        JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } })
      );
    }
  } catch {}

  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : String(url);
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
});

describe("retry history sweep: stale error/ cleanup", () => {
  test("stale error/ file is swept when retry fires", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);
    const stationName = "s1";
    createRetryTestLine(linePath, stationName);

    const orch = await startOrchestrator({
      linePath,
      retryPolicy: { timeout: { maxRetries: 1, backoff: [0] } },
    });
    orchestrators.push(orch);
    await new Promise((r) => setTimeout(r, 150));

    const wp = buildFailedWorkpiece(stationName, "timeout");
    const fileName = `${wp.id}.json`;

    // Simulate a stale error/ copy (as if from a prior crash-recovery)
    const errorDir = resolve(linePath, "queues", "error");
    writeFileSync(resolve(errorDir, fileName), JSON.stringify(wp, null, 2));
    writeFileSync(resolve(errorDir, fileName + ".session.jsonl"), "stale session\n");

    // Now drop the workpiece into station output to trigger the retry path
    const outputPath = resolve(
      linePath,
      "stations",
      stationName,
      "queue",
      "output",
      fileName
    );
    writeFileSync(outputPath, JSON.stringify(wp, null, 2));

    // Wait for stale error file to be cleaned
    const errorCleaned = await waitFor(
      () => !existsSync(resolve(errorDir, fileName)),
      3_000
    );
    expect(errorCleaned).toBe(true);
    expect(existsSync(resolve(errorDir, fileName + ".session.jsonl"))).toBe(false);

    // Verify the activity log contains stale_error_file_cleaned event
    const activityPath = resolve(linePath, "queues", "activity.jsonl");
    const found = await waitFor(() => {
      if (!existsSync(activityPath)) return false;
      return readFileSync(activityPath, "utf-8")
        .trim()
        .split("\n")
        .some((l) => {
          try {
            const e = JSON.parse(l);
            return e.event === "stale_error_file_cleaned" && e.workpiece === wp.id;
          } catch { return false; }
        });
    }, 3_000);
    expect(found).toBe(true);
  });
});
