import { describe, it, expect, afterEach } from "bun:test";
import { mergeClaudeEnv, DEFAULT_CLAUDE_ENV, getPromptWarnThreshold, CLAUDE_PROMPT_WARN_DEFAULT } from "../llm";
import { resolve } from "path";

// Save original env vars for cleanup
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

describe("mergeClaudeEnv", () => {
  afterEach(() => {
    cleanupEnv();
  });

  it("returns all 6 default env vars when called with no args", () => {
    const result = mergeClaudeEnv();
    expect(result.CLAUDE_ENABLE_BYTE_WATCHDOG).toBe("1");
    expect(result.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe("1");
    expect(result.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("300000");
    expect(result.API_TIMEOUT_MS).toBe("600000");
    expect(result.BASH_DEFAULT_TIMEOUT_MS).toBe("120000");
    expect(result.BASH_MAX_TIMEOUT_MS).toBe("900000");
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(6);
  });

  it("line-level override replaces one value", () => {
    const result = mergeClaudeEnv({ API_TIMEOUT_MS: "900000" });
    expect(result.API_TIMEOUT_MS).toBe("900000");
    // Other defaults unchanged
    expect(result.CLAUDE_ENABLE_BYTE_WATCHDOG).toBe("1");
    expect(result.BASH_MAX_TIMEOUT_MS).toBe("900000");
  });

  it("station-level override wins over line", () => {
    const result = mergeClaudeEnv(
      { API_TIMEOUT_MS: "900000" },
      { API_TIMEOUT_MS: "1200000" }
    );
    expect(result.API_TIMEOUT_MS).toBe("1200000");
  });

  it("station adds new key alongside defaults", () => {
    const result = mergeClaudeEnv(undefined, { CUSTOM_VAR: "hello" });
    expect(result.CUSTOM_VAR).toBe("hello");
    expect(result.CLAUDE_ENABLE_BYTE_WATCHDOG).toBe("1");
  });

  it("ASSEMBLY_CLAUDE_* process env override", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_API_TIMEOUT_MS", "500000");
    const result = mergeClaudeEnv();
    expect(result.API_TIMEOUT_MS).toBe("500000");
  });

  it("full precedence: station > line > process env > defaults", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_API_TIMEOUT_MS", "111111");
    const result = mergeClaudeEnv(
      { API_TIMEOUT_MS: "222222" },
      { API_TIMEOUT_MS: "333333" }
    );
    expect(result.API_TIMEOUT_MS).toBe("333333");
  });

  it("line > process env", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_API_TIMEOUT_MS", "111111");
    const result = mergeClaudeEnv({ API_TIMEOUT_MS: "222222" });
    expect(result.API_TIMEOUT_MS).toBe("222222");
  });

  it("process env > defaults", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_API_TIMEOUT_MS", "111111");
    const result = mergeClaudeEnv();
    expect(result.API_TIMEOUT_MS).toBe("111111");
  });
});

describe("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES is not forwarded to claude env", () => {
  it("does not appear in mergeClaudeEnv result when set in process.env", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "99999");
    const result = mergeClaudeEnv();
    // Should NOT be forwarded as PROMPT_WARN_BYTES to claude
    expect(result["PROMPT_WARN_BYTES"]).toBeUndefined();
    // Other vars should still work
    expect(result.CLAUDE_ENABLE_BYTE_WATCHDOG).toBe("1");
  });

  it("getPromptWarnThreshold reads ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", () => {
    setProcessEnv("ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES", "75000");
    expect(getPromptWarnThreshold()).toBe(75_000);
  });

  it("getPromptWarnThreshold returns default when env not set", () => {
    delete process.env.ASSEMBLY_CLAUDE_PROMPT_WARN_BYTES;
    expect(getPromptWarnThreshold()).toBe(CLAUDE_PROMPT_WARN_DEFAULT);
  });
});

describe("DEFAULT_CLAUDE_ENV", () => {
  it("has exactly 6 entries", () => {
    expect(Object.keys(DEFAULT_CLAUDE_ENV).length).toBe(6);
  });

  it("all values are strings", () => {
    for (const val of Object.values(DEFAULT_CLAUDE_ENV)) {
      expect(typeof val).toBe("string");
    }
  });
});

describe("line.yaml validation", () => {
  const { loadLine } = require("../line");

  it("rejects non-object claude_env", async () => {
    // Create a temp line with invalid claude_env
    const tmpLine = "/tmp/assembly-test-env-validation-" + Date.now();
    const { mkdirSync, writeFileSync } = require("fs");
    const { rmSync } = require("fs");
    try {
      mkdirSync(resolve(tmpLine, "stations", "test"), { recursive: true });
      writeFileSync(resolve(tmpLine, "stations", "test", "AGENT.md"), "---\n---\nTest prompt");
      writeFileSync(resolve(tmpLine, "line.yaml"),
        'name: test-env\nsequence:\n  - test\ndefaults:\n  claude_env: "not-an-object"\n'
      );
      await expect(loadLine(tmpLine)).rejects.toThrow("claude_env must be a key-value object");
    } finally {
      rmSync(tmpLine, { recursive: true, force: true });
    }
  });

  it("rejects negative heartbeat.interval_ms", async () => {
    const tmpLine = "/tmp/assembly-test-hb-validation-" + Date.now();
    const { mkdirSync, writeFileSync, rmSync } = require("fs");
    try {
      mkdirSync(resolve(tmpLine, "stations", "test"), { recursive: true });
      writeFileSync(resolve(tmpLine, "stations", "test", "AGENT.md"), "---\n---\nTest prompt");
      writeFileSync(resolve(tmpLine, "line.yaml"),
        'name: test-hb\nsequence:\n  - test\nheartbeat:\n  interval_ms: -5\n'
      );
      await expect(loadLine(tmpLine)).rejects.toThrow("non-negative integer");
    } finally {
      rmSync(tmpLine, { recursive: true, force: true });
    }
  });

  it("rejects non-boolean heartbeat.emit_when_silent", async () => {
    const tmpLine = "/tmp/assembly-test-hb-bool-" + Date.now();
    const { mkdirSync, writeFileSync, rmSync } = require("fs");
    try {
      mkdirSync(resolve(tmpLine, "stations", "test"), { recursive: true });
      writeFileSync(resolve(tmpLine, "stations", "test", "AGENT.md"), "---\n---\nTest prompt");
      writeFileSync(resolve(tmpLine, "line.yaml"),
        'name: test-hb\nsequence:\n  - test\nheartbeat:\n  emit_when_silent: "yes"\n'
      );
      await expect(loadLine(tmpLine)).rejects.toThrow("must be a boolean");
    } finally {
      rmSync(tmpLine, { recursive: true, force: true });
    }
  });

  it("existing repo-health-digest line validates without errors", async () => {
    const { validateLine } = require("../line");
    const linePath = resolve(__dirname, "..", "..", "lines", "repo-health-digest");
    const { existsSync } = require("fs");
    if (existsSync(linePath)) {
      const errors = await validateLine(linePath);
      expect(errors).toEqual([]);
    }
  });

  it("existing assembly-dev line validates without errors", async () => {
    const { validateLine } = require("../line");
    const linePath = resolve(__dirname, "..", "..", "lines", "assembly-dev");
    const { existsSync } = require("fs");
    if (existsSync(linePath)) {
      const errors = await validateLine(linePath);
      expect(errors).toEqual([]);
    }
  });
});
