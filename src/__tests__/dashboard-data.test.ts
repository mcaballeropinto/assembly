import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync, renameSync } from "fs";
import { getFullState, findWorkpiece, getWorkpieceActivity, computeHealth, computeErrorSeverity, BANNER_ERROR_MAX_AGE_MS, computeThroughput, connectionHealth, CONNECTION_LIVE_THRESHOLD_MS, CONNECTION_STALE_THRESHOLD_MS, getHistory, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, getKanbanState, type KanbanState } from "../dashboard-data";
import { initSectionQueue, initLineQueue } from "../queue";
import { dismissFilenames, undismissFilenames } from "../error-dismiss";
import {
  takeSnapshot,
  appendSnapshot,
  readFlowHistory,
  startFlowSnapshotWriter,
  flowFilePath,
  type FlowSnapshot,
} from "../flow-snapshot";

const TEMP_DIR = resolve("/tmp", `assembly-test-dashboard-data-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "test-line");

/** Minimal workpiece JSON for testing */
function makeWorkpiece(id: string, task: string = "test task") {
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
  // Create a full line directory structure
  mkdirSync(LINE_DIR, { recursive: true });

  // Write line.yaml
  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    `name: test-line\nsequence:\n  - station-a\n  - station-b\n`
  );

  // Create station directories with queues and AGENT.md
  const stationA = resolve(LINE_DIR, "stations", "station-a");
  const stationB = resolve(LINE_DIR, "stations", "station-b");
  mkdirSync(stationA, { recursive: true });
  mkdirSync(stationB, { recursive: true });
  writeFileSync(resolve(stationA, "AGENT.md"), "---\n---\nTest station A prompt");
  writeFileSync(resolve(stationB, "AGENT.md"), "---\n---\nTest station B prompt");
  initSectionQueue(stationA);
  initSectionQueue(stationB);

  // Create line-level queues
  initLineQueue(LINE_DIR);

  // Add sample workpieces
  writeFileSync(
    resolve(LINE_DIR, "queues", "done", "wp-done-1.json"),
    makeWorkpiece("wp-done-1")
  );
  writeFileSync(
    resolve(LINE_DIR, "queues", "done", "wp-done-2.json"),
    makeWorkpiece("wp-done-2")
  );
  writeFileSync(
    resolve(LINE_DIR, "queues", "error", "wp-error-1.json"),
    JSON.stringify({
      id: "wp-error-1",
      line: "test-line",
      task: "failed task",
      input: {},
      stations: {
        "station-a": {
          summary: "something went wrong",
          status: "failed",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          model: "test",
          tokens: { in: 100, out: 50 },
          cost_usd: 0.01,
        },
      },
    })
  );

  // Add sample activity log
  const activity = [
    JSON.stringify({ ts: new Date().toISOString(), event: "routed", station: "station-a", workpiece: "wp-done-1" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "station_done", station: "station-a", summary: "completed" }),
  ];
  writeFileSync(
    resolve(LINE_DIR, "queues", "activity.jsonl"),
    activity.join("\n") + "\n"
  );

  // Add a workpiece in station-a processing queue
  writeFileSync(
    resolve(stationA, "queue", "processing", "wp-in-flight.json"),
    makeWorkpiece("wp-in-flight", "in-flight task")
  );
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("getFullState", () => {
  test("returns correct structure for valid line", async () => {
    const state = await getFullState(LINE_DIR);

    // Should not have an error
    expect(state).not.toHaveProperty("error");

    // Check top-level fields
    expect(state).toHaveProperty("line", "test-line");
    expect(state).toHaveProperty("sequence");
    expect(state).toHaveProperty("lineQueue");
    expect(state).toHaveProperty("sections");
    expect(state).toHaveProperty("activity");
    expect(state).toHaveProperty("completed");
    expect(state).toHaveProperty("errors");
    expect(state).toHaveProperty("reviews");
    expect(state).toHaveProperty("timestamp");

    // Sequence should match line.yaml
    const s = state as any;
    expect(s.sequence).toEqual(["station-a", "station-b"]);

    // Line queues should have counts
    expect(s.lineQueue).toHaveProperty("inbox");
    expect(s.lineQueue).toHaveProperty("done");
    expect(s.lineQueue).toHaveProperty("error");
    expect(s.lineQueue).toHaveProperty("review");
    expect(s.lineQueue.done).toBe(2);
    expect(s.lineQueue.error).toBe(1);

    // Sections should include both stations
    expect(s.sections).toHaveProperty("station-a");
    expect(s.sections).toHaveProperty("station-b");
    expect(s.sections["station-a"]).toHaveProperty("inbox");
    expect(s.sections["station-a"]).toHaveProperty("processing");
    expect(s.sections["station-a"]).toHaveProperty("output");

    // Activity should be parsed
    expect(s.activity.length).toBeGreaterThan(0);

    // Completed should have our done workpieces
    expect(s.completed.length).toBe(2);

    // Errors should have our error workpiece
    expect(s.errors.length).toBe(1);

    // Timestamp should be ISO string
    expect(new Date(s.timestamp).toISOString()).toBe(s.timestamp);

    // Throughput should be present with numeric fields (backward compat)
    expect(state).toHaveProperty("throughput");
    expect((state as any).throughput).toHaveProperty("last_1h");
    expect((state as any).throughput).toHaveProperty("last_24h");
    expect(typeof (state as any).throughput.last_1h).toBe("number");
    expect(typeof (state as any).throughput.last_24h).toBe("number");
  });

  test("returns error for invalid line path", async () => {
    const state = await getFullState("/nonexistent/path/to/line");

    expect(state).toHaveProperty("error", "Failed to load line");
  });

  test("includes stationTimings with duration data from done workpieces", async () => {
    // Write a workpiece with known distinct timestamps to done/
    // Note: station-a has a processing workpiece (from beforeAll) so it will
    // show as "running" — we test station-b's timing from the done workpiece
    const wpWithTiming = {
      id: "wp-timing-test",
      line: "test-line",
      task: "timing test",
      input: {},
      stations: {
        "station-a": {
          summary: "done",
          status: "done",
          started_at: "2026-04-01T10:00:00Z",
          finished_at: "2026-04-01T10:02:30Z",
          model: "test",
          tokens: { in: 100, out: 50 },
          cost_usd: 0.01,
        },
        "station-b": {
          summary: "done",
          status: "done",
          started_at: "2026-04-01T10:02:30Z",
          finished_at: "2026-04-01T10:03:00Z",
          model: "test",
          tokens: { in: 200, out: 100 },
          cost_usd: 0.02,
        },
      },
    };
    writeFileSync(
      resolve(LINE_DIR, "queues", "done", "wp-timing-test.json"),
      JSON.stringify(wpWithTiming)
    );

    const state = (await getFullState(LINE_DIR)) as any;

    // stationTimings should be present
    expect(state.stationTimings).toBeDefined();

    // station-a has a processing workpiece, so it should be "running" (tested separately)
    // station-b: 10:02:30 → 10:03:00 = 30000ms (from done workpiece)
    expect(state.stationTimings["station-b"]).toBeDefined();
    expect(state.stationTimings["station-b"].duration_ms).toBe(30000);
    expect(state.stationTimings["station-b"].started_at).toBe("2026-04-01T10:02:30Z");
    expect(state.stationTimings["station-b"].finished_at).toBe("2026-04-01T10:03:00Z");

    // Clean up
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(resolve(LINE_DIR, "queues", "done", "wp-timing-test.json"));
    } catch {}
  });

  test("stationTimings prefers active processing workpiece over done", async () => {
    // station-a already has a workpiece in processing (from beforeAll setup)
    const state = (await getFullState(LINE_DIR)) as any;

    expect(state.stationTimings).toBeDefined();
    // station-a should show as "running" because there's a workpiece in processing
    expect(state.stationTimings["station-a"]).toBeDefined();
    expect(state.stationTimings["station-a"].running).toBe(true);
    expect(state.stationTimings["station-a"].started_at).toBeDefined();
    // No duration_ms for running stations
    expect(state.stationTimings["station-a"].duration_ms).toBeUndefined();
  });

  test("timing is empty when no workpieces exist in done or processing", async () => {
    // Create a fresh line with no done workpieces
    const emptyLine = resolve(TEMP_DIR, "empty-timing-line");
    mkdirSync(emptyLine, { recursive: true });
    writeFileSync(
      resolve(emptyLine, "line.yaml"),
      "name: empty-timing-line\nsequence:\n  - s1\n"
    );
    const s1Dir = resolve(emptyLine, "stations", "s1");
    mkdirSync(s1Dir, { recursive: true });
    writeFileSync(resolve(s1Dir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(s1Dir);
    initLineQueue(emptyLine);

    const state = (await getFullState(emptyLine)) as any;

    expect(state.stationTimings).toBeDefined();
    expect(Object.keys(state.stationTimings)).toHaveLength(0);
    expect(state.pipelineTotalMs).toBeNull();
  });

  test("pipelineTotalMs is calculated when all stations are completed", async () => {
    // Create a fresh line with only done workpieces (no processing)
    const timingLine = resolve(TEMP_DIR, "timing-total-line");
    mkdirSync(timingLine, { recursive: true });
    writeFileSync(
      resolve(timingLine, "line.yaml"),
      "name: timing-total-line\nsequence:\n  - sa\n  - sb\n"
    );
    const saDir = resolve(timingLine, "stations", "sa");
    const sbDir = resolve(timingLine, "stations", "sb");
    mkdirSync(saDir, { recursive: true });
    mkdirSync(sbDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest SA");
    writeFileSync(resolve(sbDir, "AGENT.md"), "---\n---\nTest SB");
    initSectionQueue(saDir);
    initSectionQueue(sbDir);
    initLineQueue(timingLine);

    // Write a fully completed workpiece to done/
    const completedWp = {
      id: "wp-total-test",
      line: "timing-total-line",
      task: "total test",
      input: {},
      stations: {
        sa: {
          summary: "done",
          status: "done",
          started_at: "2026-04-01T10:00:00Z",
          finished_at: "2026-04-01T10:02:30Z",
          model: "test",
          tokens: { in: 100, out: 50 },
          cost_usd: 0.01,
        },
        sb: {
          summary: "done",
          status: "done",
          started_at: "2026-04-01T10:02:30Z",
          finished_at: "2026-04-01T10:03:00Z",
          model: "test",
          tokens: { in: 200, out: 100 },
          cost_usd: 0.02,
        },
      },
    };
    writeFileSync(
      resolve(timingLine, "queues", "done", "wp-total-test.json"),
      JSON.stringify(completedWp)
    );

    const state = (await getFullState(timingLine)) as any;

    expect(state.stationTimings).toBeDefined();
    expect(state.stationTimings["sa"].duration_ms).toBe(150000);
    expect(state.stationTimings["sb"].duration_ms).toBe(30000);
    // No stations running, so pipelineTotalMs should be calculated
    expect(state.pipelineTotalMs).toBe(180000); // 3 minutes
  });
});

describe("findWorkpiece", () => {
  test("finds workpiece in done queue", async () => {
    const wp = await findWorkpiece(LINE_DIR, "wp-done-1.json");

    expect(wp).not.toBeNull();
    expect(wp!.id).toBe("wp-done-1");
    expect(wp!.line).toBe("test-line");
  });

  test("finds workpiece in error queue", async () => {
    const wp = await findWorkpiece(LINE_DIR, "wp-error-1.json");

    expect(wp).not.toBeNull();
    expect(wp!.id).toBe("wp-error-1");
  });

  test("returns null for nonexistent workpiece", async () => {
    const wp = await findWorkpiece(LINE_DIR, "ghost.json");

    expect(wp).toBeNull();
  });

  test("searches station queue folders", async () => {
    const wp = await findWorkpiece(LINE_DIR, "wp-in-flight.json");

    expect(wp).not.toBeNull();
    expect(wp!.id).toBe("wp-in-flight");
    expect(wp!.task).toBe("in-flight task");
  });
});

describe("getFullState - fileName field", () => {
  test("completed items include fileName", async () => {
    const state = (await getFullState(LINE_DIR)) as any;

    expect(state.completed.length).toBeGreaterThan(0);
    for (const item of state.completed) {
      expect(item.fileName).toBeDefined();
      expect(item.fileName).toMatch(/\.json$/);
    }
    // Verify specific filenames are present (reversed order since listQueue returns sorted)
    const fileNames = state.completed.map((c: any) => c.fileName);
    expect(fileNames).toContain("wp-done-1.json");
    expect(fileNames).toContain("wp-done-2.json");
  });

  test("error items include fileName", async () => {
    const state = (await getFullState(LINE_DIR)) as any;

    expect(state.errors.length).toBeGreaterThan(0);
    for (const item of state.errors) {
      expect(item.fileName).toBeDefined();
      expect(item.fileName).toMatch(/\.json$/);
    }
    const fileNames = state.errors.map((e: any) => e.fileName);
    expect(fileNames).toContain("wp-error-1.json");
  });
});

describe("getWorkpieceActivity", () => {
  test("returns filtered entries matching workpiece ID", () => {
    const entries = getWorkpieceActivity(LINE_DIR, "wp-done-1");

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect((entry as any).workpiece).toBe("wp-done-1");
    }
  });

  test("returns empty array for no matches", () => {
    const entries = getWorkpieceActivity(LINE_DIR, "nonexistent-wp-id");

    expect(entries).toEqual([]);
  });

  test("returns empty array for missing log file", () => {
    const entries = getWorkpieceActivity("/nonexistent/path", "some-id");

    expect(entries).toEqual([]);
  });

  test("returns entries in reverse chronological order", () => {
    // Write a multi-entry activity log
    const multiLogLine = resolve(TEMP_DIR, "multi-log-line");
    mkdirSync(resolve(multiLogLine, "queues"), { recursive: true });
    const logEntries = [
      JSON.stringify({ ts: "2026-04-01T10:00:00Z", event: "routed", workpiece: "wp-A" }),
      JSON.stringify({ ts: "2026-04-01T10:01:00Z", event: "station_done", workpiece: "wp-A" }),
      JSON.stringify({ ts: "2026-04-01T10:02:00Z", event: "task_done", workpiece: "wp-A" }),
      JSON.stringify({ ts: "2026-04-01T10:00:30Z", event: "routed", workpiece: "wp-B" }),
    ];
    writeFileSync(resolve(multiLogLine, "queues", "activity.jsonl"), logEntries.join("\n") + "\n");

    const entries = getWorkpieceActivity(multiLogLine, "wp-A");
    expect(entries.length).toBe(3);
    // Should be reversed: task_done first, routed last
    expect((entries[0] as any).event).toBe("task_done");
    expect((entries[2] as any).event).toBe("routed");
  });
});

describe("getFullState - error dismissal", () => {
  test("with no .dismissed file, all errors are active, errorsDismissed is empty", async () => {
    // Ensure no .dismissed sidecar
    const dismissedPath = resolve(LINE_DIR, "queues", "error", ".dismissed");
    try { rmSync(dismissedPath); } catch {}

    const state = (await getFullState(LINE_DIR)) as any;

    expect(state.errors.length).toBe(1); // wp-error-1.json
    expect(state.errorsDismissed).toBeDefined();
    expect(state.errorsDismissed.length).toBe(0);
  });

  test("with .dismissed containing matching filename, error moves to errorsDismissed", async () => {
    // Dismiss wp-error-1.json
    dismissFilenames(LINE_DIR, ["wp-error-1.json"]);

    const state = (await getFullState(LINE_DIR)) as any;

    // Active errors should be empty now
    expect(state.errors.length).toBe(0);
    // Dismissed should contain the error
    expect(state.errorsDismissed.length).toBe(1);
    expect(state.errorsDismissed[0].id).toBe("wp-error-1");
    expect(state.errorsDismissed[0]).toHaveProperty("dismissed_at");
    expect(state.errorsDismissed[0].fileName).toBe("wp-error-1.json");

    // Clean up
    undismissFilenames(LINE_DIR, ["wp-error-1.json"]);
  });

  test("preserves all existing return fields (backward compat)", async () => {
    const state = (await getFullState(LINE_DIR)) as any;

    expect(state).toHaveProperty("line");
    expect(state).toHaveProperty("sequence");
    expect(state).toHaveProperty("lineQueue");
    expect(state).toHaveProperty("sections");
    expect(state).toHaveProperty("activity");
    expect(state).toHaveProperty("completed");
    expect(state).toHaveProperty("errors");
    expect(state).toHaveProperty("errorsDismissed");
    expect(state).toHaveProperty("reviews");
    expect(state).toHaveProperty("triggers");
    expect(state).toHaveProperty("timestamp");
  });

  test("lineQueue.errorActive equals error minus dismissed count", async () => {
    // Dismiss wp-error-1.json
    dismissFilenames(LINE_DIR, ["wp-error-1.json"]);

    const state = (await getFullState(LINE_DIR)) as any;

    expect(state.lineQueue.error).toBe(1); // total on disk
    expect(state.lineQueue.errorActive).toBe(0); // 1 - 1 dismissed

    // Clean up
    undismissFilenames(LINE_DIR, ["wp-error-1.json"]);

    const stateAfter = (await getFullState(LINE_DIR)) as any;
    expect(stateAfter.lineQueue.error).toBe(1);
    expect(stateAfter.lineQueue.errorActive).toBe(1);
  });
});

describe("computeHealth", () => {
  test("returns idle when no processing, no errors, no inbox", () => {
    const sections = {
      "station-a": { inbox: 0, processing: 0, output: 0 },
      "station-b": { inbox: 0, processing: 0, output: 0 },
    };
    const result = computeHealth(sections, [], 0);
    expect(result.state).toBe("idle");
    expect(result.count).toBe(0);
    expect(result.detail).toBe("Idle");
  });

  test("returns processing with station names when ≤2 stations active", () => {
    const sections = {
      discover: { inbox: 0, processing: 1, output: 0 },
      evaluate: { inbox: 0, processing: 1, output: 0 },
      report: { inbox: 0, processing: 0, output: 0 },
    };
    const result = computeHealth(sections, [], 0);
    expect(result.state).toBe("processing");
    expect(result.count).toBe(2);
    expect(result.detail).toBe("Processing 2 — discover, evaluate");
  });

  test("returns processing without station names when >2 stations active", () => {
    const sections = {
      a: { inbox: 0, processing: 1, output: 0 },
      b: { inbox: 0, processing: 2, output: 0 },
      c: { inbox: 0, processing: 1, output: 0 },
    };
    const result = computeHealth(sections, [], 0);
    expect(result.state).toBe("processing");
    expect(result.count).toBe(4);
    expect(result.detail).toBe("Processing 4");
  });

  test("errors take precedence over processing", () => {
    const sections = {
      discover: { inbox: 0, processing: 1, output: 0 },
    };
    const errors = [
      { task: "find leads for acme corp", failed: [{ station: "discover", error: "API timeout" }] },
    ];
    const result = computeHealth(sections, errors, 0);
    expect(result.state).toBe("errors");
    expect(result.count).toBe(1);
    expect(result.detail).toContain("1 error");
    expect(result.detail).toContain("discover");
    expect(result.detail).toContain("find leads for acme corp");
  });

  test("multiple errors shows count and last failed station", () => {
    const errors = [
      { task: "task-one", failed: [{ station: "evaluate", error: "bad" }] },
      { task: "task-two", failed: [{ station: "discover", error: "timeout" }] },
    ];
    const result = computeHealth({}, errors, 0);
    expect(result.state).toBe("errors");
    expect(result.count).toBe(2);
    expect(result.detail).toContain("2 errors");
    expect(result.detail).toContain("evaluate");
  });

  test("returns queued when inbox has items but nothing processing", () => {
    const sections = {
      "station-a": { inbox: 3, processing: 0, output: 0 },
      "station-b": { inbox: 0, processing: 0, output: 0 },
    };
    const result = computeHealth(sections, [], 2);
    expect(result.state).toBe("queued");
    expect(result.count).toBe(5);
    expect(result.detail).toBe("Queued 5");
  });

  test("returns queued for line inbox only (no station inbox)", () => {
    const sections = {
      "station-a": { inbox: 0, processing: 0, output: 0 },
    };
    const result = computeHealth(sections, [], 4);
    expect(result.state).toBe("queued");
    expect(result.count).toBe(4);
  });

  test("getFullState includes health field", async () => {
    const state = (await getFullState(LINE_DIR)) as any;
    expect(state.health).toBeDefined();
    expect(state.health.state).toBeDefined();
    expect(state.health.count).toBeDefined();
    expect(state.health.detail).toBeDefined();
    expect(["idle", "processing", "queued", "errors"]).toContain(state.health.state);
  });
});

describe("sessionTotals", () => {
  test("empty line → all zeros", async () => {
    const emptyLine = resolve(TEMP_DIR, "empty-session-line");
    mkdirSync(emptyLine, { recursive: true });
    writeFileSync(
      resolve(emptyLine, "line.yaml"),
      "name: empty-session-line\nsequence:\n  - s1\n"
    );
    const s1Dir = resolve(emptyLine, "stations", "s1");
    mkdirSync(s1Dir, { recursive: true });
    writeFileSync(resolve(s1Dir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(s1Dir);
    initLineQueue(emptyLine);

    const state = (await getFullState(emptyLine)) as any;

    expect(state.sessionTotals).toBeDefined();
    expect(state.sessionTotals.tokens_in).toBe(0);
    expect(state.sessionTotals.tokens_out).toBe(0);
    expect(state.sessionTotals.cost_usd).toBe(0);
    expect(state.sessionTotals.workpieces).toBe(0);
    expect(Object.keys(state.sessionTotals.byStation)).toHaveLength(0);
  });

  test("known per-station tokens/costs → sum matches expected", async () => {
    const costLine = resolve(TEMP_DIR, "cost-sum-line");
    mkdirSync(costLine, { recursive: true });
    writeFileSync(
      resolve(costLine, "line.yaml"),
      "name: cost-sum-line\nsequence:\n  - station-a\n"
    );
    const saDir = resolve(costLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(costLine);

    // Write 2 done workpieces with known costs
    writeFileSync(
      resolve(costLine, "queues", "done", "wp-cost-1.json"),
      JSON.stringify({
        id: "wp-cost-1",
        line: "cost-sum-line",
        task: "task 1",
        input: {},
        stations: {
          "station-a": {
            summary: "done", status: "done",
            started_at: "2026-04-01T10:00:00Z", finished_at: "2026-04-01T10:01:00Z",
            model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01,
          },
        },
        totals: { tokens: { in: 100, out: 50 }, cost_usd: 0.01 },
      })
    );
    writeFileSync(
      resolve(costLine, "queues", "done", "wp-cost-2.json"),
      JSON.stringify({
        id: "wp-cost-2",
        line: "cost-sum-line",
        task: "task 2",
        input: {},
        stations: {
          "station-a": {
            summary: "done", status: "done",
            started_at: "2026-04-01T10:01:00Z", finished_at: "2026-04-01T10:02:00Z",
            model: "test", tokens: { in: 200, out: 100 }, cost_usd: 0.02,
          },
        },
        totals: { tokens: { in: 200, out: 100 }, cost_usd: 0.02 },
      })
    );

    const state = (await getFullState(costLine)) as any;

    expect(state.sessionTotals.cost_usd).toBe(0.03);
    expect(state.sessionTotals.tokens_in).toBe(300);
    expect(state.sessionTotals.tokens_out).toBe(150);
    expect(state.sessionTotals.workpieces).toBe(2);
  });

  test("per-station rollup counts and sums correctly", async () => {
    const rollupLine = resolve(TEMP_DIR, "rollup-line");
    mkdirSync(rollupLine, { recursive: true });
    writeFileSync(
      resolve(rollupLine, "line.yaml"),
      "name: rollup-line\nsequence:\n  - station-a\n  - station-b\n"
    );
    const saDir = resolve(rollupLine, "stations", "station-a");
    const sbDir = resolve(rollupLine, "stations", "station-b");
    mkdirSync(saDir, { recursive: true });
    mkdirSync(sbDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    writeFileSync(resolve(sbDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initSectionQueue(sbDir);
    initLineQueue(rollupLine);

    // 3 workpieces: all have station-a, only 2 have station-b
    for (let i = 1; i <= 3; i++) {
      const stations: any = {
        "station-a": {
          summary: "done", status: "done",
          started_at: "2026-04-01T10:00:00Z", finished_at: "2026-04-01T10:01:00Z",
          model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01,
        },
      };
      if (i <= 2) {
        stations["station-b"] = {
          summary: "done", status: "done",
          started_at: "2026-04-01T10:01:00Z", finished_at: "2026-04-01T10:02:00Z",
          model: "test", tokens: { in: 200, out: 100 }, cost_usd: 0.02,
        };
      }
      writeFileSync(
        resolve(rollupLine, "queues", "done", `wp-rollup-${i}.json`),
        JSON.stringify({
          id: `wp-rollup-${i}`,
          line: "rollup-line",
          task: `task ${i}`,
          input: {},
          stations,
          totals: { tokens: { in: 100 * i, out: 50 * i }, cost_usd: 0.01 * i },
        })
      );
    }

    const state = (await getFullState(rollupLine)) as any;

    expect(state.sessionTotals.byStation["station-a"]).toBeDefined();
    expect(state.sessionTotals.byStation["station-a"].count).toBe(3);
    expect(state.sessionTotals.byStation["station-a"].tokens_in).toBe(300); // 100 * 3
    expect(state.sessionTotals.byStation["station-a"].cost_usd).toBe(0.03); // 0.01 * 3
    expect(state.sessionTotals.byStation["station-b"]).toBeDefined();
    expect(state.sessionTotals.byStation["station-b"].count).toBe(2);
    expect(state.sessionTotals.byStation["station-b"].tokens_in).toBe(400); // 200 * 2
    expect(state.sessionTotals.byStation["station-b"].cost_usd).toBe(0.04); // 0.02 * 2
  });

  test("missing tokens/cost_usd on a station → treated as zero, no throw", async () => {
    const missingLine = resolve(TEMP_DIR, "missing-cost-line");
    mkdirSync(missingLine, { recursive: true });
    writeFileSync(
      resolve(missingLine, "line.yaml"),
      "name: missing-cost-line\nsequence:\n  - station-a\n"
    );
    const saDir = resolve(missingLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(missingLine);

    // Workpiece with missing tokens and cost_usd on station, and no totals
    writeFileSync(
      resolve(missingLine, "queues", "done", "wp-missing.json"),
      JSON.stringify({
        id: "wp-missing",
        line: "missing-cost-line",
        task: "legacy task",
        input: {},
        stations: {
          "station-a": {
            summary: "done", status: "done",
            started_at: "2026-04-01T10:00:00Z", finished_at: "2026-04-01T10:01:00Z",
            model: "test",
            // No tokens, no cost_usd
          },
        },
        // No totals field
      })
    );

    // Should not throw
    const state = (await getFullState(missingLine)) as any;

    expect(state.sessionTotals).toBeDefined();
    expect(state.sessionTotals.cost_usd).toBeGreaterThanOrEqual(0);
    expect(state.sessionTotals.tokens_in).toBeGreaterThanOrEqual(0);
    expect(state.sessionTotals.tokens_out).toBeGreaterThanOrEqual(0);
    expect(state.sessionTotals.workpieces).toBe(1);
    expect(state.sessionTotals.byStation["station-a"].tokens_in).toBe(0);
    expect(state.sessionTotals.byStation["station-a"].cost_usd).toBe(0);
  });

  test("error and review workpieces included in totals", async () => {
    const mixedLine = resolve(TEMP_DIR, "mixed-queue-line");
    mkdirSync(mixedLine, { recursive: true });
    writeFileSync(
      resolve(mixedLine, "line.yaml"),
      "name: mixed-queue-line\nsequence:\n  - station-a\n"
    );
    const saDir = resolve(mixedLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(mixedLine);

    // 1 done workpiece (cost 0.01)
    writeFileSync(
      resolve(mixedLine, "queues", "done", "wp-mixed-done.json"),
      JSON.stringify({
        id: "wp-mixed-done",
        line: "mixed-queue-line",
        task: "done task",
        input: {},
        stations: {
          "station-a": { summary: "done", status: "done", started_at: "2026-04-01T10:00:00Z", finished_at: "2026-04-01T10:01:00Z", model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 },
        },
        totals: { tokens: { in: 100, out: 50 }, cost_usd: 0.01 },
      })
    );

    // 1 error workpiece (cost 0.02)
    writeFileSync(
      resolve(mixedLine, "queues", "error", "wp-mixed-error.json"),
      JSON.stringify({
        id: "wp-mixed-error",
        line: "mixed-queue-line",
        task: "error task",
        input: {},
        stations: {
          "station-a": { summary: "failed", status: "failed", started_at: "2026-04-01T10:00:00Z", finished_at: "2026-04-01T10:01:00Z", model: "test", tokens: { in: 200, out: 100 }, cost_usd: 0.02 },
        },
        totals: { tokens: { in: 200, out: 100 }, cost_usd: 0.02 },
      })
    );

    // 1 review workpiece (cost 0.03)
    writeFileSync(
      resolve(mixedLine, "queues", "review", "wp-mixed-review.json"),
      JSON.stringify({
        id: "wp-mixed-review",
        line: "mixed-queue-line",
        task: "review task",
        input: {},
        stations: {
          "station-a": { summary: "escalated", status: "escalated", started_at: "2026-04-01T10:00:00Z", finished_at: "2026-04-01T10:01:00Z", model: "test", tokens: { in: 300, out: 150 }, cost_usd: 0.03 },
        },
        totals: { tokens: { in: 300, out: 150 }, cost_usd: 0.03 },
      })
    );

    const state = (await getFullState(mixedLine)) as any;

    expect(state.sessionTotals.workpieces).toBe(3);
    expect(state.sessionTotals.cost_usd).toBe(0.06);
    expect(state.sessionTotals.tokens_in).toBe(600);
    expect(state.sessionTotals.tokens_out).toBe(300);
  });
});

describe("banner_errors and severity", () => {
  test("computeErrorSeverity unit tests", () => {
    // ≤30 min → critical
    expect(computeErrorSeverity(new Date(Date.now() - 60_000).toISOString())).toBe("critical");
    expect(computeErrorSeverity(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("critical");

    // 30 min – 48h → warning
    expect(computeErrorSeverity(new Date(Date.now() - 3_600_000).toISOString())).toBe("warning");
    expect(computeErrorSeverity(new Date(Date.now() - 24 * 3_600_000).toISOString())).toBe("warning");

    // >48h → suppressed
    expect(computeErrorSeverity(new Date(Date.now() - 72 * 3_600_000).toISOString())).toBe("suppressed");

    // null → warning (cautious default)
    expect(computeErrorSeverity(null)).toBe("warning");
  });

  test("banner_errors excludes errors older than 48h", async () => {
    const bannerLine = resolve(TEMP_DIR, "banner-age-line");
    mkdirSync(bannerLine, { recursive: true });
    writeFileSync(resolve(bannerLine, "line.yaml"), "name: banner-age-line\nsequence:\n  - station-a\n");
    const saDir = resolve(bannerLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(bannerLine);

    // Fresh error (5 min ago)
    const freshTime = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(resolve(bannerLine, "queues", "error", "wp-fresh.json"), JSON.stringify({
      id: "wp-fresh", line: "banner-age-line", task: "fresh task", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: freshTime, finished_at: freshTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));

    // Old error (3 days ago)
    const oldTime = new Date(Date.now() - 72 * 3_600_000).toISOString();
    writeFileSync(resolve(bannerLine, "queues", "error", "wp-old.json"), JSON.stringify({
      id: "wp-old", line: "banner-age-line", task: "old task", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: oldTime, finished_at: oldTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));

    const state = (await getFullState(bannerLine)) as any;

    // errors should have both
    expect(state.errors.length).toBe(2);
    // banner_errors should only have the fresh one
    expect(state.banner_errors.length).toBe(1);
    expect(state.banner_errors[0].id).toBe("wp-fresh");
    expect(state.banner_errors[0].severity).toBe("critical");
  });

  test("banner_errors severity is critical for ≤30min errors", async () => {
    const critLine = resolve(TEMP_DIR, "banner-crit-line");
    mkdirSync(critLine, { recursive: true });
    writeFileSync(resolve(critLine, "line.yaml"), "name: banner-crit-line\nsequence:\n  - station-a\n");
    const saDir = resolve(critLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(critLine);

    const recentTime = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(resolve(critLine, "queues", "error", "wp-crit.json"), JSON.stringify({
      id: "wp-crit", line: "banner-crit-line", task: "crit task", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: recentTime, finished_at: recentTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));

    const state = (await getFullState(critLine)) as any;
    expect(state.banner_errors.length).toBe(1);
    expect(state.banner_errors[0].severity).toBe("critical");
  });

  test("banner_errors severity is warning for 30min-48h errors", async () => {
    const warnLine = resolve(TEMP_DIR, "banner-warn-line");
    mkdirSync(warnLine, { recursive: true });
    writeFileSync(resolve(warnLine, "line.yaml"), "name: banner-warn-line\nsequence:\n  - station-a\n");
    const saDir = resolve(warnLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(warnLine);

    const warnTime = new Date(Date.now() - 2 * 3_600_000).toISOString();
    writeFileSync(resolve(warnLine, "queues", "error", "wp-warn.json"), JSON.stringify({
      id: "wp-warn", line: "banner-warn-line", task: "warn task", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: warnTime, finished_at: warnTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));

    const state = (await getFullState(warnLine)) as any;
    expect(state.banner_errors.length).toBe(1);
    expect(state.banner_errors[0].severity).toBe("warning");
  });

  test("errors_meta contains correct counts", async () => {
    const metaLine = resolve(TEMP_DIR, "banner-meta-line");
    mkdirSync(metaLine, { recursive: true });
    writeFileSync(resolve(metaLine, "line.yaml"), "name: banner-meta-line\nsequence:\n  - station-a\n");
    const saDir = resolve(metaLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(metaLine);

    // 1 fresh + 1 old error
    const freshTime = new Date(Date.now() - 60_000).toISOString();
    const oldTime = new Date(Date.now() - 72 * 3_600_000).toISOString();
    writeFileSync(resolve(metaLine, "queues", "error", "wp-meta-fresh.json"), JSON.stringify({
      id: "wp-meta-fresh", line: "banner-meta-line", task: "fresh", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: freshTime, finished_at: freshTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));
    writeFileSync(resolve(metaLine, "queues", "error", "wp-meta-old.json"), JSON.stringify({
      id: "wp-meta-old", line: "banner-meta-line", task: "old", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: oldTime, finished_at: oldTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));

    const state = (await getFullState(metaLine)) as any;
    expect(state.errors_meta.total_active).toBe(2);
    expect(state.errors_meta.in_banner).toBe(1);
    expect(state.errors_meta.max_banner_age_ms).toBe(BANNER_ERROR_MAX_AGE_MS);
  });

  test("errors field unchanged — backward compat (no severity field)", async () => {
    const compatLine = resolve(TEMP_DIR, "banner-compat-line");
    mkdirSync(compatLine, { recursive: true });
    writeFileSync(resolve(compatLine, "line.yaml"), "name: banner-compat-line\nsequence:\n  - station-a\n");
    const saDir = resolve(compatLine, "stations", "station-a");
    mkdirSync(saDir, { recursive: true });
    writeFileSync(resolve(saDir, "AGENT.md"), "---\n---\nTest");
    initSectionQueue(saDir);
    initLineQueue(compatLine);

    const freshTime = new Date(Date.now() - 60_000).toISOString();
    const oldTime = new Date(Date.now() - 72 * 3_600_000).toISOString();
    writeFileSync(resolve(compatLine, "queues", "error", "wp-compat-fresh.json"), JSON.stringify({
      id: "wp-compat-fresh", line: "banner-compat-line", task: "fresh", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: freshTime, finished_at: freshTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));
    writeFileSync(resolve(compatLine, "queues", "error", "wp-compat-old.json"), JSON.stringify({
      id: "wp-compat-old", line: "banner-compat-line", task: "old", input: {},
      stations: { "station-a": { summary: "failed", status: "failed", started_at: oldTime, finished_at: oldTime, model: "test", tokens: { in: 100, out: 50 }, cost_usd: 0.01 } },
    }));

    const state = (await getFullState(compatLine)) as any;

    // errors contains BOTH (no age filtering)
    expect(state.errors.length).toBe(2);
    // errors items do NOT have severity field
    for (const e of state.errors) {
      expect(e).not.toHaveProperty("severity");
    }
    // banner_errors items DO have severity field
    for (const e of state.banner_errors) {
      expect(e).toHaveProperty("severity");
    }
  });
});

describe("computeThroughput", () => {
  const TP_DIR = resolve(TEMP_DIR, "tp-done");

  beforeAll(() => {
    mkdirSync(TP_DIR, { recursive: true });
  });

  function writeWithMtime(name: string, msAgo: number) {
    const path = resolve(TP_DIR, name);
    writeFileSync(path, "{}");
    const ts = (Date.now() - msAgo) / 1000; // utimesSync expects seconds
    utimesSync(path, ts, ts);
  }

  test("returns zeros when directory is missing", () => {
    const counts = computeThroughput(resolve(TEMP_DIR, "does-not-exist"));
    expect(counts).toEqual({ last_1h: 0, last_24h: 0 });
  });

  test("counts files by mtime within rolling 1h and 24h windows", () => {
    // 2 within the last hour, 3 more within the last day, 1 older than 24h
    writeWithMtime("wp-a.json", 5 * 60 * 1000);        // 5m ago    -> 1h + 24h
    writeWithMtime("wp-b.json", 30 * 60 * 1000);       // 30m ago   -> 1h + 24h
    writeWithMtime("wp-c.json", 3 * 60 * 60 * 1000);   // 3h ago    -> 24h only
    writeWithMtime("wp-d.json", 10 * 60 * 60 * 1000);  // 10h ago   -> 24h only
    writeWithMtime("wp-e.json", 23 * 60 * 60 * 1000);  // 23h ago   -> 24h only
    writeWithMtime("wp-f.json", 30 * 60 * 60 * 1000);  // 30h ago   -> neither
    writeFileSync(resolve(TP_DIR, "not-json.txt"), "ignore me"); // non-.json ignored

    const counts = computeThroughput(TP_DIR);
    expect(counts.last_1h).toBe(2);
    expect(counts.last_24h).toBe(5);
  });

  test("uses provided `now` to pin the window", () => {
    // Pin to 20h in the past.
    // Files relative to real now:
    //  wp-a: 5m ago   -> relative to pin: 5m - 20h = +19h55m in "future" of pin -> outside both windows
    //  wp-b: 30m ago  -> relative to pin: 30m - 20h -> outside both windows
    //  wp-c: 3h ago   -> relative to pin: 3h - 20h  -> outside both windows
    //  wp-d: 10h ago  -> relative to pin: 10h - 20h -> outside both windows
    //  wp-e: 23h ago  -> relative to pin: 23h - 20h = 3h before pin -> within 24h, outside 1h
    //  wp-f: 30h ago  -> relative to pin: 30h - 20h = 10h before pin -> within 24h, outside 1h
    const pin = Date.now() - 20 * 60 * 60 * 1000;
    const counts = computeThroughput(TP_DIR, pin);
    expect(counts.last_1h).toBe(0);
    expect(counts.last_24h).toBe(2);
  });
});

describe("connectionHealth", () => {
  test("ageMs = 0 → live", () => {
    expect(connectionHealth(0)).toBe("live");
  });
  test("ageMs just under 5s → live", () => {
    expect(connectionHealth(CONNECTION_LIVE_THRESHOLD_MS - 1)).toBe("live");
  });
  test("ageMs exactly 5s → stale (boundary inclusive on stale side)", () => {
    expect(connectionHealth(CONNECTION_LIVE_THRESHOLD_MS)).toBe("stale");
  });
  test("ageMs midway in stale band → stale", () => {
    expect(connectionHealth(15_000)).toBe("stale");
  });
  test("ageMs exactly 30s → stale (upper boundary inclusive)", () => {
    expect(connectionHealth(CONNECTION_STALE_THRESHOLD_MS)).toBe("stale");
  });
  test("ageMs just over 30s → disconnected", () => {
    expect(connectionHealth(CONNECTION_STALE_THRESHOLD_MS + 1)).toBe("disconnected");
  });
  test("large ageMs (5 min) → disconnected", () => {
    expect(connectionHealth(5 * 60_000)).toBe("disconnected");
  });
  test("negative ageMs → disconnected (guard)", () => {
    expect(connectionHealth(-1)).toBe("disconnected");
  });
  test("Infinity → disconnected", () => {
    expect(connectionHealth(Infinity)).toBe("disconnected");
  });
  test("NaN → disconnected", () => {
    expect(connectionHealth(NaN)).toBe("disconnected");
  });
});

// ─── getHistory ────────────────────────────────────────────────────

describe("getHistory", () => {
  // Helpers to create a minimal line dir for history tests
  function makeHistoryLine(name: string): string {
    const dir = resolve(TEMP_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "line.yaml"), `name: ${name}\nsequence:\n  - sa\n  - sb\n`);
    const stA = resolve(dir, "stations", "sa");
    const stB = resolve(dir, "stations", "sb");
    mkdirSync(stA, { recursive: true });
    mkdirSync(stB, { recursive: true });
    writeFileSync(resolve(stA, "AGENT.md"), "---\n---\nStation A");
    writeFileSync(resolve(stB, "AGENT.md"), "---\n---\nStation B");
    initSectionQueue(stA);
    initSectionQueue(stB);
    initLineQueue(dir);
    return dir;
  }

  /** Build a workpiece JSON where sa runs from saStart for saDuration ms and sb runs from sbStart for sbDuration ms */
  function makeHistoryWorkpiece(
    id: string,
    saStart: Date,
    saDurationMs: number,
    sbStart: Date,
    sbDurationMs: number,
    source: "done" | "error" = "done"
  ): string {
    const saEnd = new Date(saStart.getTime() + saDurationMs);
    const sbEnd = new Date(sbStart.getTime() + sbDurationMs);
    return JSON.stringify({
      id,
      line: "test",
      task: `task for ${id}`,
      input: {},
      stations: {
        sa: {
          summary: source === "error" ? "failed" : "done",
          status: source === "error" ? "failed" : "done",
          started_at: saStart.toISOString(),
          finished_at: saEnd.toISOString(),
          model: "test",
          tokens: { in: 10, out: 5 },
          cost_usd: 0.001,
        },
        sb: {
          summary: "done",
          status: "done",
          started_at: sbStart.toISOString(),
          finished_at: sbEnd.toISOString(),
          model: "test",
          tokens: { in: 10, out: 5 },
          cost_usd: 0.001,
        },
      },
    });
  }

  function setMtime(filePath: string, tsMs: number) {
    const tsSec = tsMs / 1000;
    utimesSync(filePath, tsSec, tsSec);
  }

  // ── Test 1: empty line ────────────────────────────────────────────
  test("empty line → empty runs, perStationStats keyed by sequence with nulls", async () => {
    const dir = makeHistoryLine("getHistory-empty");
    const result = await getHistory(dir) as any;
    expect(result.runs).toHaveLength(0);
    expect(Object.keys(result.perStationStats)).toEqual(["sa", "sb"]);
    expect(result.perStationStats.sa.count).toBe(0);
    expect(result.perStationStats.sa.avg_duration_ms).toBeNull();
    expect(result.perStationStats.sa.min_duration_ms).toBeNull();
    expect(result.perStationStats.sa.max_duration_ms).toBeNull();
    expect(result.limit).toBe(HISTORY_DEFAULT_LIMIT);
    expect(result.include).toEqual(["done"]);
  });

  // ── Test 2: 3 workpieces, correct ordering and stats ──────────────
  test("3 done workpieces with pinned mtimes → newest-first, correct stats", async () => {
    const dir = makeHistoryLine("getHistory-3runs");
    const doneDir = resolve(dir, "queues", "done");

    const baseTime = new Date("2025-01-01T10:00:00Z");

    // wp-1: sa=100s, sb=200s
    const wp1Start = baseTime;
    const wp1 = makeHistoryWorkpiece("wp-1", wp1Start, 100_000, new Date(wp1Start.getTime() + 100_000), 200_000);
    writeFileSync(resolve(doneDir, "wp-1.json"), wp1);
    setMtime(resolve(doneDir, "wp-1.json"), baseTime.getTime() + 300_000);

    // wp-2: sa=50s, sb=150s
    const wp2Start = new Date(baseTime.getTime() + 600_000);
    const wp2 = makeHistoryWorkpiece("wp-2", wp2Start, 50_000, new Date(wp2Start.getTime() + 50_000), 150_000);
    writeFileSync(resolve(doneDir, "wp-2.json"), wp2);
    setMtime(resolve(doneDir, "wp-2.json"), baseTime.getTime() + 800_000);

    // wp-3: sa=200s, sb=100s (newest)
    const wp3Start = new Date(baseTime.getTime() + 1_200_000);
    const wp3 = makeHistoryWorkpiece("wp-3", wp3Start, 200_000, new Date(wp3Start.getTime() + 200_000), 100_000);
    writeFileSync(resolve(doneDir, "wp-3.json"), wp3);
    setMtime(resolve(doneDir, "wp-3.json"), baseTime.getTime() + 1_500_000);

    const result = await getHistory(dir) as any;

    expect(result.runs).toHaveLength(3);
    // Newest first
    expect(result.runs[0].id).toBe("wp-3");
    expect(result.runs[1].id).toBe("wp-2");
    expect(result.runs[2].id).toBe("wp-1");

    // Per-cell durations
    expect(result.runs[0].stations.sa.duration_ms).toBe(200_000);
    expect(result.runs[2].stations.sb.duration_ms).toBe(200_000);

    // Stats for sa: [200000, 50000, 100000] → avg=116667, min=50000, max=200000
    expect(result.perStationStats.sa.count).toBe(3);
    expect(result.perStationStats.sa.min_duration_ms).toBe(50_000);
    expect(result.perStationStats.sa.max_duration_ms).toBe(200_000);
    expect(result.perStationStats.sa.avg_duration_ms).toBe(Math.round((100_000 + 50_000 + 200_000) / 3));
  });

  // ── Test 3: limit truncates ───────────────────────────────────────
  test("limit: 2 on 3-run line returns only 2 newest", async () => {
    const dir = resolve(TEMP_DIR, "getHistory-3runs"); // reuse from test 2
    const result = await getHistory(dir, { limit: 2 }) as any;
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].id).toBe("wp-3");
    expect(result.runs[1].id).toBe("wp-2");
    expect(result.limit).toBe(2);
  });

  // ── Test 4: limit clamped to HISTORY_MAX_LIMIT ───────────────────
  test("limit 9999 is clamped to HISTORY_MAX_LIMIT", async () => {
    const dir = resolve(TEMP_DIR, "getHistory-3runs"); // reuse
    const result = await getHistory(dir, { limit: 9999 }) as any;
    expect(result.limit).toBe(HISTORY_MAX_LIMIT);
  });

  // ── Test 5: include=error merges error workpieces ─────────────────
  test("include=[done,error] folds error workpieces in; default done-only still excludes them", async () => {
    const dir = makeHistoryLine("getHistory-errors");
    const doneDir = resolve(dir, "queues", "done");
    const errorDir = resolve(dir, "queues", "error");

    const base = new Date("2025-02-01T10:00:00Z");

    // 3 done workpieces
    for (let i = 1; i <= 3; i++) {
      const st = new Date(base.getTime() + i * 300_000);
      const wp = makeHistoryWorkpiece(`wp-d${i}`, st, 60_000, new Date(st.getTime() + 60_000), 60_000, "done");
      writeFileSync(resolve(doneDir, `wp-d${i}.json`), wp);
      setMtime(resolve(doneDir, `wp-d${i}.json`), base.getTime() + i * 300_000 + 120_000);
    }

    // 1 error workpiece (newest)
    const errStart = new Date(base.getTime() + 4 * 300_000);
    const errWp = makeHistoryWorkpiece("wp-err", errStart, 30_000, new Date(errStart.getTime() + 30_000), 30_000, "error");
    writeFileSync(resolve(errorDir, "wp-err.json"), errWp);
    setMtime(resolve(errorDir, "wp-err.json"), base.getTime() + 4 * 300_000 + 120_000 + 10); // newer than all done

    // With error included
    const resultWithError = await getHistory(dir, { include: ["done", "error"] }) as any;
    expect(resultWithError.runs).toHaveLength(4);
    expect(resultWithError.runs[0].id).toBe("wp-err");
    expect(resultWithError.runs[0].source).toBe("error");

    // Default done-only
    const resultDoneOnly = await getHistory(dir) as any;
    expect(resultDoneOnly.runs).toHaveLength(3);
    expect(resultDoneOnly.runs.every((r: any) => r.source === "done")).toBe(true);
  });

  // ── Test 6: missing station → null cell ───────────────────────────
  test("workpiece missing station sb → null cell, perStationStats.sb.count excludes it", async () => {
    const dir = makeHistoryLine("getHistory-partial");
    const doneDir = resolve(dir, "queues", "done");

    const base = new Date("2025-03-01T10:00:00Z");

    // wp-full: both stations
    const full = makeHistoryWorkpiece("wp-full", base, 60_000, new Date(base.getTime() + 60_000), 60_000);
    writeFileSync(resolve(doneDir, "wp-full.json"), full);
    setMtime(resolve(doneDir, "wp-full.json"), base.getTime() + 130_000);

    // wp-partial: only sa, no sb key
    const partial = JSON.stringify({
      id: "wp-partial",
      line: "test",
      task: "partial task",
      input: {},
      stations: {
        sa: {
          summary: "done",
          status: "done",
          started_at: new Date(base.getTime() + 200_000).toISOString(),
          finished_at: new Date(base.getTime() + 250_000).toISOString(),
          model: "test",
          tokens: { in: 10, out: 5 },
          cost_usd: 0.001,
        },
        // no sb
      },
    });
    writeFileSync(resolve(doneDir, "wp-partial.json"), partial);
    setMtime(resolve(doneDir, "wp-partial.json"), base.getTime() + 260_000);

    const result = await getHistory(dir) as any;
    // wp-partial is newest
    const partialRun = result.runs.find((r: any) => r.id === "wp-partial");
    expect(partialRun).toBeDefined();
    expect(partialRun.stations.sb.duration_ms).toBeNull();
    expect(partialRun.stations.sb.status).toBeNull();

    // sb stats should count only wp-full (1 run)
    expect(result.perStationStats.sb.count).toBe(1);
  });

  // ── Test 7: malformed JSON skipped ───────────────────────────────
  test("malformed JSON in queues/done is skipped without error", async () => {
    const dir = makeHistoryLine("getHistory-malformed");
    const doneDir = resolve(dir, "queues", "done");

    writeFileSync(resolve(doneDir, "wp-bad.json"), "{ not valid json");
    // Should not throw; bad file absent from runs
    const result = await getHistory(dir) as any;
    expect(result.runs).toHaveLength(0);
    expect(result).not.toHaveProperty("error");
  });

  // ── Test 8: invalid linePath → error object ───────────────────────
  test("invalid linePath returns { error: 'Failed to load line' }", async () => {
    const result = await getHistory("/nonexistent/path/that/does/not/exist") as any;
    expect(result.error).toBe("Failed to load line");
  });

  // ── Test 9: backward compat — getFullState shape unchanged ────────
  test("getFullState shape unchanged — no new 'history' field added", async () => {
    const state = await getFullState(LINE_DIR) as any;
    const expectedKeys = [
      "line", "sequence", "lineQueue", "sections", "activity", "completed",
      "errors", "errorsDismissed", "reviews", "triggers", "stationTimings",
      "pipelineTotalMs", "health", "sessionTotals", "throughput", "timestamp",
    ];
    for (const key of expectedKeys) {
      expect(state).toHaveProperty(key);
    }
    expect(state).not.toHaveProperty("history");
  });
});

describe("flow-snapshot", () => {
  test("takeSnapshot captures line + per-station queue counts", () => {
    const snap = takeSnapshot(LINE_DIR, ["station-a", "station-b"]);
    expect(snap.ts).toBeDefined();
    expect(new Date(snap.ts).toString()).not.toBe("Invalid Date");
    expect(snap.line.done).toBeGreaterThanOrEqual(2);   // fixture wrote 2 done wps
    expect(snap.line.error).toBeGreaterThanOrEqual(1);  // fixture wrote 1 error
    expect(snap.sections["station-a"]).toHaveProperty("inbox");
    expect(snap.sections["station-a"]).toHaveProperty("processing");
    expect(snap.sections["station-a"]).toHaveProperty("output");
    expect(snap.sections["station-a"].processing).toBeGreaterThanOrEqual(1); // fixture wrote wp-in-flight
    expect(snap.sections["station-b"]).toBeDefined();
  });

  test("appendSnapshot writes one JSONL line, subsequent calls append", () => {
    const tmp = resolve(TEMP_DIR, "append-line");
    mkdirSync(resolve(tmp, "stations", "s"), { recursive: true });
    writeFileSync(resolve(tmp, "line.yaml"), "name: append-line\nsequence:\n  - s\n");
    initSectionQueue(resolve(tmp, "stations", "s"));
    initLineQueue(tmp);
    const a: FlowSnapshot = { ts: "2026-04-19T00:00:00.000Z", line: { inbox: 0, done: 0, error: 0, errorActive: 0, review: 0 }, sections: { s: { inbox: 0, processing: 0, output: 0 } } };
    const b: FlowSnapshot = { ...a, ts: "2026-04-19T00:01:00.000Z" };
    appendSnapshot(tmp, a);
    appendSnapshot(tmp, b);
    const content = readFileSync(flowFilePath(tmp), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).ts).toBe(a.ts);
    expect(JSON.parse(lines[1]).ts).toBe(b.ts);
  });

  test("readFlowHistory filters by age window", () => {
    const tmp = resolve(TEMP_DIR, "age-line");
    mkdirSync(resolve(tmp, "queues"), { recursive: true });
    const now = Date.now();
    const oldTs = new Date(now - 48 * 3600 * 1000).toISOString(); // 48h old
    const freshTs = new Date(now - 60 * 1000).toISOString();      // 1m old
    const mk = (ts: string): FlowSnapshot => ({ ts, line: { inbox: 0, done: 0, error: 0, errorActive: 0, review: 0 }, sections: {} });
    appendSnapshot(tmp, mk(oldTs));
    appendSnapshot(tmp, mk(freshTs));
    const out = readFlowHistory(tmp, { hours: 24, now });
    expect(out.total).toBe(1);
    expect(out.snapshots[0].ts).toBe(freshTs);
  });

  test("readFlowHistory downsamples and always keeps the newest point", () => {
    const tmp = resolve(TEMP_DIR, "downsample-line");
    mkdirSync(resolve(tmp, "queues"), { recursive: true });
    const now = Date.now();
    for (let i = 999; i >= 0; i--) {
      const ts = new Date(now - i * 60 * 1000).toISOString();
      appendSnapshot(tmp, { ts, line: { inbox: i, done: 0, error: 0, errorActive: 0, review: 0 }, sections: {} });
    }
    const out = readFlowHistory(tmp, { hours: 168, maxPoints: 100, now });
    expect(out.total).toBe(1000);
    expect(out.snapshots.length).toBeLessThanOrEqual(101); // 100 + possible tail dup-guarded
    expect(out.snapshots.length).toBeGreaterThanOrEqual(100);
    // Newest point always present (inbox=0 is the most recent, written with i=0)
    expect(out.snapshots[out.snapshots.length - 1].line.inbox).toBe(0);
  });

  test("readFlowHistory tolerates malformed lines", () => {
    const tmp = resolve(TEMP_DIR, "malformed-line");
    mkdirSync(resolve(tmp, "queues"), { recursive: true });
    const now = Date.now();
    const goodTs = new Date(now - 60 * 1000).toISOString();
    writeFileSync(flowFilePath(tmp),
      "not-json\n" +
      JSON.stringify({ ts: goodTs, line: { inbox: 5, done: 0, error: 0, errorActive: 0, review: 0 }, sections: {} }) + "\n" +
      "{\"missing_ts\":true}\n"
    );
    const out = readFlowHistory(tmp, { hours: 24, now });
    expect(out.total).toBe(1);
    expect(out.snapshots[0].line.inbox).toBe(5);
  });

  test("readFlowHistory returns empty when file does not exist", () => {
    const tmp = resolve(TEMP_DIR, "nofile-line");
    const out = readFlowHistory(tmp);
    expect(out.total).toBe(0);
    expect(out.snapshots).toEqual([]);
  });

  test("startFlowSnapshotWriter writes immediately and on interval", async () => {
    const tmp = resolve(TEMP_DIR, "writer-line");
    mkdirSync(resolve(tmp, "stations", "s"), { recursive: true });
    writeFileSync(resolve(tmp, "line.yaml"), "name: writer-line\nsequence:\n  - s\n");
    initSectionQueue(resolve(tmp, "stations", "s"));
    initLineQueue(tmp);
    const handle = startFlowSnapshotWriter(tmp, ["s"], { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 180));
    handle.stop();
    const content = readFileSync(flowFilePath(tmp), "utf-8").trim().split("\n");
    expect(content.length).toBeGreaterThanOrEqual(2); // t0 tick + at least one interval tick
    // Sanity: each line parses as a FlowSnapshot with a string ts
    for (const line of content) {
      const snap = JSON.parse(line) as FlowSnapshot;
      expect(typeof snap.ts).toBe("string");
      expect(snap.sections).toHaveProperty("s");
    }
  });

  test("backward compat: getFullState still works and does not touch flow.jsonl", async () => {
    // getFullState must NOT require flow.jsonl to exist. Fixture LINE_DIR has no flow.jsonl.
    const state = await getFullState(LINE_DIR);
    expect(state).not.toHaveProperty("error");
    expect(state).toHaveProperty("sections");
    expect(existsSync(flowFilePath(LINE_DIR))).toBe(false);
  });
});

describe("getKanbanState", () => {
  function setupKanbanLine(name: string, opts: { concurrency?: number } = {}): string {
    const dir = resolve(TEMP_DIR, name);
    mkdirSync(dir, { recursive: true });
    const concurrencyLine = opts.concurrency !== undefined ? `concurrency: ${opts.concurrency}\n` : "";
    writeFileSync(
      resolve(dir, "line.yaml"),
      `name: ${name}\n${concurrencyLine}sequence:\n  - station-a\n  - station-b\n`
    );
    const stationA = resolve(dir, "stations", "station-a");
    const stationB = resolve(dir, "stations", "station-b");
    mkdirSync(stationA, { recursive: true });
    mkdirSync(stationB, { recursive: true });
    writeFileSync(resolve(stationA, "AGENT.md"), "---\n---\nprompt A");
    writeFileSync(resolve(stationB, "AGENT.md"), "---\n---\nprompt B");
    initSectionQueue(stationA);
    initSectionQueue(stationB);
    initLineQueue(dir);
    return dir;
  }

  test("returns error for invalid line path", async () => {
    const out = await getKanbanState("/nonexistent/kanban/path");
    expect(out).toHaveProperty("error", "Failed to load line");
  });

  test("builds columns for line + each station with three lanes", async () => {
    const dir = setupKanbanLine("kanban-shape", { concurrency: 3 });
    const out = (await getKanbanState(dir)) as KanbanState;
    expect(out).not.toHaveProperty("error");
    expect(out.line).toBe("kanban-shape");
    expect(out.sequence).toEqual(["station-a", "station-b"]);
    expect(out.concurrency).toBe(3);

    const keys = out.columns.map((c) => c.key);
    // Review/error omitted when empty; held is always present
    expect(keys).not.toContain("review");
    expect(keys).not.toContain("error");
    // Always-present columns
    expect(keys).toContain("inbox");
    expect(keys).toContain("held");
    expect(keys).toContain("station-a:inbox");
    expect(keys).toContain("station-a:processing");
    expect(keys).toContain("station-a:output");
    expect(keys).toContain("station-b:inbox");
    expect(keys).toContain("station-b:processing");
    expect(keys).toContain("station-b:output");
    expect(keys).toContain("done");

    // Per-station lanes carry wipLimit = concurrency
    const procA = out.columns.find((c) => c.key === "station-a:processing")!;
    expect(procA.station).toBe("station-a");
    expect(procA.lane).toBe("processing");
    expect(procA.wipLimit).toBe(3);
  });

  test("card placement follows filesystem location", async () => {
    const dir = setupKanbanLine("kanban-placement");

    // Line inbox
    writeFileSync(
      resolve(dir, "queues", "inbox", "wp-inbox.json"),
      makeWorkpiece("wp-inbox", "waiting at line inbox")
    );
    // Station A processing (running)
    writeFileSync(
      resolve(dir, "stations", "station-a", "queue", "processing", "wp-run.json"),
      makeWorkpiece("wp-run", "running at A")
    );
    // Station B inbox
    writeFileSync(
      resolve(dir, "stations", "station-b", "queue", "inbox", "wp-qb.json"),
      makeWorkpiece("wp-qb", "queued at B")
    );
    // Done
    writeFileSync(
      resolve(dir, "queues", "done", "wp-completed.json"),
      makeWorkpiece("wp-completed", "all done")
    );

    const out = (await getKanbanState(dir)) as KanbanState;
    const colOf = (id: string) => {
      for (const c of out.columns) {
        if (c.cards.some((x) => x.id === id)) return c.key;
      }
      return null;
    };
    expect(colOf("wp-inbox")).toBe("inbox");
    expect(colOf("wp-run")).toBe("station-a:processing");
    expect(colOf("wp-qb")).toBe("station-b:inbox");
    expect(colOf("wp-completed")).toBe("done");

    const cardRun = out.columns
      .find((c) => c.key === "station-a:processing")!
      .cards.find((x) => x.id === "wp-run")!;
    expect(cardRun.state).toBe("running");
    expect(cardRun.station).toBe("station-a");
    expect(cardRun.lane).toBe("processing");
    expect(cardRun.title).toBe("running at A");
  });

  test("processing card with pending eval derives state 'evaluating'", async () => {
    const dir = setupKanbanLine("kanban-eval");
    const evalWp = JSON.stringify({
      id: "wp-eval",
      line: "kanban-eval",
      task: "mid-eval",
      input: {},
      stations: {
        "station-a": {
          summary: "evaluating",
          status: "done",
          started_at: new Date().toISOString(),
          finished_at: "", // empty = falsy → evaluating branch
          model: "test",
          tokens: { in: 1, out: 1 },
          cost_usd: 0,
          eval: { pass: false, feedback: "retry please" },
        },
      },
    });
    writeFileSync(
      resolve(dir, "stations", "station-a", "queue", "processing", "wp-eval.json"),
      evalWp
    );
    const out = (await getKanbanState(dir)) as KanbanState;
    const card = out.columns
      .find((c) => c.key === "station-a:processing")!
      .cards.find((x) => x.id === "wp-eval")!;
    expect(card.state).toBe("evaluating");
  });

  test("retry count aggregates from activity.jsonl and flips state to 'retrying'", async () => {
    const dir = setupKanbanLine("kanban-retry");
    writeFileSync(
      resolve(dir, "stations", "station-a", "queue", "processing", "wp-retry.json"),
      makeWorkpiece("wp-retry", "retrying work")
    );
    const log = [
      { ts: "2026-04-20T10:00:00Z", event: "retry", workpiece: "wp-retry" },
      { ts: "2026-04-20T10:01:00Z", event: "retry", workpiece: "wp-retry" },
      { ts: "2026-04-20T10:02:00Z", event: "retry", workpiece: "wp-other" },
    ].map((e) => JSON.stringify(e));
    writeFileSync(resolve(dir, "queues", "activity.jsonl"), log.join("\n") + "\n");

    const out = (await getKanbanState(dir)) as KanbanState;
    const card = out.columns
      .find((c) => c.key === "station-a:processing")!
      .cards.find((x) => x.id === "wp-retry")!;
    expect(card.retries).toBe(2);
    expect(card.state).toBe("retrying");
  });

  test("held tasks appear in held column with state 'held'", async () => {
    const dir = setupKanbanLine("kanban-held");
    writeFileSync(
      resolve(dir, "queues", "held", "wp-held.json"),
      JSON.stringify({ id: "wp-held", line: "kanban-held", task: "on hold", input: {}, stations: {} })
    );
    const out = (await getKanbanState(dir)) as KanbanState;
    const heldCol = out.columns.find((c) => c.key === "held");
    expect(heldCol).toBeDefined();
    expect(heldCol!.count).toBe(1);
    expect(heldCol!.cards[0].state).toBe("held");
    expect(heldCol!.cards[0].title).toBe("on hold");
  });

  test("held column is always present even with zero held tasks", async () => {
    const dir = setupKanbanLine("kanban-held-empty");
    // Don't write any held files
    const out = (await getKanbanState(dir)) as KanbanState;
    const heldCol = out.columns.find((c) => c.key === "held");
    expect(heldCol).toBeDefined();
    expect(heldCol!.count).toBe(0);
    expect(heldCol!.cards).toHaveLength(0);
    expect(heldCol!.title).toBe("Held");
  });

  test("held column is positioned before inbox and before first station", async () => {
    const dir = setupKanbanLine("kanban-held-order");
    const out = (await getKanbanState(dir)) as KanbanState;
    const keys = out.columns.map((c) => c.key);
    const inboxIdx = keys.indexOf("inbox");
    const heldIdx = keys.indexOf("held");
    const firstStationIdx = keys.findIndex((k) => k.includes(":"));
    expect(heldIdx).toBeGreaterThanOrEqual(0);
    expect(inboxIdx).toBe(heldIdx + 1);
    expect(firstStationIdx).toBe(inboxIdx + 1);
  });

  test("dismissed errors are excluded from error column; active errors appear", async () => {
    const dir = setupKanbanLine("kanban-err");
    const errorWp = JSON.stringify({
      id: "wp-err-active",
      line: "kanban-err",
      task: "error active",
      input: {},
      stations: {
        "station-a": {
          summary: "boom",
          status: "failed",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          model: "t",
          tokens: { in: 0, out: 0 },
          cost_usd: 0,
        },
      },
    });
    writeFileSync(resolve(dir, "queues", "error", "wp-err-active.json"), errorWp);
    writeFileSync(
      resolve(dir, "queues", "error", "wp-err-dismissed.json"),
      errorWp.replace("wp-err-active", "wp-err-dismissed")
    );
    dismissFilenames(dir, ["wp-err-dismissed.json"]);

    const out = (await getKanbanState(dir)) as KanbanState;
    const errCol = out.columns.find((c) => c.key === "error");
    expect(errCol).toBeDefined();
    expect(errCol!.cards.length).toBe(1);
    expect(errCol!.cards[0].fileName).toBe("wp-err-active.json");
    expect(errCol!.cards[0].state).toBe("failed");
  });

  test("moving a file between folders changes card column on next read", async () => {
    const dir = setupKanbanLine("kanban-move");
    const src = resolve(dir, "stations", "station-a", "queue", "processing", "wp-move.json");
    writeFileSync(src, makeWorkpiece("wp-move", "moving piece"));

    const first = (await getKanbanState(dir)) as KanbanState;
    const firstCol = first.columns
      .find((c) => c.cards.some((x) => x.id === "wp-move"))!.key;
    expect(firstCol).toBe("station-a:processing");

    // Move to station-a output
    const dst = resolve(dir, "stations", "station-a", "queue", "output", "wp-move.json");
    renameSync(src, dst);

    const second = (await getKanbanState(dir)) as KanbanState;
    const secondCol = second.columns
      .find((c) => c.cards.some((x) => x.id === "wp-move"))!.key;
    expect(secondCol).toBe("station-a:output");
    const card = second.columns
      .find((c) => c.key === "station-a:output")!
      .cards.find((x) => x.id === "wp-move")!;
    expect(card.state).toBe("routed");
  });
});
