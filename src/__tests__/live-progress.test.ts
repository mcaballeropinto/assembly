import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { summarizeToolUse, extractToolInput } from "../llm";
import { writeProgress } from "../section-worker";

const TMP = "/tmp/assembly-test-progress-" + Date.now();

describe("summarizeToolUse", () => {
  it("returns 'Reading <path>' for Read tool", () => {
    expect(summarizeToolUse("Read", { file_path: "src/types.ts" })).toBe("Reading src/types.ts");
  });

  it("returns 'Editing <path>' for Edit tool", () => {
    expect(summarizeToolUse("Edit", { file_path: "src/llm.ts" })).toBe("Editing src/llm.ts");
  });

  it("returns 'Writing <path>' for Write tool", () => {
    expect(summarizeToolUse("Write", { file_path: "out.json" })).toBe("Writing out.json");
  });

  it("returns 'Running: <cmd>' for Bash tool", () => {
    expect(summarizeToolUse("Bash", { command: "bun test" })).toBe("Running: bun test");
  });

  it("returns search string for Grep tool", () => {
    expect(summarizeToolUse("Grep", { pattern: "TODO" })).toBe('Searching for "TODO"');
  });

  it("returns pattern for Glob tool", () => {
    expect(summarizeToolUse("Glob", { pattern: "**/*.ts" })).toBe("Finding files: **/*.ts");
  });

  it("returns URL for WebFetch tool", () => {
    expect(summarizeToolUse("WebFetch", { url: "https://example.com" })).toBe("Fetching https://example.com");
  });

  it("returns query for WebSearch tool", () => {
    expect(summarizeToolUse("WebSearch", { query: "bun runtime" })).toBe("Searching: bun runtime");
  });

  it("returns tool name for unknown tools", () => {
    expect(summarizeToolUse("CustomTool", { foo: "bar" })).toBe("CustomTool");
  });

  it("handles null/undefined input gracefully", () => {
    expect(summarizeToolUse("Read", null)).toBe("Reading file");
    expect(summarizeToolUse("Read", undefined)).toBe("Reading file");
    expect(summarizeToolUse("Bash", {})).toBe("Running: ");
  });
});

describe("extractToolInput", () => {
  it("returns file_path for Read/Edit/Write", () => {
    expect(extractToolInput("Read", { file_path: "/tmp/foo.ts" })).toBe("/tmp/foo.ts");
    expect(extractToolInput("Edit", { file_path: "/tmp/bar.ts" })).toBe("/tmp/bar.ts");
    expect(extractToolInput("Write", { file_path: "/tmp/baz.ts" })).toBe("/tmp/baz.ts");
  });

  it("returns command for Bash", () => {
    expect(extractToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("returns pattern for Grep/Glob", () => {
    expect(extractToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(extractToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("returns url for WebFetch", () => {
    expect(extractToolInput("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("returns query for WebSearch", () => {
    expect(extractToolInput("WebSearch", { query: "bun test" })).toBe("bun test");
  });

  it("returns JSON string for unknown tools", () => {
    const result = extractToolInput("Unknown", { key: "val" });
    expect(result).toContain("key");
  });
});

describe("writeProgress", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("appends a valid JSONL line with correct fields", () => {
    const progressPath = resolve(TMP, "test.progress.jsonl");
    const ref = { ms: Date.now() };
    const startMs = Date.now() - 5000;
    writeProgress(progressPath, startMs, ref, "llm", "started", "Starting LLM");

    const content = readFileSync(progressPath, "utf-8").trim();
    const event = JSON.parse(content);
    expect(event.ts).toBeDefined();
    expect(event.phase).toBe("llm");
    expect(event.status).toBe("started");
    expect(event.detail).toBe("Starting LLM");
    expect(event.elapsed_s).toBeGreaterThanOrEqual(4);
  });

  it("writes multiple lines for multiple calls", () => {
    const progressPath = resolve(TMP, "multi.progress.jsonl");
    const ref = { ms: Date.now() };
    const startMs = Date.now();
    writeProgress(progressPath, startMs, ref, "prompt", "started", "Building prompt");
    writeProgress(progressPath, startMs, ref, "prompt", "done", "Prompt built");
    writeProgress(progressPath, startMs, ref, "llm", "started", "claude-code");

    const lines = readFileSync(progressPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeDefined();
      expect(parsed.phase).toBeDefined();
    }
  });

  it("updates lastActivityRef.ms to current time", () => {
    const progressPath = resolve(TMP, "ref.progress.jsonl");
    const ref = { ms: Date.now() - 60000 };
    const before = Date.now();
    writeProgress(progressPath, Date.now(), ref, "llm", "running", "test");
    expect(ref.ms).toBeGreaterThanOrEqual(before);
  });

  it("includes extra fields when provided", () => {
    const progressPath = resolve(TMP, "extra.progress.jsonl");
    const ref = { ms: Date.now() };
    writeProgress(progressPath, Date.now(), ref, "llm", "running", "tool call", {
      tool: "Read",
      tool_input: "src/types.ts",
      tokens: { in: 100, out: 200 },
      turns: 3,
    });

    const content = readFileSync(progressPath, "utf-8").trim();
    const event = JSON.parse(content);
    expect(event.tool).toBe("Read");
    expect(event.tool_input).toBe("src/types.ts");
    expect(event.tokens).toEqual({ in: 100, out: 200 });
    expect(event.turns).toBe(3);
  });
});

describe("progress file lifecycle", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("file can be deleted on completion", () => {
    const progressPath = resolve(TMP, "lifecycle.progress.jsonl");
    const ref = { ms: Date.now() };
    writeProgress(progressPath, Date.now(), ref, "llm", "done", "Complete");
    expect(existsSync(progressPath)).toBe(true);
    rmSync(progressPath);
    expect(existsSync(progressPath)).toBe(false);
  });
});
