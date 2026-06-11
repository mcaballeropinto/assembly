/**
 * Unit tests for the codex provider helpers: model-tier resolution,
 * tools→sandbox mapping, env merge, and the JSONL item summarizer.
 *
 * These are pure-function tests — they do not spawn the `codex` CLI.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join as joinPath } from "path";
import {
  resolveModelForProvider,
  resolveCodexSandbox,
  mergeCodexEnv,
  resolveCodexBin,
  summarizeCodexItem,
  buildEnvelopeInstruction,
  DEFAULT_CODEX_MODEL,
  ensureProviderWorkspace,
  normalizeCodexUsageSnapshot,
  writeCodexUsageSnapshot,
  buildSyntheticCodexUsageSnapshotFromError,
} from "../llm";
import { calculateCost, calculateCostWithCache } from "../pricing";

const savedEnvVars: Record<string, string | undefined> = {};
function setProcessEnv(key: string, value: string) {
  savedEnvVars[key] = process.env[key];
  process.env[key] = value;
}
afterEach(() => {
  for (const [key, original] of Object.entries(savedEnvVars)) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

// ─── Codex usage snapshots ──────────────────────────────────────────

describe("codex usage snapshots", () => {
  it("normalizes documented rate_limits payloads", () => {
    const now = new Date("2026-06-11T10:00:00Z");
    const snapshot = normalizeCodexUsageSnapshot({
      limit_id: "codex",
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1780898307 },
      secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1781485107 },
      plan_type: "prolite",
    }, now);

    expect(snapshot).toEqual({
      checkedAt: now.toISOString(),
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1780898307 },
      secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1781485107 },
      plan_type: "prolite",
    });
  });

  it("writes codex usage snapshots atomically", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-codex-usage-"));
    try {
      const target = joinPath(root, "codex-usage.json");
      writeCodexUsageSnapshot({
        checkedAt: "2026-06-11T10:00:00Z",
        primary: { used_percent: 20, window_minutes: 300, resets_at: 1780898307 },
      }, target);
      expect(existsSync(target)).toBe(true);
      expect(JSON.parse(readFileSync(target, "utf8")).primary.used_percent).toBe(20);
      expect(readdirSync(root).filter((f) => f.includes(".tmp.")).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds synthetic 100% usage snapshots from usage-limit errors", () => {
    const now = new Date("2026-06-11T03:30:00");
    const snapshot = buildSyntheticCodexUsageSnapshotFromError(
      "You've hit your usage limit, try again at 4:57 AM",
      now
    );
    const expected = new Date(now);
    expected.setHours(4, 57, 0, 0);

    expect(snapshot?.primary?.used_percent).toBe(100);
    expect(snapshot?.primary?.window_minutes).toBe(300);
    expect(snapshot?.primary?.resets_at).toBe(Math.floor(expected.getTime() / 1000));
  });

  it("falls back to now plus 300 minutes for usage-limit errors without reset text", () => {
    const now = new Date("2026-06-11T03:30:00Z");
    const snapshot = buildSyntheticCodexUsageSnapshotFromError("Codex error: usage limit reached", now);
    expect(snapshot?.primary?.resets_at).toBe(Math.floor((now.getTime() + 300 * 60_000) / 1000));
  });

  it("ignores non-usage-limit errors", () => {
    expect(buildSyntheticCodexUsageSnapshotFromError("network failed")).toBeNull();
  });
});

// ─── resolveModelForProvider ────────────────────────────────────────

describe("resolveModelForProvider", () => {
  it("maps tiers to claude-code concrete models", () => {
    expect(resolveModelForProvider("claude-code", "cheap")).toBe("sonnet");
    expect(resolveModelForProvider("claude-code", "reasoning")).toBe("opus");
    expect(resolveModelForProvider("claude-code-cached", "cheap")).toBe("sonnet");
    expect(resolveModelForProvider("claude-code-cached", "reasoning")).toBe("opus");
  });

  it("maps tiers to the codex concrete model", () => {
    expect(resolveModelForProvider("codex", "cheap")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveModelForProvider("codex", "reasoning")).toBe(DEFAULT_CODEX_MODEL);
  });

  it("passes concrete model ids through unchanged (backward compatible)", () => {
    expect(resolveModelForProvider("claude-code", "sonnet")).toBe("sonnet");
    expect(resolveModelForProvider("claude-code", "opus")).toBe("opus");
    expect(resolveModelForProvider("claude-code", "haiku")).toBe("haiku");
    expect(resolveModelForProvider("claude-code", "claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(resolveModelForProvider("codex", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("falls back to claude-code tier mapping for providers without a table", () => {
    expect(resolveModelForProvider("api", "cheap")).toBe("sonnet");
    expect(resolveModelForProvider("pi", "reasoning")).toBe("opus");
  });
});

// ─── resolveCodexSandbox ────────────────────────────────────────────

describe("resolveCodexSandbox", () => {
  it("defaults (no tools declared) to workspace-write + network", () => {
    // No explicit list → DEFAULT_ALLOWED_TOOLS, which includes Write/Bash and web tools.
    const r = resolveCodexSandbox(undefined);
    expect(r.sandbox).toBe("workspace-write");
    expect(r.network).toBe(true);
  });

  it("uses read-only when no write/shell tools are declared", () => {
    const r = resolveCodexSandbox(["Read", "Grep", "Glob"]);
    expect(r.sandbox).toBe("read-only");
    expect(r.network).toBe(false);
  });

  it("uses workspace-write when Write/Edit/Bash is declared", () => {
    expect(resolveCodexSandbox(["Read", "Write"]).sandbox).toBe("workspace-write");
    expect(resolveCodexSandbox(["Edit"]).sandbox).toBe("workspace-write");
    expect(resolveCodexSandbox(["Bash"]).sandbox).toBe("workspace-write");
  });

  it("requests network when web tools are declared", () => {
    expect(resolveCodexSandbox(["Read", "WebFetch"]).network).toBe(true);
    expect(resolveCodexSandbox(["WebSearch"]).network).toBe(true);
  });

  it("treats an explicit empty tools list as read-only with no network", () => {
    const r = resolveCodexSandbox([]);
    expect(r.sandbox).toBe("read-only");
    expect(r.network).toBe(false);
  });

  it("matches bare tool names through scoped declarations", () => {
    expect(resolveCodexSandbox(["Bash(mv a b)"]).sandbox).toBe("workspace-write");
  });
});

// ─── mergeCodexEnv ──────────────────────────────────────────────────

describe("mergeCodexEnv", () => {
  it("forwards ASSEMBLY_CODEX_*-prefixed vars with the prefix stripped", () => {
    setProcessEnv("ASSEMBLY_CODEX_FOO", "bar");
    const env = mergeCodexEnv();
    expect(env["FOO"]).toBe("bar");
    expect(env["ASSEMBLY_CODEX_FOO"]).toBeUndefined();
  });

  it("lets station env override line env", () => {
    const env = mergeCodexEnv({ X: "line" }, { X: "station" });
    expect(env["X"]).toBe("station");
  });

  it("does not forward ASSEMBLY_CODEX_BIN into the subprocess env", () => {
    setProcessEnv("ASSEMBLY_CODEX_BIN", "/root/.local/bin/codex");
    const env = mergeCodexEnv();
    expect(env["BIN"]).toBeUndefined();
    expect(env["ASSEMBLY_CODEX_BIN"]).toBeUndefined();
  });

  it("falls back to the host ~/.codex login when inherited CODEX_HOME has no auth", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-codex-env-"));
    try {
      const home = joinPath(root, "home");
      const inheritedCodexHome = joinPath(root, "agent-codex-home");
      const hostCodexHome = joinPath(home, ".codex");
      mkdirSync(inheritedCodexHome, { recursive: true });
      mkdirSync(hostCodexHome, { recursive: true });
      writeFileSync(joinPath(hostCodexHome, "auth.json"), "{}");

      const env = mergeCodexEnv(undefined, undefined, {
        HOME: home,
        CODEX_HOME: inheritedCodexHome,
      });

      expect(env["CODEX_HOME"]).toBe(hostCodexHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an inherited CODEX_HOME that already has auth", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-codex-env-"));
    try {
      const home = joinPath(root, "home");
      const inheritedCodexHome = joinPath(root, "agent-codex-home");
      const hostCodexHome = joinPath(home, ".codex");
      mkdirSync(inheritedCodexHome, { recursive: true });
      mkdirSync(hostCodexHome, { recursive: true });
      writeFileSync(joinPath(inheritedCodexHome, "auth.json"), "{}");
      writeFileSync(joinPath(hostCodexHome, "auth.json"), "{}");

      const env = mergeCodexEnv(undefined, undefined, {
        HOME: home,
        CODEX_HOME: inheritedCodexHome,
      });

      expect(env["CODEX_HOME"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets ASSEMBLY_CODEX_CODEX_HOME override the fallback", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-codex-env-"));
    try {
      const home = joinPath(root, "home");
      const inheritedCodexHome = joinPath(root, "agent-codex-home");
      const hostCodexHome = joinPath(home, ".codex");
      const explicitCodexHome = joinPath(root, "explicit-codex-home");
      mkdirSync(inheritedCodexHome, { recursive: true });
      mkdirSync(hostCodexHome, { recursive: true });
      writeFileSync(joinPath(hostCodexHome, "auth.json"), "{}");

      const env = mergeCodexEnv(undefined, undefined, {
        HOME: home,
        CODEX_HOME: inheritedCodexHome,
        ASSEMBLY_CODEX_CODEX_HOME: explicitCodexHome,
      });

      expect(env["CODEX_HOME"]).toBe(explicitCodexHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── resolveCodexBin ────────────────────────────────────────────────

describe("resolveCodexBin", () => {
  it("defaults to bare 'codex' (PATH lookup)", () => {
    delete process.env.ASSEMBLY_CODEX_BIN;
    expect(resolveCodexBin()).toBe("codex");
  });

  it("honours ASSEMBLY_CODEX_BIN for narrow-PATH daemon contexts", () => {
    setProcessEnv("ASSEMBLY_CODEX_BIN", "/root/.local/bin/codex");
    expect(resolveCodexBin()).toBe("/root/.local/bin/codex");
  });
});

// ─── summarizeCodexItem ─────────────────────────────────────────────

describe("summarizeCodexItem", () => {
  it("summarizes the known item types", () => {
    expect(summarizeCodexItem({ type: "command_execution", command: "ls -la" })).toContain("ls -la");
    expect(summarizeCodexItem({ type: "file_change", path: "/tmp/x" })).toContain("/tmp/x");
    expect(summarizeCodexItem({ type: "web_search", query: "foo" })).toContain("foo");
    expect(summarizeCodexItem({ type: "reasoning" })).toBe("Reasoning");
    expect(summarizeCodexItem({ type: "agent_message" })).toBe("Message");
  });

  it("falls back to the raw type for unknown items", () => {
    expect(summarizeCodexItem({ type: "mystery_item" })).toBe("mystery_item");
    expect(summarizeCodexItem({})).toBe("item");
  });
});

// ─── codex pricing ──────────────────────────────────────────────────

describe("codex pricing", () => {
  it("prices gpt-5.5 at the published list rate", () => {
    // $5 / 1M input, $30 / 1M output
    expect(calculateCost("gpt-5.5", 1_000_000, 0)).toBeCloseTo(5, 6);
    expect(calculateCost("gpt-5.5", 0, 1_000_000)).toBeCloseTo(30, 6);
  });

  it("prices the smaller GPT-5.4 variants distinctly", () => {
    expect(calculateCost("gpt-5.4", 1_000_000, 0)).toBeCloseTo(2.5, 6);
    expect(calculateCost("gpt-5.4-mini", 1_000_000, 0)).toBeCloseTo(0.75, 6);
    expect(calculateCost("gpt-5.4-mini", 0, 1_000_000)).toBeCloseTo(4.5, 6);
  });

  it("strips the codex: prefix so each model hits its own price (not the fuzzy flagship fallback)", () => {
    // Without prefix-stripping, "codex:gpt-5.4-mini" would fuzzy-match gpt-5.5.
    expect(calculateCost("codex:gpt-5.4-mini", 1_000_000, 0)).toBeCloseTo(0.75, 6);
    expect(calculateCost("codex:gpt-5.5", 0, 1_000_000)).toBeCloseTo(30, 6);
  });

  it("applies the 10% cached-input discount", () => {
    // 1M input, all cached → 10% of $5 = $0.50
    expect(calculateCostWithCache("codex:gpt-5.5", 1_000_000, 0, 1_000_000, 0)).toBeCloseTo(0.5, 6);
  });
});

// ─── buildEnvelopeInstruction shellOnly variant ─────────────────────

describe("buildEnvelopeInstruction", () => {
  const out = "/runs/abc/wp.envelope.json";

  it("includes the exact envelope path and the mv rename", () => {
    const text = buildEnvelopeInstruction(out);
    expect(text).toContain(out);
    expect(text).toContain(`mv "${out}.tmp" "${out}"`);
  });

  it("omits claude-specific tool names in shellOnly mode", () => {
    const shell = buildEnvelopeInstruction(out, true);
    expect(shell).toContain("via your shell");
    expect(shell).not.toContain("Write tool");
    expect(shell).not.toContain("Bash tool");
  });
});

// ─── provider workspace preflight ───────────────────────────────────

describe("ensureProviderWorkspace", () => {
  it("creates a missing scratch cwd and envelope parent directory", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-provider-workspace-"));
    try {
      const scratchCwd = joinPath(root, "scratch", "nested");
      const envelopePath = joinPath(root, "run", "stations", "score", "envelope.json");

      ensureProviderWorkspace(scratchCwd, envelopePath);

      expect(existsSync(scratchCwd)).toBe(true);
      expect(existsSync(joinPath(root, "run", "stations", "score"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when no workspace paths are provided", () => {
    expect(() => ensureProviderWorkspace(undefined, undefined)).not.toThrow();
  });
});
