import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { reconstructMessages, buildNudgePrompt, nudgeForEnvelope } from "../envelope-nudge";
import type { StationConfig } from "../types";

const fixtureSessionLog = resolve(__dirname, "fixtures/sample-session.jsonl");

// ─── reconstructMessages ─────────────────────────────────────────────

describe("reconstructMessages", () => {
  it("reconstructs system + user + assistant text turns from session log", () => {
    const messages = reconstructMessages(fixtureSessionLog);

    // Should have: system, user, assistant (text only), assistant (text only), assistant (text only)
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("plan station");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("dark mode");
  });

  it("drops tool_use and tool_result blocks, keeps only text", () => {
    const messages = reconstructMessages(fixtureSessionLog);
    const allContent = messages.map((m) => m.content).join(" ");
    // Tool use input shouldn't appear as a message
    expect(allContent).not.toContain("tool_use_id");
    // But text blocks from assistant turns should
    expect(allContent).toContain("analyze the codebase");
  });

  it("skips assembly_meta and result entries", () => {
    const messages = reconstructMessages(fixtureSessionLog);
    const allContent = messages.map((m) => m.content).join(" ");
    expect(allContent).not.toContain("assembly_meta");
    expect(allContent).not.toContain("input_tokens");
  });

  it("returns empty array for non-existent file", () => {
    // reconstructMessages is called in a try block, so we verify the error
    expect(() => reconstructMessages("/nonexistent/path.jsonl")).toThrow();
  });

  it("captures the system prompt from the first user envelope", () => {
    const messages = reconstructMessages(fixtureSessionLog);
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are the plan station. Respond with JSON.",
    });
  });
});

// ─── buildNudgePrompt ────────────────────────────────────────────────

describe("buildNudgePrompt", () => {
  const stationWithGuardrails: StationConfig = {
    name: "plan",
    dir: "/tmp/plan",
    prompt: "Plan station prompt",
    memoryDir: "/tmp/plan/memory",
    guardrails: {
      output: {
        required: ["summary", "content", "data", "data.branch_name", "data.problem_statement", "data.files_to_change"],
        schema: {
          data: {
            branch_name: "string",
            problem_statement: "string",
            files_to_change: { type: "object" },
            estimated_complexity: "string",
          },
        },
      },
    },
  };

  it("includes the error message", () => {
    const prompt = buildNudgePrompt(stationWithGuardrails, "Response is not valid JSON");
    expect(prompt).toContain("Response is not valid JSON");
  });

  it("lists all data schema fields in the prompt", () => {
    const prompt = buildNudgePrompt(stationWithGuardrails, "parse error");
    expect(prompt).toContain('"branch_name"');
    expect(prompt).toContain('"problem_statement"');
    expect(prompt).toContain('"files_to_change"');
    expect(prompt).toContain('"estimated_complexity"');
  });

  it("includes required data fields line", () => {
    const prompt = buildNudgePrompt(stationWithGuardrails, "parse error");
    expect(prompt).toContain("Required data fields: branch_name, problem_statement, files_to_change");
  });

  it("handles station with no guardrails gracefully", () => {
    const bare: StationConfig = {
      name: "bare",
      dir: "/tmp/bare",
      prompt: "Bare prompt",
      memoryDir: "/tmp/bare/memory",
    };
    const prompt = buildNudgePrompt(bare, "parse error");
    expect(prompt).toContain("parse error");
    expect(prompt).toContain('"summary"');
    expect(prompt).not.toContain("Required data fields:");
  });

  it("instructs no prose, no fences, no tools", () => {
    const prompt = buildNudgePrompt(stationWithGuardrails, "err");
    expect(prompt).toContain("no prose");
    expect(prompt).toContain("no fences");
    expect(prompt).toContain("no tools");
  });
});

// ─── nudgeForEnvelope (integration-style with mock client) ───────────

describe("nudgeForEnvelope", () => {
  const station: StationConfig = {
    name: "plan",
    dir: "/tmp/plan",
    prompt: "Plan station prompt",
    memoryDir: "/tmp/plan/memory",
    guardrails: {
      output: {
        required: ["summary", "content", "data.branch_name"],
        schema: { data: { branch_name: "string" } },
      },
    },
  };

  function makeFakeClient(responseText: string) {
    return {
      messages: {
        stream: (_body: any) => ({
          finalMessage: async () => ({
            content: [{ type: "text", text: responseText }],
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 0,
            },
          }),
        }),
      },
    } as any;
  }

  it("returns LLMResult with valid JSON when nudge succeeds", async () => {
    const validJson = JSON.stringify({
      summary: "Add dark mode to dashboard",
      content: "## Plan\n\n1. Add CSS vars",
      data: { branch_name: "feat/dark-mode" },
    });
    const client = makeFakeClient(validJson);

    const result = await nudgeForEnvelope({
      sessionLogPath: fixtureSessionLog,
      station,
      errorMessage: "not valid JSON",
      model: "sonnet",
      client,
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe(validJson);
    expect(result!.tokens.in).toBe(250); // 200 + 50 cache_read
    expect(result!.tokens.out).toBe(100);
  });

  it("returns null when session log has insufficient history", async () => {
    // Create a minimal session log with only meta entries
    const { writeFileSync, unlinkSync } = await import("fs");
    const tmpPath = "/tmp/test-sparse-session.jsonl";
    writeFileSync(tmpPath, '{"type":"assembly_meta","phase":"start"}\n');

    const result = await nudgeForEnvelope({
      sessionLogPath: tmpPath,
      station,
      errorMessage: "parse error",
      model: "sonnet",
      client: makeFakeClient("{}"),
    });

    expect(result).toBeNull();
    try { unlinkSync(tmpPath); } catch {}
  });

  it("returns null when session log does not exist", async () => {
    const result = await nudgeForEnvelope({
      sessionLogPath: "/nonexistent/session.jsonl",
      station,
      errorMessage: "parse error",
      model: "sonnet",
      client: makeFakeClient("{}"),
    });

    expect(result).toBeNull();
  });

  it("appends nudge prompt as final user message to the reconstructed history", async () => {
    let capturedBody: any;
    const client = {
      messages: {
        stream: (body: any) => {
          capturedBody = body;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: '{"summary":"ok"}' }],
              usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }),
          };
        },
      },
    } as any;

    await nudgeForEnvelope({
      sessionLogPath: fixtureSessionLog,
      station,
      errorMessage: "not valid JSON",
      model: "sonnet",
      client,
    });

    // Last message should be the nudge prompt (user role)
    const msgs = capturedBody.messages;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("Respond now with ONLY valid JSON");
    expect(lastMsg.content).toContain("branch_name");
  });

  it("uses the station model, not Haiku", async () => {
    let capturedBody: any;
    const client = {
      messages: {
        stream: (body: any) => {
          capturedBody = body;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: '{"summary":"ok"}' }],
              usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }),
          };
        },
      },
    } as any;

    await nudgeForEnvelope({
      sessionLogPath: fixtureSessionLog,
      station,
      errorMessage: "err",
      model: "claude-sonnet-4-5-20250929",
      client,
    });

    expect(capturedBody.model).toBe("claude-sonnet-4-5-20250929");
  });
});
