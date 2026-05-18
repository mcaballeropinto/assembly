import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { getFullState } from "../dashboard-data";
import { initSectionQueue, initLineQueue } from "../queue";

const TEMP_DIR = resolve("/tmp", `assembly-test-error-banner-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "test-line");

/** Create a workpiece with a failed station */
function makeErrorWorkpiece(id: string, task: string, failedStation: string, errorSummary: string) {
  return JSON.stringify({
    id,
    line: "test-line",
    task,
    input: {},
    stations: {
      [failedStation]: {
        summary: errorSummary,
        status: "failed",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        model: "test",
        tokens: { in: 100, out: 50 },
        cost_usd: 0.01,
      },
    },
  });
}

/** Create a workpiece where all stations are done (edge case — in error queue but no failed stations) */
function makeAllDoneWorkpiece(id: string, task: string) {
  return JSON.stringify({
    id,
    line: "test-line",
    task,
    input: {},
    stations: {
      "station-a": {
        summary: "done",
        status: "done",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        model: "test",
        tokens: { in: 100, out: 50 },
        cost_usd: 0.01,
      },
    },
  });
}

beforeAll(() => {
  mkdirSync(LINE_DIR, { recursive: true });

  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    `name: test-line\nsequence:\n  - station-a\n  - station-b\n`
  );

  const stationA = resolve(LINE_DIR, "stations", "station-a");
  const stationB = resolve(LINE_DIR, "stations", "station-b");
  mkdirSync(stationA, { recursive: true });
  mkdirSync(stationB, { recursive: true });
  writeFileSync(resolve(stationA, "AGENT.md"), "---\n---\nTest station A prompt");
  writeFileSync(resolve(stationB, "AGENT.md"), "---\n---\nTest station B prompt");
  initSectionQueue(stationA);
  initSectionQueue(stationB);

  initLineQueue(LINE_DIR);

  // Add error workpieces
  writeFileSync(
    resolve(LINE_DIR, "queues", "error", "wp-err-1.json"),
    makeErrorWorkpiece("wp-err-1", "discover task-123", "station-a", "timeout")
  );

  writeFileSync(
    resolve(LINE_DIR, "queues", "error", "wp-err-2.json"),
    makeErrorWorkpiece("wp-err-2", "process task-456", "station-b", "API rate limit")
  );

  // Add activity log
  writeFileSync(
    resolve(LINE_DIR, "queues", "activity.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), event: "routed", station: "station-a", workpiece: "wp-err-1" }) + "\n"
  );
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("error banner - dashboard-data", () => {
  test("error objects include fileName field matching actual filename", async () => {
    const state = await getFullState(LINE_DIR) as any;

    expect(state.errors).toBeDefined();
    expect(state.errors.length).toBe(2);

    // Each error should have a fileName field
    for (const err of state.errors) {
      expect(err).toHaveProperty("fileName");
      expect(err.fileName).toMatch(/^wp-err-\d\.json$/);
    }
  });

  test("error objects contain correct failed station data", async () => {
    const state = await getFullState(LINE_DIR) as any;

    // Find the error for wp-err-1 (station-a failed with "timeout")
    const err1 = state.errors.find((e: any) => e.id === "wp-err-1");
    expect(err1).toBeDefined();
    expect(err1.failed).toBeDefined();
    expect(err1.failed.length).toBe(1);
    expect(err1.failed[0]).toEqual({ station: "station-a", error: "timeout" });

    // Find the error for wp-err-2 (station-b failed with "API rate limit")
    const err2 = state.errors.find((e: any) => e.id === "wp-err-2");
    expect(err2).toBeDefined();
    expect(err2.failed.length).toBe(1);
    expect(err2.failed[0]).toEqual({ station: "station-b", error: "API rate limit" });
  });

  test("getFullState return shape is backward-compatible — all existing fields present", async () => {
    const state = await getFullState(LINE_DIR) as any;

    expect(state).toHaveProperty("line", "test-line");
    expect(state).toHaveProperty("sequence");
    expect(state).toHaveProperty("lineQueue");
    expect(state).toHaveProperty("sections");
    expect(state).toHaveProperty("activity");
    expect(state).toHaveProperty("completed");
    expect(state).toHaveProperty("errors");
    expect(state).toHaveProperty("reviews");
    expect(state).toHaveProperty("triggers");
    expect(state).toHaveProperty("timestamp");
  });

  test("errors array is empty when no error workpieces exist", async () => {
    // Create a separate clean line with no errors
    const cleanDir = resolve(TEMP_DIR, "clean-line");
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(
      resolve(cleanDir, "line.yaml"),
      `name: clean-line\nsequence:\n  - station-a\n`
    );
    const stationA = resolve(cleanDir, "stations", "station-a");
    mkdirSync(stationA, { recursive: true });
    writeFileSync(resolve(stationA, "AGENT.md"), "---\n---\nClean station");
    initSectionQueue(stationA);
    initLineQueue(cleanDir);

    const state = await getFullState(cleanDir) as any;
    expect(state.errors).toEqual([]);
    expect(state.lineQueue.error).toBe(0);
  });

  test("error workpiece with no failed stations produces failed: []", async () => {
    // Create a line with an error workpiece where all stations are "done"
    const edgeDir = resolve(TEMP_DIR, "edge-line");
    mkdirSync(edgeDir, { recursive: true });
    writeFileSync(
      resolve(edgeDir, "line.yaml"),
      `name: edge-line\nsequence:\n  - station-a\n`
    );
    const stationA = resolve(edgeDir, "stations", "station-a");
    mkdirSync(stationA, { recursive: true });
    writeFileSync(resolve(stationA, "AGENT.md"), "---\n---\nEdge station");
    initSectionQueue(stationA);
    initLineQueue(edgeDir);

    writeFileSync(
      resolve(edgeDir, "queues", "error", "wp-edge.json"),
      makeAllDoneWorkpiece("wp-edge", "edge case task")
    );

    const state = await getFullState(edgeDir) as any;
    expect(state.errors.length).toBe(1);
    expect(state.errors[0].id).toBe("wp-edge");
    expect(state.errors[0].failed).toEqual([]);
    expect(state.errors[0].fileName).toBe("wp-edge.json");
  });
});

describe("banner_errors stability", () => {
  test("banner_errors is stable across consecutive getFullState calls", async () => {
    const state1 = await getFullState(LINE_DIR) as any;
    const state2 = await getFullState(LINE_DIR) as any;

    expect(state1.banner_errors).toBeDefined();
    expect(state2.banner_errors).toBeDefined();

    // Same fileNames should appear in both calls (order may differ, so sort)
    const names1 = (state1.banner_errors as any[]).map((e: any) => e.fileName).sort();
    const names2 = (state2.banner_errors as any[]).map((e: any) => e.fileName).sort();
    expect(names1).toEqual(names2);
  });

  test("banner_errors field exists alongside errors field (backward compat)", async () => {
    const state = await getFullState(LINE_DIR) as any;

    // Both fields must be present
    expect(state).toHaveProperty("errors");
    expect(state).toHaveProperty("banner_errors");
    expect(state).toHaveProperty("errors_meta");

    // errors should NOT have severity (backward compat)
    for (const err of state.errors) {
      expect(err).not.toHaveProperty("severity");
    }

    // banner_errors SHOULD have severity
    for (const bErr of state.banner_errors) {
      expect(bErr).toHaveProperty("severity");
      expect(["critical", "warning"]).toContain(bErr.severity);
    }
  });

  test("errors_meta counts match banner_errors length", async () => {
    const state = await getFullState(LINE_DIR) as any;

    expect(state.errors_meta).toBeDefined();
    expect(state.errors_meta.in_banner).toBe(state.banner_errors.length);
    expect(state.errors_meta.total_active).toBe(state.errors.length);
    expect(state.errors_meta.max_banner_age_ms).toBe(48 * 60 * 60 * 1000);
  });
});
