import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { parseEvalResponse } from "../envelope";
import { escalateStation, createWorkpiece, writeStation } from "../workpiece";
import { initLineQueue, getLineQueueState } from "../queue";
import type { StationResult } from "../types";

const TEMP_DIR = resolve("/tmp", `assembly-test-escalation-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── parseEvalResponse() action field tests ───────────────────────────

describe("parseEvalResponse() action field", () => {
  test("extracts action: 'retry' from valid JSON", () => {
    const result = parseEvalResponse(
      JSON.stringify({
        pass: false,
        feedback: "Missing 2 companies",
        score: 55,
        action: "retry",
      })
    );
    expect(result.pass).toBe(false);
    expect(result.feedback).toBe("Missing 2 companies");
    expect(result.score).toBe(55);
    expect(result.action).toBe("retry");
  });

  test("extracts action: 'escalate' from valid JSON", () => {
    const result = parseEvalResponse(
      JSON.stringify({
        pass: false,
        feedback: "All URLs are invalid",
        score: 20,
        action: "escalate",
      })
    );
    expect(result.pass).toBe(false);
    expect(result.feedback).toBe("All URLs are invalid");
    expect(result.score).toBe(20);
    expect(result.action).toBe("escalate");
  });

  test("ignores invalid action values", () => {
    const result = parseEvalResponse(
      JSON.stringify({
        pass: false,
        feedback: "Some issue",
        action: "abort",
      })
    );
    expect(result.pass).toBe(false);
    expect(result.action).toBeUndefined();
  });

  test("returns undefined action when field is omitted", () => {
    const result = parseEvalResponse(
      JSON.stringify({
        pass: false,
        feedback: "Old-style eval without action",
        score: 50,
      })
    );
    expect(result.pass).toBe(false);
    expect(result.action).toBeUndefined();
  });

  test("ignores action when pass is true (action is present but not used)", () => {
    const result = parseEvalResponse(
      JSON.stringify({
        pass: true,
        feedback: "All good",
        score: 95,
        action: "retry",
      })
    );
    expect(result.pass).toBe(true);
    expect(result.action).toBe("retry"); // parsed but runner ignores it
  });
});

// ─── escalateStation() tests ────────────────────────────────────────

describe("escalateStation()", () => {
  test("creates workpiece with status 'escalated'", () => {
    const wp = createWorkpiece("test-line", "test task");
    const feedback = "All results are hallucinated";
    const result = escalateStation(wp, "discover", feedback, {
      model: "claude-sonnet-4-20250514",
      tokens: { in: 1000, out: 500 },
      cost_usd: 0.015,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
    });

    const station = result.stations["discover"];
    expect(station).toBeDefined();
    expect(station.status).toBe("escalated");
    expect(station.summary).toStartWith("Escalated:");
    expect(station.data?.escalation_reason).toBe(feedback);
    expect(station.model).toBe("claude-sonnet-4-20250514");
    expect(station.tokens).toEqual({ in: 1000, out: 500 });
    expect(station.cost_usd).toBe(0.015);
    expect(station.started_at).toBe("2026-01-01T00:00:00Z");
    expect(station.finished_at).toBe("2026-01-01T00:01:00Z");
  });

  test("preserves existing station results", () => {
    let wp = createWorkpiece("test-line", "test task");

    // First station completed successfully
    wp = writeStation(wp, "discover", { summary: "Found 5 companies" }, {
      model: "claude-sonnet-4-20250514",
      tokens: { in: 500, out: 200 },
      cost_usd: 0.008,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:30Z",
    });

    // Second station escalated
    wp = escalateStation(wp, "score", "Scoring is fundamentally broken", {
      model: "claude-sonnet-4-20250514",
      tokens: { in: 800, out: 300 },
      cost_usd: 0.012,
      started_at: "2026-01-01T00:01:00Z",
      finished_at: "2026-01-01T00:02:00Z",
    });

    // Original station still intact
    expect(wp.stations["discover"]).toBeDefined();
    expect(wp.stations["discover"].status).toBe("done");
    expect(wp.stations["discover"].summary).toBe("Found 5 companies");

    // Escalated station
    expect(wp.stations["score"]).toBeDefined();
    expect(wp.stations["score"].status).toBe("escalated");
  });

  test("truncates long feedback in summary to 200 chars", () => {
    const wp = createWorkpiece("test-line", "test task");
    const longFeedback = "x".repeat(300);
    const result = escalateStation(wp, "discover", longFeedback, {
      model: "script",
      tokens: { in: 0, out: 0 },
      cost_usd: 0,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z",
    });

    // Summary should be truncated (11 chars for "Escalated: " + 200 chars)
    expect(result.stations["discover"].summary.length).toBeLessThanOrEqual(211);
    // But full feedback should be in data
    expect((result.stations["discover"].data?.escalation_reason as string).length).toBe(300);
  });
});

// ─── Queue review directory tests ──────────────────────────────────

describe("review queue", () => {
  test("initLineQueue() creates a review directory", () => {
    const linePath = resolve(TEMP_DIR, `line-review-${Date.now()}`);
    mkdirSync(linePath, { recursive: true });

    const paths = initLineQueue(linePath);

    expect(paths.review).toBe(resolve(linePath, "queues", "review"));
    expect(existsSync(paths.review)).toBe(true);
  });

  test("getLineQueueState() returns review count", () => {
    const linePath = resolve(TEMP_DIR, `line-state-${Date.now()}`);
    mkdirSync(linePath, { recursive: true });

    initLineQueue(linePath);

    // Add a .json file to review queue
    writeFileSync(
      resolve(linePath, "queues", "review", "test-wp.json"),
      JSON.stringify({ id: "test", task: "test task", stations: {} })
    );

    const state = getLineQueueState(linePath);
    expect(state.inbox).toBe(0);
    expect(state.done).toBe(0);
    expect(state.error).toBe(0);
    expect(state.review).toBe(1);
  });

  test("getLineQueueState() returns review: 0 when no review items", () => {
    const linePath = resolve(TEMP_DIR, `line-empty-${Date.now()}`);
    mkdirSync(linePath, { recursive: true });

    initLineQueue(linePath);

    const state = getLineQueueState(linePath);
    expect(state.review).toBe(0);
  });
});

// ─── StationResult type check ──────────────────────────────────────

describe("StationResult type", () => {
  test("accepts 'escalated' status", () => {
    // TypeScript compilation check — if this compiles, the type is correct
    const result: StationResult = {
      status: "escalated",
      summary: "Escalated: test",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
      model: "claude-sonnet-4-20250514",
      tokens: { in: 0, out: 0 },
      cost_usd: 0,
    };
    expect(result.status).toBe("escalated");
  });
});
