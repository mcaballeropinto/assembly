import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { computeRoundsFromProgress } from "../tool-rounds";

const TMP = resolve("/tmp", `assembly-tool-rounds-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function writeProgress(name: string, lines: unknown[]): string {
  const path = resolve(TMP, name);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}

describe("computeRoundsFromProgress", () => {
  test("rolls up tool counts and takes max turns", () => {
    const path = writeProgress("a.jsonl", [
      { phase: "prompt", status: "started" },
      { phase: "prompt", status: "done" },
      { phase: "llm", status: "started" },
      { phase: "llm", status: "running", tool: "Read", turns: 1 },
      { phase: "llm", status: "running", tool: "Read", turns: 1 },
      { phase: "llm", status: "running", tool: "Bash", turns: 2 },
      { phase: "llm", status: "running", tool: "Read", turns: 3 },
      { phase: "llm", status: "running", tool: "Grep", turns: 3 },
      { phase: "llm", status: "done", tokens: { in: 100, out: 50 } },
    ]);

    const rounds = computeRoundsFromProgress(path);
    expect(rounds).toEqual({
      turns: 3,
      tools: { Read: 3, Bash: 1, Grep: 1 },
    });
  });

  test("returns null when file is missing", () => {
    expect(computeRoundsFromProgress(resolve(TMP, "missing.jsonl"))).toBeNull();
  });

  test("returns null for empty file", () => {
    const path = resolve(TMP, "empty.jsonl");
    writeFileSync(path, "");
    expect(computeRoundsFromProgress(path)).toBeNull();
  });

  test("returns null when only non-tool events present", () => {
    const path = writeProgress("nontools.jsonl", [
      { phase: "prompt", status: "started" },
      { phase: "prompt", status: "done" },
      { phase: "llm", status: "started" },
      { phase: "llm", status: "done", tokens: { in: 100, out: 50 } },
    ]);
    expect(computeRoundsFromProgress(path)).toBeNull();
  });

  test("skips malformed JSON lines silently", () => {
    const path = writeProgress("mixed.jsonl", [
      { phase: "llm", status: "running", tool: "Read", turns: 1 },
      "{not json",
      "",
      { phase: "llm", status: "running", tool: "Bash", turns: 2 },
      "garbage",
    ]);
    const rounds = computeRoundsFromProgress(path);
    expect(rounds).toEqual({ turns: 2, tools: { Read: 1, Bash: 1 } });
  });

  test("ignores tool field when not a string", () => {
    const path = writeProgress("bad.jsonl", [
      { phase: "llm", status: "running", tool: 42, turns: 1 },
      { phase: "llm", status: "running", tool: "", turns: 1 },
      { phase: "llm", status: "running", tool: "Read", turns: 2 },
    ]);
    const rounds = computeRoundsFromProgress(path);
    expect(rounds).toEqual({ turns: 2, tools: { Read: 1 } });
  });

  test("returns turns only when tools absent but turns recorded", () => {
    const path = writeProgress("turns-only.jsonl", [
      { phase: "llm", status: "running", turns: 5 },
    ]);
    const rounds = computeRoundsFromProgress(path);
    expect(rounds).toEqual({ turns: 5, tools: {} });
  });
});
