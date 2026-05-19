import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./types";
import {
  writeUsageSnapshot,
  type BucketSnapshot,
  type UsageSnapshot,
} from "./usage-snapshot";

// ─── Usage Gate ──────────────────────────────────────────────────────
//
// Provider-agnostic pre-flight check for whether the orchestrator should
// keep pulling tasks. Each provider can dispatch to its own usage source
// (Claude Code plan OAuth endpoint, API spend tracker, etc.) and returns
// a normalized status. When canProcess is false, resetAt tells the
// orchestrator roughly when the blocking limit clears — but the actual
// cadence is driven by the orchestrator's polling loop.

export interface UsageStatus {
  canProcess: boolean;
  resetAt?: Date;
  reason?: string;
}

const DEFAULT_THRESHOLD_PCT = 75;

export function getEffectiveThreshold(): number {
  const raw = process.env.ASSEMBLY_USAGE_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD_PCT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return DEFAULT_THRESHOLD_PCT;
  return n;
}

// ─── Claude Code (OAuth plan) ────────────────────────────────────────

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Caching + backoff for the OAuth usage endpoint.
//
// Motivation: the Cloudflare edge in front of /api/oauth/usage aggressively
// rate-limits repeated hits (observed: HTTP 429 with `retry-after: 0`,
// cycling pause→resume→pause every ~2 min). Without a cache we pound the
// endpoint and never see the real bucket data.
const FRESH_TTL_MS = 60 * 1000;        // reuse without calling
const STALE_TTL_MS = 15 * 60 * 1000;   // fallback on transient failure
const MAX_BACKOFF_MS = 30 * 60 * 1000;

let lastGoodStatus: UsageStatus | null = null;
let lastGoodAt = 0;
let consecutive429s = 0;
let nextAllowedCheckAt = 0;

// Cache of the full fetched payload so fetchClaudeCodeUsage and
// checkProviderUsage don't each hit the network.
let lastFetched: { buckets: BucketSnapshot[]; raw: OauthUsageResponse } | null = null;
let lastFetchedAt = 0;

interface OauthBucket {
  utilization: number;
  resets_at: string | null;
}

interface OauthUsageResponse {
  five_hour?: OauthBucket | null;
  seven_day?: OauthBucket | null;
  seven_day_opus?: OauthBucket | null;
  seven_day_sonnet?: OauthBucket | null;
  [k: string]: unknown;
}

const BUCKET_ORDER: Array<[string, keyof OauthUsageResponse]> = [
  ["5h session", "five_hour"],
  ["7d combined", "seven_day"],
  ["7d opus", "seven_day_opus"],
  ["7d sonnet", "seven_day_sonnet"],
];

async function readOauthToken(): Promise<string> {
  const path = join(homedir(), ".claude", ".credentials.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
  const token = parsed?.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error(
      `No accessToken in ${path}. Run 'claude auth status' to refresh.`
    );
  }
  return token;
}

function computeBackoffMs(retryAfterMs: number | null): number {
  // Exponential with retry-after as a floor: 60s, 2m, 4m, 8m, 16m, 30m cap.
  const exp = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (consecutive429s - 1));
  const floor = retryAfterMs ?? 0;
  // retry-after: 0 is not useful — ignore it as a signal for the floor.
  return Math.max(exp, floor > 0 ? floor : 0);
}

function extractBuckets(data: OauthUsageResponse): BucketSnapshot[] {
  const out: BucketSnapshot[] = [];
  for (const [label, key] of BUCKET_ORDER) {
    const bucket = data[key] as OauthBucket | null | undefined;
    if (!bucket) continue;
    out.push({
      label,
      utilization: bucket.utilization,
      resets_at: bucket.resets_at,
    });
  }
  return out;
}

/**
 * Low-level fetch: returns the ordered bucket snapshots plus the raw
 * endpoint JSON. Never thresholds — callers decide what to do with it.
 * Honors the FRESH_TTL_MS cache so dashboards and the gate don't
 * double-hit the endpoint on bursts.
 */
export async function fetchClaudeCodeUsage(): Promise<{
  buckets: BucketSnapshot[];
  raw: OauthUsageResponse;
}> {
  const now = Date.now();
  if (lastFetched && now - lastFetchedAt < FRESH_TTL_MS) {
    return lastFetched;
  }
  const token = await readOauthToken();
  const res = await fetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OAuth usage endpoint returned ${res.status}: ${body.slice(0, 200)}`
    );
  }
  const raw = (await res.json()) as OauthUsageResponse;
  const buckets = extractBuckets(raw);
  lastFetched = { buckets, raw };
  lastFetchedAt = now;
  return lastFetched;
}

async function checkClaudeCodeUsage(): Promise<UsageStatus> {
  const now = Date.now();

  // Fresh cache hit — skip the endpoint entirely.
  if (lastGoodStatus && now - lastGoodAt < FRESH_TTL_MS) {
    return lastGoodStatus;
  }

  // Inside a 429 backoff window — serve stale cache if we have one, else pause.
  if (now < nextAllowedCheckAt) {
    if (lastGoodStatus && now - lastGoodAt < STALE_TTL_MS) {
      return {
        ...lastGoodStatus,
        reason: `${lastGoodStatus.reason ?? "cached"} (backoff until ${new Date(nextAllowedCheckAt).toISOString()})`,
      };
    }
    return {
      canProcess: false,
      resetAt: new Date(nextAllowedCheckAt),
      reason: `usage endpoint backoff (${consecutive429s} consecutive 429s), retry after ${new Date(nextAllowedCheckAt).toISOString()}`,
    };
  }

  let fetched: { buckets: BucketSnapshot[]; raw: OauthUsageResponse };
  try {
    fetched = await fetchClaudeCodeUsage();
  } catch (err) {
    const msg = (err as Error).message;
    // Detect a 429 leaking through as an error (fetchClaudeCodeUsage throws
    // on non-OK; we inspect the message to arm backoff).
    const match = msg.match(/returned 429/);
    if (match) {
      consecutive429s += 1;
      const backoffMs = computeBackoffMs(null);
      nextAllowedCheckAt = Date.now() + backoffMs;
      if (lastGoodStatus && Date.now() - lastGoodAt < STALE_TTL_MS) {
        return {
          ...lastGoodStatus,
          reason: `${lastGoodStatus.reason ?? "cached"} (usage endpoint 429, backing off ${Math.round(backoffMs / 1000)}s)`,
        };
      }
      return {
        canProcess: false,
        resetAt: new Date(nextAllowedCheckAt),
        reason: `usage endpoint 429, backing off ${Math.round(backoffMs / 1000)}s`,
      };
    }
    throw err;
  }

  // Success — reset backoff, compute status, cache it.
  consecutive429s = 0;
  nextAllowedCheckAt = 0;

  const limit = getEffectiveThreshold();
  let worst: { label: string; utilization: number; resetAt: Date } | null = null;
  for (const b of fetched.buckets) {
    if (b.utilization >= limit) {
      const resetAt = b.resets_at
        ? new Date(b.resets_at)
        : new Date(Date.now() + 60 * 60 * 1000);
      if (!worst || resetAt.getTime() < worst.resetAt.getTime()) {
        worst = { label: b.label, utilization: b.utilization, resetAt };
      }
    }
  }

  const status: UsageStatus = worst
    ? {
        canProcess: false,
        resetAt: worst.resetAt,
        reason: `${worst.label} at ${worst.utilization.toFixed(1)}% (>= ${limit}%), resets ${worst.resetAt.toISOString()}`,
      }
    : { canProcess: true };

  lastGoodStatus = status;
  lastGoodAt = Date.now();
  return status;
}

// ─── Dispatch ────────────────────────────────────────────────────────

export async function checkProviderUsage(
  provider: Provider
): Promise<UsageStatus> {
  switch (provider) {
    case "claude-code":
      return checkClaudeCodeUsage();
    case "script":
      return { canProcess: true };
    default:
      return { canProcess: true };
  }
}

// ─── Snapshot-writing evaluator ──────────────────────────────────────
//
// Called by the orchestrator before draining the inbox. Fetches usage,
// writes a snapshot to disk for the dashboard, and returns the blocked
// decision. Throttles writes to once per ~30s so bursty drainInbox calls
// don't hammer disk — within the throttle window the cached decision is
// returned verbatim.

const WRITE_THROTTLE_MS = 30_000;
const ACTIVE_PROVIDERS: Provider[] = ["claude-code"];

let lastEvalAt = 0;
let lastEvalDecision: { blocked: boolean; reason?: string } = { blocked: false };
let inFlightEval: Promise<{ blocked: boolean; reason?: string }> | null = null;

/**
 * Test-only reset: clears evaluator throttle + fetch cache. Not exported
 * for production use.
 */
export function __resetUsageGateStateForTest(): void {
  lastGoodStatus = null;
  lastGoodAt = 0;
  consecutive429s = 0;
  nextAllowedCheckAt = 0;
  lastFetched = null;
  lastFetchedAt = 0;
  lastEvalAt = 0;
  lastEvalDecision = { blocked: false };
  inFlightEval = null;
}

async function doEvaluate(): Promise<{ blocked: boolean; reason?: string }> {
  // Quiet bypass for environments without Claude Code OAuth (self-hosted
  // providers, tests, dev sandboxes). When set, all calls return "not
  // blocked" without ever touching the network or reading credentials.
  if (process.env.ASSEMBLY_DISABLE_USAGE_GATE === "1") {
    lastEvalAt = Date.now();
    lastEvalDecision = { blocked: false };
    return lastEvalDecision;
  }
  const threshold = getEffectiveThreshold();
  const snapshot: UsageSnapshot = {
    checkedAt: new Date().toISOString(),
    threshold,
    paused: false,
    providers: {},
  };

  let decision: { blocked: boolean; reason?: string } = { blocked: false };

  for (const provider of ACTIVE_PROVIDERS) {
    try {
      if (provider === "claude-code") {
        const { buckets, raw } = await fetchClaudeCodeUsage();
        snapshot.providers["claude-code"] = { buckets, raw };
      }
      const status = await checkProviderUsage(provider);
      if (!status.canProcess) {
        snapshot.paused = true;
        snapshot.pauseReason = `${provider}: ${status.reason ?? "over threshold"}`;
        decision = { blocked: true, reason: snapshot.pauseReason };
        break;
      }
    } catch (err) {
      const msg = (err as Error).message;
      snapshot.paused = true;
      snapshot.pauseReason = `${provider} usage check failed: ${msg}`;
      if (provider === "claude-code") {
        snapshot.providers["claude-code"] = { buckets: [], error: msg };
      }
      decision = { blocked: true, reason: snapshot.pauseReason };
      break;
    }
  }

  try {
    writeUsageSnapshot(snapshot);
  } catch {
    // Snapshot write failures must not take down the orchestrator — the
    // dashboard panel simply stays on the last known snapshot.
  }
  lastEvalAt = Date.now();
  lastEvalDecision = decision;
  return decision;
}

/**
 * Evaluate usage and persist a snapshot. Writes are throttled to
 * WRITE_THROTTLE_MS so drainInbox bursts don't hammer the disk. In-flight
 * evaluations are latched so concurrent callers share a single fetch.
 */
export function evaluateAndSnapshot(): Promise<{ blocked: boolean; reason?: string }> {
  const now = Date.now();
  if (lastEvalAt > 0 && now - lastEvalAt < WRITE_THROTTLE_MS) {
    return Promise.resolve(lastEvalDecision);
  }
  if (inFlightEval) return inFlightEval;
  inFlightEval = doEvaluate().finally(() => {
    inFlightEval = null;
  });
  return inFlightEval;
}
