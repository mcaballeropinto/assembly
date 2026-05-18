/**
 * Tests that callClaudeCode emits structured activity events for result
 * events and enriches the thrown error message when is_error is true.
 *
 * Uses the same fake-claude-on-PATH strategy as llm-fallback-content.test.ts:
 * the fake CLI consumes the stream-json stdin payload and emits a configurable
 * result event.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callLLM } from "../llm";
import type { LLMMessage } from "../types";

let tmpDir: string;
let savedPath: string | undefined;
let savedMode: string | undefined;

const FAKE_CLAUDE_SCRIPT = `#!/usr/bin/env bun
const mode = process.env.FAKE_CLAUDE_MODE;
let stdin = "";
for await (const chunk of Bun.stdin.stream()) {
  stdin += new TextDecoder().decode(chunk);
}
const line = stdin.split("\\n").find((l) => l.trim()) ?? "{}";
const msg = JSON.parse(line);
// System prompt is delivered via --append-system-prompt-file (stdin.system
// is dropped by claude-code). Read it off disk so the fake CLI can still
// locate the envelope path embedded in the fileInstruction block.
const argv = Bun.argv;
let systemFromFile = "";
const sysFlagIdx = argv.findIndex((a) => a === "--append-system-prompt-file" || a === "--system-prompt-file");
if (sysFlagIdx !== -1 && argv[sysFlagIdx + 1]) {
  try { systemFromFile = await Bun.file(argv[sysFlagIdx + 1]).text(); } catch {}
}
const allText = systemFromFile + "\\n" + (msg.system ?? "") + "\\n" + (msg.message?.content ?? "");
const fileMatch = allText.match(/\\/tmp\\/assembly-envelope-[\\w-]+\\.json/);
const outputFile = fileMatch ? fileMatch[0] : null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

if (mode === "error_max_turns") {
  emit({
    type: "result",
    is_error: true,
    subtype: "max_turns",
    num_turns: 50,
    stop_reason: "max_turns_exceeded",
    duration_ms: 12345,
    duration_api_ms: 10000,
    result: "The agent exhausted the turn budget before producing a final answer.",
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 },
    cost_usd: 0.42,
  });
} else if (mode === "error_no_subtype") {
  emit({
    type: "result",
    is_error: true,
    result: "opaque failure",
    usage: { input_tokens: 5, output_tokens: 0 },
    cost_usd: 0,
  });
} else if (mode === "error_result_non_string") {
  emit({
    type: "result",
    is_error: true,
    subtype: "refusal",
    num_turns: 3,
    result: { nested: "object" },
    usage: { input_tokens: 5, output_tokens: 0 },
    cost_usd: 0,
  });
} else if (mode === "ok") {
  if (outputFile) await Bun.write(outputFile, JSON.stringify({ summary: "ok", data: {} }));
  emit({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
  emit({
    type: "result",
    is_error: false,
    num_turns: 4,
    duration_ms: 2000,
    duration_api_ms: 1500,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost_usd: 0.05,
  });
}
`;

function installFakeClaude() {
  tmpDir = mkdtempSync(join(tmpdir(), "assembly-fake-claude-result-"));
  const binPath = join(tmpDir, "claude");
  writeFileSync(binPath, FAKE_CLAUDE_SCRIPT);
  chmodSync(binPath, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = tmpDir + ":" + (savedPath ?? "");
}

function setMode(mode: string) {
  savedMode = process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_MODE = mode;
}

beforeEach(() => {
  installFakeClaude();
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
  else process.env.FAKE_CLAUDE_MODE = savedMode;
  savedPath = undefined;
  savedMode = undefined;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const messages: LLMMessage[] = [
  { role: "system", content: "You are a test agent." },
  { role: "user", content: "Do something." },
];

type LogEntry = { event: string; detail: Record<string, unknown> };

describe("callClaudeCode result-event logging", () => {
  it("emits claude_result_error with full structured detail when is_error is true", async () => {
    setMode("error_max_turns");
    const logs: LogEntry[] = [];
    const logger = (event: string, detail: Record<string, unknown>) => {
      logs.push({ event, detail });
    };

    await expect(
      callLLM(messages, "sonnet", 4096, [], "claude-code", undefined, undefined, logger)
    ).rejects.toThrow();

    const errLogs = logs.filter((l) => l.event === "claude_result_error");
    expect(errLogs.length).toBe(1);
    const detail = errLogs[0].detail as any;
    expect(detail.subtype).toBe("max_turns");
    expect(detail.num_turns).toBe(50);
    expect(detail.stop_reason).toBe("max_turns_exceeded");
    expect(detail.duration_ms).toBe(12345);
    expect(detail.duration_api_ms).toBe(10000);
    expect(detail.cost_usd).toBe(0.42);
    expect(detail.model).toBe("sonnet");
    expect(detail.result).toContain("exhausted the turn budget");
    expect(detail.tokens.in).toBe(100 + 50 + 25);
    expect(detail.tokens.out).toBe(200);
    expect(detail.tokens.cache_read).toBe(50);
    expect(detail.tokens.cache_creation).toBe(25);
  });

  it("enriches the thrown error message with subtype and turn count", async () => {
    setMode("error_max_turns");
    let caught: Error | null = null;
    try {
      await callLLM(messages, "sonnet", 4096, [], "claude-code");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("max_turns");
    expect(caught!.message).toContain("turns=50");
    expect(caught!.message).toContain("stop=max_turns_exceeded");
  });

  it("falls back to result text when subtype is missing", async () => {
    setMode("error_no_subtype");
    let caught: Error | null = null;
    try {
      await callLLM(messages, "sonnet", 4096, [], "claude-code");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("opaque failure");
    expect(caught!.message).toContain("turns=?");
  });

  it("does not slice a non-string result; logs undefined instead", async () => {
    setMode("error_result_non_string");
    const logs: LogEntry[] = [];
    const logger = (event: string, detail: Record<string, unknown>) => {
      logs.push({ event, detail });
    };

    await expect(
      callLLM(messages, "sonnet", 4096, [], "claude-code", undefined, undefined, logger)
    ).rejects.toThrow();

    const errLog = logs.find((l) => l.event === "claude_result_error")!;
    expect((errLog.detail as any).result).toBeUndefined();
    expect((errLog.detail as any).subtype).toBe("refusal");
  });

  it("does not crash when logger is absent and is_error is true", async () => {
    setMode("error_max_turns");
    let caught: Error | null = null;
    try {
      await callLLM(messages, "sonnet", 4096, [], "claude-code");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("max_turns");
  });

  it("propagates the underlying error even when the logger itself throws", async () => {
    setMode("error_max_turns");
    const badLogger = () => {
      throw new Error("logger is broken");
    };

    let caught: Error | null = null;
    try {
      await callLLM(messages, "sonnet", 4096, [], "claude-code", undefined, undefined, badLogger);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("Claude Code error");
    expect(caught!.message).toContain("max_turns");
    expect(caught!.message).not.toContain("logger is broken");
  });

  it("emits claude_result_ok on successful result events", async () => {
    setMode("ok");
    const logs: LogEntry[] = [];
    const logger = (event: string, detail: Record<string, unknown>) => {
      logs.push({ event, detail });
    };

    const res = await callLLM(
      messages, "sonnet", 4096, [], "claude-code", undefined, undefined, logger
    );
    expect(res.content).toContain('"ok"');

    const okLogs = logs.filter((l) => l.event === "claude_result_ok");
    expect(okLogs.length).toBe(1);
    const detail = okLogs[0].detail as any;
    expect(detail.num_turns).toBe(4);
    expect(detail.duration_ms).toBe(2000);
    expect(detail.cost_usd).toBe(0.05);
    expect(detail.model).toBe("sonnet");
    expect(detail.tokens.in).toBe(10);
    expect(detail.tokens.out).toBe(20);
  });
});
