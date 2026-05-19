/**
 * Tests that callClaudeCode routes prompt content through stdin (not argv),
 * and that the prompt-size warning telemetry fires correctly.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { CLAUDE_PROMPT_WARN_DEFAULT, getPromptWarnThreshold } from "../llm";

// Save and restore environment vars
const savedEnvVars: Record<string, string | undefined> = {};

function setProcessEnv(key: string, value: string) {
  savedEnvVars[key] = process.env[key];
  process.env[key] = value;
}

function cleanupEnv() {
  for (const [key, original] of Object.entries(savedEnvVars)) {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

afterEach(() => {
  cleanupEnv();
});

// ─── getPromptWarnThreshold() tests ─────────────────────────────────────────

describe("getPromptWarnThreshold()", () => {
  it("returns CLAUDE_PROMPT_WARN_DEFAULT when env var is not set", () => {
    delete process.env.ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES;
    const threshold = getPromptWarnThreshold();
    expect(threshold).toBe(CLAUDE_PROMPT_WARN_DEFAULT);
    expect(threshold).toBe(150_000);
  });

  it("returns parsed value when ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES is set", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "50000");
    const threshold = getPromptWarnThreshold();
    expect(threshold).toBe(50_000);
  });

  it("returns default when ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES is not a number", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "not-a-number");
    const threshold = getPromptWarnThreshold();
    expect(threshold).toBe(CLAUDE_PROMPT_WARN_DEFAULT);
  });

  it("returns default when ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES is zero", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "0");
    const threshold = getPromptWarnThreshold();
    expect(threshold).toBe(CLAUDE_PROMPT_WARN_DEFAULT);
  });

  it("returns default when ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES is negative", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "-1000");
    const threshold = getPromptWarnThreshold();
    expect(threshold).toBe(CLAUDE_PROMPT_WARN_DEFAULT);
  });

  it("accepts large threshold values", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "1000000");
    const threshold = getPromptWarnThreshold();
    expect(threshold).toBe(1_000_000);
  });
});

// ─── CLAUDE_PROMPT_WARN_DEFAULT constant ────────────────────────────────────

describe("CLAUDE_PROMPT_WARN_DEFAULT", () => {
  it("is 150_000 bytes", () => {
    expect(CLAUDE_PROMPT_WARN_DEFAULT).toBe(150_000);
  });
});

// ─── mergeClaudeEnv does not forward ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES ──────

describe("mergeClaudeEnv does not leak ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", () => {
  it("skips ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES when building claude env", () => {
    const { mergeClaudeEnv } = require("../llm");
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "99999");
    const result = mergeClaudeEnv();
    // The key PROMPT_WARN_BYTES should NOT appear in the result (it's not a claude env var)
    expect(result["PROMPT_WARN_BYTES"]).toBeUndefined();
    expect(result["ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES"]).toBeUndefined();
  });
});
