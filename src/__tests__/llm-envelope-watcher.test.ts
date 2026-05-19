/**
 * Tests the envelope file watcher path — station completion decoupled
 * from subprocess lifecycle. Proves the fix for claude-code #25629-class
 * hangs: the subprocess can hang after writing the envelope, but the
 * caller returns as soon as the file is valid JSON on disk.
 *
 * Strategy: a fake `claude` that writes the envelope file and then
 * intentionally hangs on stdout. Without the watcher, this test would
 * block forever; with it, the call returns and the subprocess is killed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callLLM, resolveAllowedTools } from "../llm";
import { parseEnvelope } from "../envelope";
import type { LLMMessage } from "../types";

let tmpDir: string;
let savedPath: string | undefined;

// Fake claude that writes to the envelope path it finds in the prompt,
// then hangs waiting on stdout (simulating the #25629 post-result hang).
const HANG_AFTER_WRITE = String.raw`#!/usr/bin/env bun
let stdin = "";
for await (const chunk of Bun.stdin.stream()) {
  stdin += new TextDecoder().decode(chunk);
}
const line = stdin.split("\n").find((l) => l.trim()) ?? "{}";
const msg = JSON.parse(line);
// System prompt is delivered via --append-system-prompt-file (stdin.system
// is silently dropped by claude-code). Read it off disk so the fake CLI can
// still find the envelope path embedded in the fileInstruction block.
const argv = Bun.argv;
let systemFromFile = "";
const sysFlagIdx = argv.findIndex((a) => a === "--append-system-prompt-file" || a === "--system-prompt-file");
if (sysFlagIdx !== -1 && argv[sysFlagIdx + 1]) {
  try { systemFromFile = await Bun.file(argv[sysFlagIdx + 1]).text(); } catch {}
}
const allText = systemFromFile + "\n" + (msg.system ?? "") + "\n" + (msg.message?.content ?? "");
// Match any absolute path ending in envelope.json — the watcher path
// lives in the run directory, not /tmp.
const fileMatch = allText.match(/\/[\w\-\/\.]+envelope\.json/);
const outputFile = fileMatch ? fileMatch[0] : null;

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

if (outputFile) {
  await Bun.write(outputFile, JSON.stringify({ summary: "hang-but-wrote", data: { ok: true } }));
}
emit({ type: "assistant", message: { content: [{ type: "text", text: "Wrote the envelope." }] } });
emit({ type: "result", usage: { input_tokens: 10, output_tokens: 20 }, cost_usd: 0.01 });
// Intentional hang: keep stdout open and block forever. Simulates the
// claude-code post-result hang. The watcher path should SIGKILL us.
await new Promise(() => {});
`;

function installFakeClaude() {
  tmpDir = mkdtempSync(join(tmpdir(), "assembly-fake-claude-watch-"));
  const binPath = join(tmpDir, "claude");
  writeFileSync(binPath, HANG_AFTER_WRITE);
  chmodSync(binPath, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = tmpDir + ":" + (savedPath ?? "");
}

beforeEach(() => {
  installFakeClaude();
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  savedPath = undefined;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const messages: LLMMessage[] = [
  { role: "system", content: "You are a test agent." },
  { role: "user", content: "Do something." },
];

describe("envelope watcher — subprocess hang tolerance", () => {
  it("returns as soon as envelope file is valid, even when claude hangs", async () => {
    const envelopePath = join(tmpDir, "run-1", "envelope.json");
    // Ensure parent dir exists so fake claude can write
    await Bun.write(envelopePath + ".init", ""); // just creates parents

    const started = Date.now();
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
    const elapsed = Date.now() - started;

    // Must return well before the natural process death (which never comes).
    // Watcher polls at 250ms + 500ms grace before SIGKILL + 10s drain budget.
    // Upper bound: ~12s. Anything near forever means the fix didn't land.
    expect(elapsed).toBeLessThan(15_000);

    expect(res.content).toContain("hang-but-wrote");
    const envelope = parseEnvelope(res.content);
    expect(envelope.summary).toBe("hang-but-wrote");
    expect((envelope.data as any)?.ok).toBe(true);
  });

  it("auto-injects Write + Bash into allowedTools when watcher is active", () => {
    // Station declared only WebSearch — watcher path needs Write and Bash
    // for the atomic write protocol, so we must auto-add them.
    // With an envelopePath, BOTH Write and Bash must be scoped to the
    // envelope path so a station that didn't ask for those tools doesn't
    // get unscoped versions back as side effects of the watcher protocol.
    const envelopePath = "/tmp/test-envelope.json";
    const minimal = resolveAllowedTools(["WebSearch"], true, envelopePath);
    expect(minimal).toContain("WebSearch");
    expect(minimal).toContain(`Write(${envelopePath}.tmp)`);
    expect(minimal).not.toContain("Write");
    expect(minimal).toContain(`Bash(mv ${envelopePath}.tmp ${envelopePath})`);
    expect(minimal).not.toContain("Bash");

    // Without envelopePath, fall back to unscoped Write + Bash (legacy
    // callers / tests that don't pass the path).
    const noScope = resolveAllowedTools(["WebSearch"], true);
    expect(noScope).toContain("Write");
    expect(noScope).toContain("Bash");

    // Without watcher: respect the station's declaration exactly
    const untouched = resolveAllowedTools(["WebSearch"], false);
    expect(untouched).toEqual(["WebSearch"]);

    // Already-present Write shouldn't duplicate AND keeps its unscoped form
    // (stations that explicitly declared Write keep what they declared).
    const alreadyHas = resolveAllowedTools(["Write", "Read"], true, envelopePath);
    expect(alreadyHas.filter((t) => t === "Write").length).toBe(1);
    expect(alreadyHas).not.toContain(`Write(${envelopePath}.tmp)`);
    // Bash wasn't declared, so it's still scoped.
    expect(alreadyHas).toContain(`Bash(mv ${envelopePath}.tmp ${envelopePath})`);

    // Scoped form like Bash(git status) should still count as having Bash
    // (bareToolName matches), so we don't double-inject the scoped mv form.
    const scoped = resolveAllowedTools(["Bash(git status)", "Read"], true, envelopePath);
    expect(scoped.filter((t) => t.startsWith("Bash")).length).toBe(1);
    expect(scoped).toContain(`Write(${envelopePath}.tmp)`);
  });

  it("deletes a stale envelope file before the call (loop/retry safety)", async () => {
    const envelopePath = join(tmpDir, "run-2", "envelope.json");
    // Pre-write a stale envelope from a "previous iteration"
    await Bun.write(envelopePath, JSON.stringify({ summary: "STALE", data: { iteration: 0 } }));
    expect(existsSync(envelopePath)).toBe(true);

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

    // Fresh run must win — stale content must be cleared and not returned.
    const envelope = parseEnvelope(res.content);
    expect(envelope.summary).toBe("hang-but-wrote");
    expect(envelope.summary).not.toBe("STALE");
  });
});
