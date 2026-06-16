/**
 * Tests the "salvage from assistant text blocks" fallback in callClaudeCode.
 *
 * Strategy: install a fake `claude` executable on PATH that consumes the
 * stream-json payload from stdin and emits a configurable mix of:
 *   - assistant text blocks on stdout
 *   - writes to the envelope output file
 * then exits with a synthetic `result` event carrying token usage.
 *
 * The mode is selected via the FAKE_CLAUDE_MODE env var read by the fake CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callLLM, CLAUDE_STREAM_TEXT_CAP } from "../llm";
import { parseEnvelope } from "../envelope";
import type { LLMMessage } from "../types";

let tmpDir: string;
let savedPath: string | undefined;
let savedMode: string | undefined;

const FAKE_CLAUDE_SCRIPT = `#!/usr/bin/env bun
// Fake claude CLI for llm-fallback-content tests.
const mode = process.env.FAKE_CLAUDE_MODE;
let stdin = "";
for await (const chunk of Bun.stdin.stream()) {
  stdin += new TextDecoder().decode(chunk);
}
const line = stdin.split("\\n").find((l) => l.trim()) ?? "{}";
const msg = JSON.parse(line);
// System prompt now travels via --append-system-prompt-file <path>, not the
// (silently-dropped) stdin \`system\` field. Read it from disk so the fake CLI
// can still locate the envelope path that the harness embedded in the
// fileInstruction block.
const argv = Bun.argv;
let systemFromFile = "";
const sysFlagIdx = argv.findIndex((a) => a === "--append-system-prompt-file" || a === "--system-prompt-file");
if (sysFlagIdx !== -1 && argv[sysFlagIdx + 1]) {
  try { systemFromFile = await Bun.file(argv[sysFlagIdx + 1]).text(); } catch {}
}
const allText = systemFromFile + "\\n" + (msg.system ?? "") + "\\n" + (msg.message?.content ?? "");
const fileMatch = allText.match(/\\/[\\w\\-\\/\\.]+(?:assembly-envelope-[\\w-]+\\.json|envelope\\.json)/);
const outputFile = fileMatch ? fileMatch[0] : null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

const fileEnvelope = { summary: "from file", data: { source: "file" } };
const streamEnvelope = { summary: "from stream", data: { source: "stream" } };

if (mode === "file_only") {
  if (outputFile) await Bun.write(outputFile, JSON.stringify(fileEnvelope));
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Envelope written to file." }] } });
} else if (mode === "file_and_stream") {
  if (outputFile) await Bun.write(outputFile, JSON.stringify(fileEnvelope));
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Preamble.\\n" + JSON.stringify(streamEnvelope) }] } });
} else if (mode === "stream_only") {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Here's the result:\\n" + JSON.stringify(streamEnvelope) }] } });
} else if (mode === "stream_only_prose") {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "I decided not to produce structured output today." }] } });
} else if (mode === "multi_block_stream") {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Thinking step 1..." }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Final: " + JSON.stringify(streamEnvelope) }] } });
} else if (mode === "malformed_file_and_incomplete_stream") {
  if (outputFile) {
    const malformed = '{"summary":"bad' + String.fromCharCode(92) + 'q"}';
    await Bun.write(outputFile, malformed);
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify({ summary: "Plan envelope written", data: { envelope_path: "x" } }) }] } });
}

emit({
  type: "result",
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  cost_usd: 0.01,
});
`;

function installFakeClaude() {
  tmpDir = mkdtempSync(join(tmpdir(), "assembly-fake-claude-"));
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

describe("callClaudeCode fallback content", () => {
  it("file-only: content comes from envelope file, fallbackContent holds prose", async () => {
    setMode("file_only");
    const res = await callLLM(messages, "sonnet", 4096, [], "claude-code");
    expect(res.content).toContain('"from file"');
    const envelope = parseEnvelope(res.content);
    expect(envelope.summary).toBe("from file");
    // Prose is still captured from stream but not used
    expect(res.fallbackContent).toBe("Envelope written to file.");
  });

  it("file-and-stream: file wins; fallbackContent is returned but ignored by parseEnvelope", async () => {
    setMode("file_and_stream");
    const res = await callLLM(messages, "sonnet", 4096, [], "claude-code");
    const envelope = parseEnvelope(res.content);
    expect(envelope.summary).toBe("from file");
    // Stream text is captured alongside — exercised by the salvage path,
    // but not used when content parses cleanly.
    expect(res.fallbackContent).toContain("Preamble.");
    expect(res.fallbackContent).toContain('"from stream"');
  });

  it("stream-only: content is empty, fallbackContent parses into an envelope", async () => {
    setMode("stream_only");
    const res = await callLLM(messages, "sonnet", 4096, [], "claude-code");
    expect(res.content).toBe("");
    expect(() => parseEnvelope(res.content)).toThrow();
    expect(res.fallbackContent).toBeDefined();
    const envelope = parseEnvelope(res.fallbackContent!);
    expect(envelope.summary).toBe("from stream");
    expect((envelope.data as any)?.source).toBe("stream");
  });

  it("stream-only prose (no JSON): fallbackContent is plain prose that fails to parse", async () => {
    setMode("stream_only_prose");
    const res = await callLLM(messages, "sonnet", 4096, [], "claude-code");
    expect(res.content).toBe("");
    expect(res.fallbackContent).toContain("I decided not to produce");
    expect(() => parseEnvelope(res.fallbackContent!)).toThrow();
  });

  it("multi-block stream: all text blocks concatenated, trailing JSON salvaged", async () => {
    setMode("multi_block_stream");
    const res = await callLLM(messages, "sonnet", 4096, [], "claude-code");
    expect(res.content).toBe("");
    expect(res.fallbackContent).toContain("Thinking step 1");
    expect(res.fallbackContent).toContain("Final:");
    const envelope = parseEnvelope(res.fallbackContent!);
    expect(envelope.summary).toBe("from stream");
  });

  it("malformed sidecar remains primary when fallback JSON omits content", async () => {
    setMode("malformed_file_and_incomplete_stream");
    const envelopePath = join(tmpDir, "run-malformed", "envelope.json");
    await Bun.write(envelopePath + ".init", "");

    const res = await callLLM(
      messages,
      "sonnet",
      4096,
      [],
      "claude-code",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envelopePath
    );

    expect(res.content).toBe('{"summary":"bad\\q"}');
    expect(res.fallbackContent).toContain("Plan envelope written");
    expect(res.envelopeFileError).toBeDefined();
    expect(res.envelopeFileError?.path).toBe(envelopePath);
    expect(res.envelopeFileError?.message.length).toBeGreaterThan(0);
    expect(res.envelopeFileError?.bytes).toBe(res.content.length);
    expect(res.envelopeFileError?.preview).toBe(res.content);

    const fallbackEnvelope = parseEnvelope(res.fallbackContent!);
    expect(fallbackEnvelope.summary).toBe("Plan envelope written");
    expect(fallbackEnvelope.content).toBeUndefined();
  });
});

describe("CLAUDE_STREAM_TEXT_CAP", () => {
  it("is 256 KB", () => {
    expect(CLAUDE_STREAM_TEXT_CAP).toBe(256 * 1024);
  });
});
