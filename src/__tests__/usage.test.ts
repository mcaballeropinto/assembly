import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchClaudeCodeUsage,
  checkProviderUsage,
  evaluateAndSnapshot,
  evaluateAndSnapshotForProviders,
  getEffectiveThreshold,
  __resetUsageGateStateForTest,
} from "../usage";
import { readUsageSnapshot } from "../usage-snapshot";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { join } from "path";

const TMP_DIR = resolve("/tmp", `assembly-usage-test-${Date.now()}-${process.pid}`);
const SNAP_PATH = resolve(TMP_DIR, "usage-status.json");
const CODEX_USAGE_PATH = resolve(TMP_DIR, "codex-usage.json");

const originalFetch = globalThis.fetch;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
const originalCodexUsageEnv = process.env.ASSEMBLY_CODEX_USAGE_FILE;
const originalThresholdEnv = process.env.ASSEMBLY_USAGE_THRESHOLD;

let fetchCallCount = 0;
let lastFetchUrl: string | null = null;

// Seed the token so readOauthToken() doesn't throw in tests that exercise
// fetchClaudeCodeUsage. Use a temp HOME so we don't touch the real file.
function seedFakeToken() {
  const credsDir = join(homedir(), ".claude");
  const credsPath = join(credsDir, ".credentials.json");
  try {
    mkdirSync(credsDir, { recursive: true });
    // Don't clobber a real credentials file — if one already exists with a
    // valid token, we can use it too.
    const existing = Bun.file(credsPath);
    if (!(existing.size && existing.size > 0)) {
      writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
    }
  } catch {
    writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
  }
}

function stubFetch(payload: unknown, status = 200) {
  fetchCallCount = 0;
  lastFetchUrl = null;
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCallCount += 1;
    lastFetchUrl = typeof url === "string" ? url : (url instanceof URL ? url.toString() : String(url));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function writeCodexUsage(payload: unknown) {
  writeFileSync(CODEX_USAGE_PATH, JSON.stringify(payload));
}

function futureEpoch(seconds = 3600): number {
  return Math.floor((Date.now() + seconds * 1000) / 1000);
}

function pastEpoch(seconds = 60): number {
  return Math.floor((Date.now() - seconds * 1000) / 1000);
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = SNAP_PATH;
  process.env.ASSEMBLY_CODEX_USAGE_FILE = CODEX_USAGE_PATH;
  delete process.env.ASSEMBLY_USAGE_THRESHOLD;
  __resetUsageGateStateForTest();
  seedFakeToken();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSnapEnv === undefined) delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
  else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalSnapEnv;
  if (originalCodexUsageEnv === undefined) delete process.env.ASSEMBLY_CODEX_USAGE_FILE;
  else process.env.ASSEMBLY_CODEX_USAGE_FILE = originalCodexUsageEnv;
  if (originalThresholdEnv === undefined) delete process.env.ASSEMBLY_USAGE_THRESHOLD;
  else process.env.ASSEMBLY_USAGE_THRESHOLD = originalThresholdEnv;
  __resetUsageGateStateForTest();
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("getEffectiveThreshold", () => {
  test("defaults to 75", () => {
    expect(getEffectiveThreshold()).toBe(75);
  });

  test("reads ASSEMBLY_USAGE_THRESHOLD", () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "60";
    expect(getEffectiveThreshold()).toBe(60);
  });

  test("falls back to default on invalid value", () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "abc";
    expect(getEffectiveThreshold()).toBe(75);
    process.env.ASSEMBLY_USAGE_THRESHOLD = "-5";
    expect(getEffectiveThreshold()).toBe(75);
    process.env.ASSEMBLY_USAGE_THRESHOLD = "150";
    expect(getEffectiveThreshold()).toBe(75);
  });
});

describe("fetchClaudeCodeUsage", () => {
  test("returns buckets in documented order and skips null entries", async () => {
    stubFetch({
      five_hour: { utilization: 17, resets_at: "2026-04-20T15:00:00Z" },
      seven_day: { utilization: 28, resets_at: "2026-04-24T16:00:00Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 14, resets_at: "2026-04-24T16:00:00Z" },
    });
    const out = await fetchClaudeCodeUsage();
    const labels = out.buckets.map((b) => b.label);
    expect(labels).toEqual(["5h session", "7d combined", "7d sonnet"]);
    expect(out.buckets[0].utilization).toBe(17);
    expect(out.buckets[2].utilization).toBe(14);
    expect(lastFetchUrl).toContain("/api/oauth/usage");
  });

  test("missing bucket keys produce empty list", async () => {
    stubFetch({});
    const out = await fetchClaudeCodeUsage();
    expect(out.buckets.length).toBe(0);
    expect(out.raw).toEqual({});
  });

  test("throws on non-OK status", async () => {
    stubFetch({}, 500);
    await expect(fetchClaudeCodeUsage()).rejects.toThrow(/returned 500/);
  });
});

describe("checkProviderUsage (claude-code)", () => {
  test("canProcess true when all buckets below threshold", async () => {
    stubFetch({
      five_hour: { utilization: 17, resets_at: "2026-04-20T15:00:00Z" },
      seven_day: { utilization: 28, resets_at: "2026-04-24T16:00:00Z" },
    });
    const status = await checkProviderUsage("claude-code");
    expect(status.canProcess).toBe(true);
  });

  test("canProcess false when a bucket >= ASSEMBLY_USAGE_THRESHOLD", async () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "50";
    stubFetch({
      five_hour: { utilization: 60, resets_at: "2026-04-20T15:00:00Z" },
      seven_day: { utilization: 28, resets_at: "2026-04-24T16:00:00Z" },
    });
    const status = await checkProviderUsage("claude-code");
    expect(status.canProcess).toBe(false);
    expect(status.reason).toMatch(/5h session at 60/);
    expect(status.reason).toMatch(/>= 50%/);
  });

  test("shares fetch cache with fetchClaudeCodeUsage (only one network hit)", async () => {
    stubFetch({ five_hour: { utilization: 10, resets_at: null } });
    const a = await fetchClaudeCodeUsage();
    const b = await checkProviderUsage("claude-code");
    expect(a.buckets.length).toBe(1);
    expect(b.canProcess).toBe(true);
    expect(fetchCallCount).toBe(1);
  });

  test("non-claude-code providers pass through", async () => {
    const status = await checkProviderUsage("script");
    expect(status.canProcess).toBe(true);
  });

  test("claude-code-cached shares the claude-code usage gate", async () => {
    stubFetch({ five_hour: { utilization: 10, resets_at: null } });
    const status = await checkProviderUsage("claude-code-cached");
    expect(status.canProcess).toBe(true);
  });
});

describe("checkProviderUsage (codex)", () => {
  test("allows cold start when codex usage file is missing", async () => {
    const status = await checkProviderUsage("codex");
    expect(status.canProcess).toBe(true);
  });

  test("canProcess true when codex windows are under threshold", async () => {
    writeCodexUsage({
      checkedAt: "2026-06-11T10:00:00Z",
      primary: { used_percent: 20, window_minutes: 300, resets_at: futureEpoch() },
      secondary: { used_percent: 30, window_minutes: 10080, resets_at: futureEpoch(7200) },
      plan_type: "prolite",
    });
    const status = await checkProviderUsage("codex");
    expect(status.canProcess).toBe(true);
  });

  test("canProcess false when codex window crosses threshold", async () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "75";
    const resetAt = futureEpoch();
    writeCodexUsage({
      checkedAt: "2026-06-11T10:00:00Z",
      primary: { used_percent: 92, window_minutes: 300, resets_at: resetAt },
      secondary: { used_percent: 10, window_minutes: 10080, resets_at: futureEpoch(7200) },
    });
    const status = await checkProviderUsage("codex");
    expect(status.canProcess).toBe(false);
    expect(status.reason).toMatch(/5h session at 92\.0%/);
    expect(status.reason).toMatch(/>= 75%/);
    expect(status.resetAt?.toISOString()).toBe(new Date(resetAt * 1000).toISOString());
  });

  test("ignores expired codex windows even when utilization is over threshold", async () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "75";
    writeCodexUsage({
      checkedAt: "2026-06-11T10:00:00Z",
      primary: { used_percent: 100, window_minutes: 300, resets_at: pastEpoch() },
    });
    const status = await checkProviderUsage("codex");
    expect(status.canProcess).toBe(true);
  });
});

describe("evaluateAndSnapshot", () => {
  test("writes healthy claude snapshot when under threshold", async () => {
    stubFetch({
      five_hour: { utilization: 17, resets_at: "2026-04-20T15:00:00Z" },
      seven_day: { utilization: 28, resets_at: "2026-04-24T16:00:00Z" },
    });
    const decision = await evaluateAndSnapshotForProviders(["claude-code"]);
    expect(decision.blocked).toBe(false);
    const snap = readUsageSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.paused).toBe(false);
    expect(snap?.providers["claude-code"]?.buckets.length).toBe(2);
  });

  test("writes paused claude snapshot when a bucket crosses the threshold", async () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "10";
    stubFetch({
      five_hour: { utilization: 17, resets_at: "2026-04-20T15:00:00Z" },
    });
    const decision = await evaluateAndSnapshotForProviders(["claude-code"]);
    expect(decision.blocked).toBe(true);
    const snap = readUsageSnapshot();
    expect(snap?.paused).toBe(true);
    expect(snap?.pauseReason).toMatch(/5h session at 17/);
    expect(snap?.threshold).toBe(10);
  });

  test("fail-closed on fetch error — snapshot records it", async () => {
    stubFetch({}, 500);
    const decision = await evaluateAndSnapshotForProviders(["claude-code"]);
    expect(decision.blocked).toBe(true);
    const snap = readUsageSnapshot();
    expect(snap?.paused).toBe(true);
    expect(snap?.providers["claude-code"]?.error).toMatch(/returned 500/);
  });

  test("throttles writes within 30s window", async () => {
    stubFetch({ five_hour: { utilization: 10, resets_at: null } });
    await evaluateAndSnapshotForProviders(["claude-code"]);
    const firstFetchCount = fetchCallCount;
    // Immediate second call — must not re-fetch or re-write.
    await evaluateAndSnapshotForProviders(["claude-code"]);
    expect(fetchCallCount).toBe(firstFetchCount);
  });

  test("evaluates codex from codex usage file without fetching Claude OAuth", async () => {
    stubFetch({ five_hour: { utilization: 99, resets_at: null } });
    writeCodexUsage({
      checkedAt: "2026-06-11T10:00:00Z",
      primary: { used_percent: 20, window_minutes: 300, resets_at: futureEpoch() },
      secondary: { used_percent: 30, window_minutes: 10080, resets_at: futureEpoch(7200) },
      plan_type: "prolite",
    });
    const decision = await evaluateAndSnapshotForProviders(["codex", "script"]);
    expect(decision.blocked).toBe(false);
    expect(fetchCallCount).toBe(0);
    const snap = readUsageSnapshot();
    expect(snap?.paused).toBe(false);
    expect(snap?.providers.codex?.buckets.map((b) => b.label)).toEqual(["5h session", "7d"]);
  });

  test("writes paused codex snapshot when codex crosses threshold", async () => {
    process.env.ASSEMBLY_USAGE_THRESHOLD = "70";
    writeCodexUsage({
      checkedAt: "2026-06-11T10:00:00Z",
      primary: { used_percent: 50, window_minutes: 300, resets_at: futureEpoch(7200) },
      secondary: { used_percent: 80, window_minutes: 10080, resets_at: futureEpoch() },
    });
    const decision = await evaluateAndSnapshotForProviders(["codex"]);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/codex: 7d at 80\.0%/);
    const snap = readUsageSnapshot();
    expect(snap?.paused).toBe(true);
    expect(snap?.providers.codex?.buckets.length).toBe(2);
  });

  test("default evaluateAndSnapshot uses codex provider", async () => {
    writeCodexUsage({
      checkedAt: "2026-06-11T10:00:00Z",
      primary: { used_percent: 10, window_minutes: 300, resets_at: futureEpoch() },
    });
    const decision = await evaluateAndSnapshot();
    expect(decision.blocked).toBe(false);
    const snap = readUsageSnapshot();
    expect(snap?.providers.codex?.buckets[0].label).toBe("5h session");
  });

  test("missing codex usage file writes empty codex buckets and does not block", async () => {
    const decision = await evaluateAndSnapshotForProviders(["codex"]);
    expect(decision.blocked).toBe(false);
    const snap = readUsageSnapshot();
    expect(snap?.paused).toBe(false);
    expect(snap?.providers.codex?.buckets).toEqual([]);
  });
});
