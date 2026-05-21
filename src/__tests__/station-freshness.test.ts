import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { resolve } from "path";
import { computeStationFreshness } from "../dashboard-data";

const TMP = "/tmp/assembly-test-freshness-" + Date.now();

describe("computeStationFreshness", () => {
  beforeEach(() => {
    mkdirSync(resolve(TMP, "queues"), { recursive: true });
    mkdirSync(resolve(TMP, "stations", "station-a"), { recursive: true });
    mkdirSync(resolve(TMP, "stations", "station-b"), { recursive: true });
    mkdirSync(resolve(TMP, "stations", "station-c"), { recursive: true });

    // Create line.yaml
    const lineYaml = `name: test-line
sequence:
  - station-a
  - station-b
  - station-c
`;
    writeFileSync(resolve(TMP, "line.yaml"), lineYaml);
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("fresh station — heartbeat within 2x poll interval", () => {
    const now = Date.now();
    const recentTs = new Date(now - 30_000).toISOString(); // 30s ago

    // Write a recent heartbeat
    const activity = { ts: recentTs, event: "station_heartbeat", station: "station-a" };
    appendFileSync(resolve(TMP, "queues", "activity.jsonl"), JSON.stringify(activity) + "\n");

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 1, output: 0 } };
    const stationTimings = { "station-a": { started_at: recentTs, running: true } };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("fresh");
    expect(freshness["station-a"].icon).toBe("✓");
    expect(freshness["station-a"].label).toContain("Updated");
  });

  it("stale station — heartbeat between 2x and 5x poll interval", () => {
    const now = Date.now();
    const staleTs = new Date(now - 90_000).toISOString(); // 90s ago (between 60s and 150s)

    const activity = { ts: staleTs, event: "station_heartbeat", station: "station-a" };
    appendFileSync(resolve(TMP, "queues", "activity.jsonl"), JSON.stringify(activity) + "\n");

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 1, processing: 0, output: 0 } };
    const stationTimings = { "station-a": { started_at: staleTs } };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("stale");
    expect(freshness["station-a"].icon).toBe("⏱");
    expect(freshness["station-a"].label).toContain("Stale");
  });

  it("disconnected station — heartbeat older than 5x poll interval", () => {
    const now = Date.now();
    const oldTs = new Date(now - 200_000).toISOString(); // 200s ago (> 150s)

    const activity = { ts: oldTs, event: "station_heartbeat", station: "station-a" };
    appendFileSync(resolve(TMP, "queues", "activity.jsonl"), JSON.stringify(activity) + "\n");

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 1, processing: 0, output: 0 } };
    const stationTimings = { "station-a": { started_at: oldTs } };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("disconnected");
    expect(freshness["station-a"].icon).toBe("✕");
    expect(freshness["station-a"].label).toContain("Disconnected");
  });

  it("completed station — has finished_at and no active work", () => {
    const now = Date.now();
    const finishedTs = new Date(now - 180_000).toISOString(); // 3 minutes ago

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 0, output: 0 } };
    const stationTimings = {
      "station-a": { started_at: finishedTs, finished_at: finishedTs, running: false },
    };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("completed");
    expect(freshness["station-a"].icon).toBe("—");
    expect(freshness["station-a"].label).toContain("Completed");
  });

  it("completed station NOT flagged stale even if heartbeat is old", () => {
    const now = Date.now();
    const oldTs = new Date(now - 300_000).toISOString(); // 5 minutes ago
    const finishedTs = new Date(now - 120_000).toISOString(); // 2 minutes ago

    // Old heartbeat
    const activity = { ts: oldTs, event: "station_heartbeat", station: "station-a" };
    appendFileSync(resolve(TMP, "queues", "activity.jsonl"), JSON.stringify(activity) + "\n");

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 0, output: 0 } };
    const stationTimings = {
      "station-a": { started_at: oldTs, finished_at: finishedTs, running: false },
    };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("completed");
    expect(freshness["station-a"].icon).toBe("—");
  });

  it("no heartbeat data and no activity — idle station", () => {
    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 0, output: 0 } };
    const stationTimings = {}; // No timing data

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("completed");
    expect(freshness["station-a"].label).toBe("Idle");
  });

  it("no heartbeat but actively processing — benefit of the doubt", () => {
    const now = Date.now();
    const startedTs = new Date(now - 5_000).toISOString(); // just started

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 1, output: 0 } };
    const stationTimings = { "station-a": { started_at: startedTs, running: true } };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("fresh");
    expect(freshness["station-a"].label).toBe("Starting");
  });

  it("multiple stations — independent freshness classification", () => {
    const now = Date.now();
    const freshTs = new Date(now - 30_000).toISOString();
    const staleTs = new Date(now - 90_000).toISOString();
    const disconnectedTs = new Date(now - 200_000).toISOString();

    // Station A — fresh
    appendFileSync(
      resolve(TMP, "queues", "activity.jsonl"),
      JSON.stringify({ ts: freshTs, event: "station_heartbeat", station: "station-a" }) + "\n"
    );

    // Station B — stale
    appendFileSync(
      resolve(TMP, "queues", "activity.jsonl"),
      JSON.stringify({ ts: staleTs, event: "station_heartbeat", station: "station-b" }) + "\n"
    );

    // Station C — disconnected
    appendFileSync(
      resolve(TMP, "queues", "activity.jsonl"),
      JSON.stringify({ ts: disconnectedTs, event: "station_heartbeat", station: "station-c" }) + "\n"
    );

    const sequence = ["station-a", "station-b", "station-c"];
    const sections = {
      "station-a": { inbox: 0, processing: 1, output: 0 },
      "station-b": { inbox: 1, processing: 0, output: 0 },
      "station-c": { inbox: 1, processing: 0, output: 0 },
    };
    const stationTimings = {
      "station-a": { started_at: freshTs, running: true },
      "station-b": { started_at: staleTs },
      "station-c": { started_at: disconnectedTs },
    };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    expect(freshness["station-a"].state).toBe("fresh");
    expect(freshness["station-b"].state).toBe("stale");
    expect(freshness["station-c"].state).toBe("disconnected");
  });

  it("station_done event counts as valid freshness signal", () => {
    const now = Date.now();
    const doneTs = new Date(now - 20_000).toISOString(); // 20s ago

    const activity = { ts: doneTs, event: "station_done", station: "station-a" };
    appendFileSync(resolve(TMP, "queues", "activity.jsonl"), JSON.stringify(activity) + "\n");

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 0, output: 0 } };
    const stationTimings = { "station-a": { started_at: doneTs, finished_at: doneTs } };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    // Should be completed since it has finished_at and no processing
    expect(freshness["station-a"].state).toBe("completed");
  });

  it("latest heartbeat per station is used when multiple exist", () => {
    const now = Date.now();
    const oldTs = new Date(now - 200_000).toISOString();
    const recentTs = new Date(now - 20_000).toISOString();

    // Write old heartbeat first
    appendFileSync(
      resolve(TMP, "queues", "activity.jsonl"),
      JSON.stringify({ ts: oldTs, event: "station_heartbeat", station: "station-a" }) + "\n"
    );

    // Write recent heartbeat
    appendFileSync(
      resolve(TMP, "queues", "activity.jsonl"),
      JSON.stringify({ ts: recentTs, event: "station_heartbeat", station: "station-a" }) + "\n"
    );

    const sequence = ["station-a"];
    const sections = { "station-a": { inbox: 0, processing: 1, output: 0 } };
    const stationTimings = { "station-a": { started_at: recentTs, running: true } };

    const freshness = computeStationFreshness(TMP, sequence, sections, stationTimings);

    // Should use the recent heartbeat, not the old one
    expect(freshness["station-a"].state).toBe("fresh");
    expect(freshness["station-a"].last_updated_at).toBe(recentTs);
  });
});
