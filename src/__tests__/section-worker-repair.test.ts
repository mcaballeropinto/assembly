import { describe, it, expect } from "bun:test";
import { buildRepairPlan } from "../section-worker";
import type { LLMMessage } from "../types";

const originalMessages: LLMMessage[] = [
  { role: "system", content: "You are the validator station." },
  { role: "user", content: "Validate workpiece 42 and emit an envelope." },
];

describe("buildRepairPlan", () => {
  it("returns a four-message stack with system + original user + assistant seed + repair instruction", () => {
    const plan = buildRepairPlan(
      originalMessages,
      { content: '{"summary":broken', fallbackContent: undefined },
      "Invalid JSON"
    );
    expect(plan.messages).toHaveLength(4);
    expect(plan.messages[0]).toEqual(originalMessages[0]);
    expect(plan.messages[1]).toEqual(originalMessages[1]);
    expect(plan.messages[2].role).toBe("assistant");
    expect(plan.messages[2].content).toContain('{"summary":broken');
    expect(plan.messages[3].role).toBe("user");
    expect(plan.messages[3].content).toContain("Respond now with ONLY valid JSON");
  });

  it("seeds the assistant turn from response.content when present", () => {
    const plan = buildRepairPlan(
      originalMessages,
      { content: "raw-file-text", fallbackContent: "streamed-text" },
      "err"
    );
    expect(plan.seedSource).toBe("content");
    expect(plan.seedBytes).toBe("raw-file-text".length);
    expect(plan.messages[2].content).toBe("raw-file-text");
    expect(plan.messages[3].content).toContain("raw-file-text");
    expect(plan.messages[3].content).not.toContain("streamed-text");
  });

  it("falls back to response.fallbackContent when content is empty", () => {
    const plan = buildRepairPlan(
      originalMessages,
      { content: "", fallbackContent: "streamed prose" },
      "no file"
    );
    expect(plan.seedSource).toBe("fallback");
    expect(plan.seedBytes).toBe("streamed prose".length);
    expect(plan.messages[2].content).toBe("streamed prose");
    expect(plan.messages[3].content).toContain("streamed prose");
  });

  it("uses a placeholder assistant turn and 'no output' prompt when both sources are empty", () => {
    const plan = buildRepairPlan(
      originalMessages,
      { content: "", fallbackContent: "" },
      "session ended empty"
    );
    expect(plan.seedSource).toBe("none");
    expect(plan.seedBytes).toBe(0);
    expect(plan.messages[2].content).toBe("(no output captured)");
    expect(plan.messages[3].content).toContain("finished without producing the required JSON output");
  });

  it("always carries the original user task in the repair stack", () => {
    // Empty-file regression: prior repair dropped messages[1], leaving the
    // model with no idea what task to regenerate from.
    const plan = buildRepairPlan(
      originalMessages,
      { content: "", fallbackContent: undefined },
      "empty"
    );
    expect(plan.messages[1]).toEqual(originalMessages[1]);
  });

  it("handles missing fallbackContent on the response", () => {
    const plan = buildRepairPlan(
      originalMessages,
      { content: "", fallbackContent: undefined },
      "empty"
    );
    expect(plan.seedSource).toBe("none");
    expect(plan.messages).toHaveLength(4);
  });
});
