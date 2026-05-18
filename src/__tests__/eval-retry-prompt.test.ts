import { describe, it, expect } from "bun:test";
import {
  buildPrompt,
  buildEvalRetryPrompt,
  buildRetryWithFeedback,
} from "../prompt";
import type { StationConfig, Workpiece, StationResult } from "../types";

// === Test Helpers ===

function makeStation(prompt = "You are a helpful assistant."): StationConfig {
  return {
    name: "test-station",
    dir: "/tmp/test-station",
    prompt,
    memoryDir: "/tmp/test-station/memory",
  };
}

function makeStationResult(contentSizeKB: number): StationResult {
  const content = "x".repeat(contentSizeKB * 1024);
  return {
    status: "done",
    summary: "Completed station work",
    content,
    data: {
      key1: "a".repeat(1024),
      key2: "b".repeat(1024),
      nested: { deep: "c".repeat(1024) },
    },
    started_at: "2026-04-19T00:00:00Z",
    finished_at: "2026-04-19T00:01:00Z",
    model: "claude-sonnet-4-20250514",
    tokens: { in: 1000, out: 500 },
    cost_usd: 0.01,
  };
}

function makeWorkpiece(
  stationCount: number,
  contentSizeKB: number
): Workpiece {
  const stations: Record<string, StationResult> = {};
  for (let i = 0; i < stationCount; i++) {
    stations[`station-${i}`] = makeStationResult(contentSizeKB);
  }
  return {
    id: "test-workpiece-001",
    line: "test-line",
    task: "Implement the feature described in the plan",
    input: {
      url: "https://example.com",
      description: "A test input with some data",
    },
    stations,
  };
}

// Helper: sum character lengths of user messages (non-system)
function userMessageChars(messages: { role: string; content: string }[]): number {
  return messages
    .filter((m) => m.role === "user")
    .reduce((sum, m) => sum + m.content.length, 0);
}

// === Tests ===

describe("buildEvalRetryPrompt", () => {
  it("retry user-message tokens < 10% of original attempt", () => {
    const station = makeStation();
    // 3 stations with ~30KB content each = ~90KB+ of prior-station content
    const workpiece = makeWorkpiece(3, 30);
    const previousResponse = '{"summary":"did stuff","content":"short"}';
    const feedback = "Output was missing required data fields.";

    const original = buildPrompt(station, workpiece, "full");
    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      previousResponse,
      feedback
    );

    const originalChars = userMessageChars(original);
    const retryChars = userMessageChars(retry);

    expect(retryChars).toBeLessThan(originalChars * 0.1);
  });

  it("includes task and input in retry", () => {
    const station = makeStation();
    const workpiece = makeWorkpiece(1, 10);
    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      "previous output",
      "fix it"
    );

    const recapContent = retry[1].content;
    expect(recapContent).toContain(workpiece.task);
    expect(recapContent).toContain("https://example.com");
    expect(recapContent).toContain("A test input with some data");
  });

  it("includes previous response verbatim when under 4KB", () => {
    const station = makeStation();
    const workpiece = makeWorkpiece(0, 0);
    const smallResponse = '{"summary":"I did the thing","content":"Here is my 1KB output: ' + "z".repeat(900) + '"}';

    expect(smallResponse.length).toBeLessThan(4096);

    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      smallResponse,
      "needs improvement"
    );

    expect(retry[1].content).toContain(smallResponse);
  });

  it("truncates previous response over 4KB with valid JSON", () => {
    const station = makeStation();
    const workpiece = makeWorkpiece(0, 0);
    const longContent = "A".repeat(8000);
    const largeResponse = JSON.stringify({
      summary: "Implemented the feature",
      content: longContent,
      data: { branch_name: "feature-branch", files_changed: ["a.ts", "b.ts"] },
    });

    expect(largeResponse.length).toBeGreaterThan(4096);

    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      largeResponse,
      "missing tests"
    );

    const recapContent = retry[1].content;
    // Should contain the summary
    expect(recapContent).toContain("Implemented the feature");
    // Should contain data fields
    expect(recapContent).toContain("feature-branch");
    // Should contain truncation marker
    expect(recapContent).toContain("[truncated]");
    // Total recap should be much shorter than the original response
    expect(recapContent.length).toBeLessThan(largeResponse.length);
  });

  it("truncates non-JSON previous response over 4KB", () => {
    const station = makeStation();
    const workpiece = makeWorkpiece(0, 0);
    const plainTextResponse = "This is not JSON. ".repeat(500); // ~9KB

    expect(plainTextResponse.length).toBeGreaterThan(4096);

    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      plainTextResponse,
      "invalid format"
    );

    const recapContent = retry[1].content;
    // Should contain first part of the string
    expect(recapContent).toContain("This is not JSON.");
    // Should contain truncation marker
    expect(recapContent).toContain("... [truncated]");
    // Should not contain the full response
    expect(recapContent.length).toBeLessThan(plainTextResponse.length);
  });

  it("includes eval feedback in third message", () => {
    const station = makeStation();
    const workpiece = makeWorkpiece(0, 0);
    const feedbackText = "The output is missing required 'branch_name' in data.";

    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      "previous output",
      feedbackText
    );

    expect(retry).toHaveLength(3);
    expect(retry[2].role).toBe("user");
    expect(retry[2].content).toContain(feedbackText);
    expect(retry[2].content).toContain("Evaluation Feedback");
  });

  it("system prompt is identical to buildPrompt system prompt", () => {
    const station = makeStation(
      "You are a senior developer. Follow the plan carefully."
    );
    const workpiece = makeWorkpiece(2, 10);

    const original = buildPrompt(station, workpiece, "full");
    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      "prev response",
      "feedback"
    );

    expect(retry[0].content).toBe(original[0].content);
    expect(retry[0].role).toBe("system");
  });

  it("works with empty workpiece (no prior stations)", () => {
    const station = makeStation();
    const workpiece: Workpiece = {
      id: "empty-001",
      line: "test-line",
      task: "Do something",
      input: {},
      stations: {},
    };

    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      "prev output",
      "try again"
    );

    expect(retry).toHaveLength(3);
    expect(retry[0].role).toBe("system");
    expect(retry[1].role).toBe("user");
    expect(retry[2].role).toBe("user");
    expect(retry[1].content).toContain("Do something");
  });

  it("buildRetryWithFeedback still exists (backward compat)", () => {
    expect(typeof buildRetryWithFeedback).toBe("function");

    // Verify it still works
    const station = makeStation();
    const workpiece = makeWorkpiece(1, 1);
    const result = buildRetryWithFeedback(
      station,
      workpiece,
      "full",
      "some feedback"
    );
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("some feedback");
  });

  it("system prompt includes memory when station has memory", () => {
    const station = makeStation();
    station.memory = "# Memory\nRemember to always check edge cases.";

    const workpiece = makeWorkpiece(0, 0);

    const original = buildPrompt(station, workpiece, "full");
    const retry = buildEvalRetryPrompt(
      station,
      workpiece,
      "prev",
      "feedback"
    );

    // Both should include memory content
    expect(original[0].content).toContain("edge cases");
    expect(retry[0].content).toContain("edge cases");
    // And they should be identical
    expect(retry[0].content).toBe(original[0].content);
  });
});
