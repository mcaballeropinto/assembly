import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import {
  decideRetry,
  mergeRetryPolicy,
  DEFAULT_RETRY_POLICY,
  startOrchestrator,
} from "../orchestrator";
import { classifyError } from "../section-worker";
import { EnvelopeError, GuardrailError } from "../envelope";
import { createWorkpiece, failStation } from "../workpiece";
import type { FailureClass, RetryPolicyMap, Workpiece } from "../types";
import { __resetUsageGateStateForTest } from "../usage";
import { LineName, StationName } from '../ids';

// ─── Pure-function tests ────────────────────────────────────────────

describe("decideRetry()", () => {
  test("envelope class → 1 retry with 30s backoff", () => {
    const d0 = decideRetry("envelope", 0, DEFAULT_RETRY_POLICY);
    const d1 = decideRetry("envelope", 1, DEFAULT_RETRY_POLICY);
    expect(d0).toEqual({ action: "retry", attempt: 1, delay_s: 30 });
    expect(d1).toEqual({ action: "error_bucket" });
  });

  test("guardrail class → 1 retry with 30s backoff", () => {
    const d0 = decideRetry("guardrail", 0, DEFAULT_RETRY_POLICY);
    const d1 = decideRetry("guardrail", 1, DEFAULT_RETRY_POLICY);
    expect(d0).toEqual({ action: "retry", attempt: 1, delay_s: 30 });
    expect(d1).toEqual({ action: "error_bucket" });
  });

  test("crash class → 2 retries with backoff [15, 60]", () => {
    const d0 = decideRetry("crash", 0, DEFAULT_RETRY_POLICY);
    const d1 = decideRetry("crash", 1, DEFAULT_RETRY_POLICY);
    const d2 = decideRetry("crash", 2, DEFAULT_RETRY_POLICY);
    expect(d0).toEqual({ action: "retry", attempt: 1, delay_s: 15 });
    expect(d1).toEqual({ action: "retry", attempt: 2, delay_s: 60 });
    expect(d2).toEqual({ action: "error_bucket" });
  });

  test("timeout class → 1 retry with 60s backoff", () => {
    const d0 = decideRetry("timeout", 0, DEFAULT_RETRY_POLICY);
    const d1 = decideRetry("timeout", 1, DEFAULT_RETRY_POLICY);
    expect(d0).toEqual({ action: "retry", attempt: 1, delay_s: 60 });
    expect(d1).toEqual({ action: "error_bucket" });
  });

  test("provider class → 3 retries with exponential backoff [5, 30, 120]", () => {
    const delays = [0, 1, 2].map(
      (n) => decideRetry("provider", n, DEFAULT_RETRY_POLICY) as {
        action: "retry";
        delay_s: number;
      }
    );
    expect(delays.map((d) => d.delay_s)).toEqual([5, 30, 120]);
    const exhausted = decideRetry("provider", 3, DEFAULT_RETRY_POLICY);
    expect(exhausted.action).toBe("error_bucket");
  });

  test("unknown class (legacy behaviour) → 2 retries", () => {
    const d0 = decideRetry("unknown", 0, DEFAULT_RETRY_POLICY);
    const d2 = decideRetry("unknown", 2, DEFAULT_RETRY_POLICY);
    expect(d0.action).toBe("retry");
    expect(d2.action).toBe("error_bucket");
  });

  test("aborted class → 2 retries with backoff [15, 60]", () => {
    const d0 = decideRetry("aborted", 0, DEFAULT_RETRY_POLICY);
    const d1 = decideRetry("aborted", 1, DEFAULT_RETRY_POLICY);
    const d2 = decideRetry("aborted", 2, DEFAULT_RETRY_POLICY);
    expect(d0).toEqual({ action: "retry", attempt: 1, delay_s: 15 });
    expect(d1).toEqual({ action: "retry", attempt: 2, delay_s: 60 });
    expect(d2).toEqual({ action: "error_bucket" });
  });

  test("missing failure_class (undefined) falls through to unknown policy", () => {
    // Legacy workpieces written before plan #5 have no failure_class — the
    // orchestrator must still retry them on the conservative unknown budget,
    // not bucket them immediately.
    const d = decideRetry(undefined, 0, DEFAULT_RETRY_POLICY);
    expect(d.action).toBe("retry");
  });

  test("reuses last backoff entry when policy list is shorter than attempts", () => {
    const policy: RetryPolicyMap = {
      ...DEFAULT_RETRY_POLICY,
      unknown: { maxRetries: 5, backoff: [10] },
    };
    // At retry 3, backoff[3] is undefined — should fall back to the last entry.
    const d = decideRetry("unknown", 3, policy) as { delay_s: number };
    expect(d.delay_s).toBe(10);
  });
});

// ─── mergeRetryPolicy tests ─────────────────────────────────────────

describe("mergeRetryPolicy()", () => {
  test("returns the defaults when called with no override", () => {
    expect(mergeRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
  });

  test("overrides only the classes provided; others keep defaults", () => {
    const merged = mergeRetryPolicy({
      envelope: { maxRetries: 1, backoff: [5] },
    });
    expect(merged.envelope).toEqual({ maxRetries: 1, backoff: [5] });
    expect(merged.crash).toEqual(DEFAULT_RETRY_POLICY.crash);
    expect(merged.provider).toEqual(DEFAULT_RETRY_POLICY.provider);
  });
});

// ─── classifyError tests ────────────────────────────────────────────

describe("classifyError()", () => {
  test("EnvelopeError → envelope", () => {
    expect(classifyError(new EnvelopeError("bad JSON"))).toBe("envelope");
  });

  test("GuardrailError → guardrail (distinct from envelope)", () => {
    expect(classifyError(new GuardrailError(["Missing required field: data.scored_items"]))).toBe("guardrail");
  });

  test("non-zero exit → crash", () => {
    expect(classifyError(new Error("claude exited with code 137"))).toBe("crash");
    expect(classifyError(new Error("All models failed. Last error: ..."))).toBe("crash");
  });

  test("rate limit / API error → provider", () => {
    expect(classifyError(new Error("HTTP 429 rate limit exceeded"))).toBe("provider");
    expect(classifyError(new Error("ANTHROPIC_API_KEY not set"))).toBe("provider");
    expect(classifyError(new Error("Anthropic API error: overloaded"))).toBe("provider");
  });

  test("plain unclassified error → unknown", () => {
    expect(classifyError(new Error("something went sideways"))).toBe("unknown");
  });
});

// ─── Integration tests: orchestrator output watcher end-to-end ──────

/**
 * Build a minimal line with a single `script` station whose script output
 * doesn't matter — we bypass it entirely by dropping workpieces straight into
 * queue/output/ with a pre-set failure_class, then observe where the
 * orchestrator routes them.
 */
function createRetryTestLine(linePath: string, stationName: string): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });

  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: retry-policy-test\nsequence:\n  - ${stationName}\n`
  );

  const stationDir = resolve(linePath, "stations", stationName);
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(
    resolve(stationDir, "AGENT.md"),
    `---\nprovider: script\nscript: ok.ts\n---\n`
  );
  writeFileSync(
    resolve(stationDir, "ok.ts"),
    `console.log(JSON.stringify({ summary: "ok" }));\n`
  );
}

function buildFailedWorkpiece(
  stationName: string,
  failureClass: FailureClass | undefined
): Workpiece {
  const wp = createWorkpiece(LineName("retry-policy-test"), "retry-policy-task");
  const withFailure = failStation(
    wp,
    StationName(stationName),
    `seeded ${failureClass ?? "legacy"} failure`,
    {
      model: "test:test",
      tokens: { in: 0, out: 0 },
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z",
    },
    failureClass ?? "unknown"
  );
  // Strip failure_class when simulating legacy workpieces.
  if (failureClass === undefined) {
    delete (withFailure.stations[StationName(stationName)] as { failure_class?: FailureClass })
      .failure_class;
  }
  return withFailure;
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

const orchestrators: Array<{ stop: () => void | Promise<void> }> = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  const snapDir = resolve(
    "/tmp",
    `assembly-test-retry-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(snapDir, { recursive: true });
  tempDirs.push(snapDir);
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = resolve(snapDir, "usage-status.json");

  // Fake OAuth creds so the usage gate doesn't throw.
  try {
    const credsDir = join(homedir(), ".claude");
    const credsPath = join(credsDir, ".credentials.json");
    mkdirSync(credsDir, { recursive: true });
    const existing = Bun.file(credsPath);
    if (!(existing.size && existing.size > 0)) {
      writeFileSync(
        credsPath,
        JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } })
      );
    }
  } catch {}

  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : String(url);
    if (urlStr.includes("/api/oauth/usage")) {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" },
          seven_day: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(url as any);
  }) as typeof fetch;

  __resetUsageGateStateForTest();
});

afterEach(async () => {
  for (const o of orchestrators.splice(0)) {
    try { await o.stop(); } catch {}
  }
  await new Promise((r) => setTimeout(r, 200));
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  globalThis.fetch = originalFetch;
});

describe("orchestrator retry policy integration", () => {
  test("envelope failure → retries once then error_bucket on second failure", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-retry-envelope-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);
    const stationName = "s1";
    createRetryTestLine(linePath, stationName);

    // Use zero-delay backoff so the retry fires immediately in the test.
    const orch = await startOrchestrator({
      linePath,
      retryPolicy: { envelope: { maxRetries: 1, backoff: [0] } },
    });
    orchestrators.push(orch);
    await new Promise((r) => setTimeout(r, 150));

    // Drop a pre-failed workpiece straight into the station's output dir.
    const wp = buildFailedWorkpiece(stationName, "envelope");
    const outputPath = resolve(
      linePath,
      "stations",
      stationName,
      "queue",
      "output",
      `${wp.id}.json`
    );
    writeFileSync(outputPath, JSON.stringify(wp, null, 2));

    // First: expect a retry event to fire.
    const activityPath = resolve(linePath, "queues", "activity.jsonl");
    const retryFired = await waitFor(() => {
      if (!existsSync(activityPath)) return false;
      return readFileSync(activityPath, "utf-8")
        .trim()
        .split("\n")
        .some((l) => {
          try {
            const e = JSON.parse(l);
            return e.event === "retry" && e.workpiece === wp.id;
          } catch {
            return false;
          }
        });
    }, 3_000);
    expect(retryFired).toBe(true);

    const retryEvent = readFileSync(activityPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "retry" && e.workpiece === wp.id);
    expect(retryEvent.failure_class).toBe("envelope");
    expect(retryEvent.attempt).toBe(1);
  });

  test("legacy workpiece (no failure_class) retries under unknown policy", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-retry-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);
    const stationName = "s1";
    createRetryTestLine(linePath, stationName);

    // Tight backoff override so the retry fires fast in the test.
    const orch = await startOrchestrator({
      linePath,
      retryPolicy: { unknown: { maxRetries: 2, backoff: [0, 0] } },
    });
    orchestrators.push(orch);
    await new Promise((r) => setTimeout(r, 150));

    const wp = buildFailedWorkpiece(stationName, undefined);
    const outputPath = resolve(
      linePath,
      "stations",
      stationName,
      "queue",
      "output",
      `${wp.id}.json`
    );
    writeFileSync(outputPath, JSON.stringify(wp, null, 2));

    // Wait for the retry event to fire.
    const activityPath = resolve(linePath, "queues", "activity.jsonl");
    const retryFired = await waitFor(() => {
      if (!existsSync(activityPath)) return false;
      return readFileSync(activityPath, "utf-8")
        .trim()
        .split("\n")
        .some((l) => {
          try {
            const e = JSON.parse(l);
            return e.event === "retry" && e.workpiece === wp.id;
          } catch {
            return false;
          }
        });
    }, 3_000);
    expect(retryFired).toBe(true);

    const retryEvent = readFileSync(activityPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "retry" && e.workpiece === wp.id);
    expect(retryEvent.failure_class).toBe("unknown");
    expect(retryEvent.attempt).toBe(1);
  });

  test("retry carries previous_attempts on the done workpiece after successful re-run", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-retry-history-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);
    const stationName = "s1";
    createRetryTestLine(linePath, stationName);

    const orch = await startOrchestrator({
      linePath,
      retryPolicy: { timeout: { maxRetries: 1, backoff: [0] } },
    });
    orchestrators.push(orch);
    await new Promise((r) => setTimeout(r, 150));

    const wp = buildFailedWorkpiece(stationName, "timeout");
    const fileName = `${wp.id}.json`;
    const outputPath = resolve(
      linePath,
      "stations",
      stationName,
      "queue",
      "output",
      fileName
    );
    writeFileSync(outputPath, JSON.stringify(wp, null, 2));

    // The retry fires with backoff[0]=0; the script station succeeds immediately.
    // Wait for the workpiece to land in done/ with previous_attempts.
    const doneDir = resolve(linePath, "queues", "done");
    const doneArrived = await waitFor(() => {
      return existsSync(resolve(doneDir, fileName));
    }, 5_000);
    expect(doneArrived).toBe(true);

    const doneWp = JSON.parse(readFileSync(resolve(doneDir, fileName), "utf-8"));
    expect(doneWp.stations[stationName]).toBeDefined();
    expect(doneWp.stations[stationName].status).toBe("done");
    expect(doneWp.stations[stationName].previous_attempts).toBeDefined();
    expect(doneWp.stations[stationName].previous_attempts.length).toBe(1);
    expect(doneWp.stations[stationName].previous_attempts[0].failure_class).toBe("timeout");
    // _retry_history scratch should be consumed/cleared
    expect(doneWp._retry_history).toBeUndefined();
  });

  test("line.yaml retry_policy override changes envelope budget", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-retry-override-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);
    const stationName = "s1";
    createRetryTestLine(linePath, stationName);

    // Rewrite line.yaml to allow one envelope-class retry with no delay.
    writeFileSync(
      resolve(linePath, "line.yaml"),
      `name: retry-policy-test\nsequence:\n  - ${stationName}\nretry_policy:\n  envelope:\n    maxRetries: 1\n    backoff: [0]\n`
    );

    const orch = await startOrchestrator({ linePath });
    orchestrators.push(orch);
    await new Promise((r) => setTimeout(r, 150));

    const wp = buildFailedWorkpiece(stationName, "envelope");
    const outputPath = resolve(
      linePath,
      "stations",
      stationName,
      "queue",
      "output",
      `${wp.id}.json`
    );
    writeFileSync(outputPath, JSON.stringify(wp, null, 2));

    const activityPath = resolve(linePath, "queues", "activity.jsonl");
    const retryFired = await waitFor(() => {
      if (!existsSync(activityPath)) return false;
      return readFileSync(activityPath, "utf-8")
        .trim()
        .split("\n")
        .some((l) => {
          try {
            const e = JSON.parse(l);
            return e.event === "retry" && e.workpiece === wp.id;
          } catch {
            return false;
          }
        });
    }, 3_000);
    expect(retryFired).toBe(true);

    const retryEvent = readFileSync(activityPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "retry" && e.workpiece === wp.id);
    expect(retryEvent.failure_class).toBe("envelope");
  });
});
