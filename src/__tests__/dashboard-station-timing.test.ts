import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getStationTimings, computeStationFreshness } from "../dashboard-data";
import { initSectionQueue } from "../queue";

const TMP = "/tmp/assembly-test-station-timing-" + Date.now();

describe("getStationTimings - processing file priority and mtime fallback", () => {
  beforeEach(() => {
    // Create line structure
    mkdirSync(resolve(TMP, "stations", "station-a"), { recursive: true });
    mkdirSync(resolve(TMP, "queues", "done"), { recursive: true });

    // Create line.yaml
    const lineYaml = `name: test-line
sequence:
  - station-a
`;
    writeFileSync(resolve(TMP, "line.yaml"), lineYaml);

    // Initialize station queue (creates inbox/, processing/, output/)
    initSectionQueue(resolve(TMP, "stations", "station-a"));
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("processing file with started_at returns running with envelope started_at", () => {
    const startedAt = "2026-01-01T00:00:00Z";
    const finishedAt = "2026-01-01T01:00:00Z";

    const workpiece = {
      task: "test-task",
      stations: {
        "station-a": {
          started_at: startedAt,
          finished_at: finishedAt,
          status: "done",
        },
      },
    };

    const processingFile = resolve(TMP, "stations", "station-a", "queue", "processing", "test.json");
    writeFileSync(processingFile, JSON.stringify(workpiece));

    const timings = getStationTimings(TMP, ["station-a"]);

    expect(timings["station-a"]).toBeDefined();
    expect(timings["station-a"].running).toBe(true);
    expect(timings["station-a"].started_at).toBe(startedAt);
    expect(timings["station-a"].finished_at).toBeUndefined();
  });

  it("processing file with station record but no started_at returns running with mtime fallback", () => {
    const workpiece = {
      task: "test-task",
      stations: {
        "station-a": {
          status: "done",
        },
      },
    };

    const processingFile = resolve(TMP, "stations", "station-a", "queue", "processing", "test.json");
    writeFileSync(processingFile, JSON.stringify(workpiece));

    const timings = getStationTimings(TMP, ["station-a"]);

    expect(timings["station-a"]).toBeDefined();
    expect(timings["station-a"].running).toBe(true);
    expect(timings["station-a"].started_at).toBeDefined();
    // Verify it's a valid ISO string
    expect(() => new Date(timings["station-a"].started_at).toISOString()).not.toThrow();
    expect(timings["station-a"].finished_at).toBeUndefined();
  });

  it("processing file with no station record at all returns running with mtime fallback", () => {
    const workpiece = {
      task: "test-task",
      stations: {},
    };

    const processingFile = resolve(TMP, "stations", "station-a", "queue", "processing", "test.json");
    writeFileSync(processingFile, JSON.stringify(workpiece));

    const timings = getStationTimings(TMP, ["station-a"]);

    expect(timings["station-a"]).toBeDefined();
    expect(timings["station-a"].running).toBe(true);
    expect(timings["station-a"].started_at).toBeDefined();
    // Verify it's a valid ISO string
    expect(() => new Date(timings["station-a"].started_at).toISOString()).not.toThrow();
    expect(timings["station-a"].finished_at).toBeUndefined();
  });

  it("no processing file, output file returns finished timing", () => {
    const startedAt = "2026-01-01T00:00:00Z";
    const finishedAt = "2026-01-01T01:00:00Z";

    const workpiece = {
      task: "test-task",
      stations: {
        "station-a": {
          started_at: startedAt,
          finished_at: finishedAt,
          status: "done",
        },
      },
    };

    const outputFile = resolve(TMP, "stations", "station-a", "queue", "output", "test.json");
    writeFileSync(outputFile, JSON.stringify(workpiece));

    const timings = getStationTimings(TMP, ["station-a"]);

    expect(timings["station-a"]).toBeDefined();
    expect(timings["station-a"].started_at).toBe(startedAt);
    expect(timings["station-a"].finished_at).toBe(finishedAt);
    expect(timings["station-a"].duration_ms).toBeDefined();
    expect(timings["station-a"].running).toBeUndefined();
  });

  it("no processing, no output, done file returns finished timing", () => {
    const startedAt = "2026-01-01T00:00:00Z";
    const finishedAt = "2026-01-01T01:00:00Z";

    const workpiece = {
      task: "test-task",
      stations: {
        "station-a": {
          started_at: startedAt,
          finished_at: finishedAt,
          status: "done",
        },
      },
    };

    const doneFile = resolve(TMP, "queues", "done", "test.json");
    writeFileSync(doneFile, JSON.stringify(workpiece));

    const timings = getStationTimings(TMP, ["station-a"]);

    expect(timings["station-a"]).toBeDefined();
    expect(timings["station-a"].started_at).toBe(startedAt);
    expect(timings["station-a"].finished_at).toBe(finishedAt);
    expect(timings["station-a"].duration_ms).toBeDefined();
    expect(timings["station-a"].running).toBeUndefined();
  });

  it("computeStationFreshness does not return completed when processing file exists without started_at", () => {
    // Create a processing file without started_at (triggers mtime fallback)
    const workpiece = {
      task: "test-task",
      stations: {},
    };
    const processingFile = resolve(TMP, "stations", "station-a", "queue", "processing", "test.json");
    writeFileSync(processingFile, JSON.stringify(workpiece));

    // Also create a prior completed workpiece in done/ with both timestamps
    const oldStartedAt = "2026-01-01T00:00:00Z";
    const oldFinishedAt = "2026-01-01T01:00:00Z";
    const oldWorkpiece = {
      task: "old-task",
      stations: {
        "station-a": {
          started_at: oldStartedAt,
          finished_at: oldFinishedAt,
          status: "done",
        },
      },
    };
    const doneFile = resolve(TMP, "queues", "done", "old.json");
    writeFileSync(doneFile, JSON.stringify(oldWorkpiece));

    // Get timings - should return running:true from Priority 1 (processing), not fallthrough to Priority 3 (done)
    const timings = getStationTimings(TMP, ["station-a"]);
    expect(timings["station-a"].running).toBe(true);
    expect(timings["station-a"].finished_at).toBeUndefined();

    // Compute freshness - should NOT be "completed" because timing.running is true
    const sections = { "station-a": { inbox: 0, processing: 1, output: 0 } };
    const freshness = computeStationFreshness(TMP, ["station-a"], sections, timings);

    expect(freshness["station-a"].state).not.toBe("completed");
    // Without heartbeat data, should be "fresh" with "Starting" label
    expect(freshness["station-a"].state).toBe("fresh");
    expect(freshness["station-a"].label).toBe("Starting");
  });

  it("backward compat: processing file with started_at still works identically", () => {
    const startedAt = "2026-01-01T00:00:00Z";

    // Processing file with proper started_at
    const workpiece = {
      task: "test-task",
      stations: {
        "station-a": {
          started_at: startedAt,
          status: "running",
        },
      },
    };
    const processingFile = resolve(TMP, "stations", "station-a", "queue", "processing", "test.json");
    writeFileSync(processingFile, JSON.stringify(workpiece));

    // Stale completed workpiece in done
    const oldStartedAt = "2025-12-31T00:00:00Z";
    const oldFinishedAt = "2025-12-31T01:00:00Z";
    const oldWorkpiece = {
      task: "old-task",
      stations: {
        "station-a": {
          started_at: oldStartedAt,
          finished_at: oldFinishedAt,
          status: "done",
        },
      },
    };
    const doneFile = resolve(TMP, "queues", "done", "old.json");
    writeFileSync(doneFile, JSON.stringify(oldWorkpiece));

    const timings = getStationTimings(TMP, ["station-a"]);

    // Should use the processing file's started_at (Priority 1), not the done file
    expect(timings["station-a"].running).toBe(true);
    expect(timings["station-a"].started_at).toBe(startedAt);
    expect(timings["station-a"].finished_at).toBeUndefined();
  });
});
