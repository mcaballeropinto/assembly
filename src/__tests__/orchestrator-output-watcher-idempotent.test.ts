import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "fs";
import { homedir } from "os";
import { startOrchestrator } from "../orchestrator";
import { createWorkpiece, failStation } from "../workpiece";
import type { FailureClass, Workpiece } from "../types";
import { __resetUsageGateStateForTest } from "../usage";

/**
 * Build a minimal line with a `script` station that succeeds trivially. The
 * station is never actually executed — we drop pre-failed workpieces straight
 * into the station's output/ dir to trigger the watcher.
 */
function createScriptLine(linePath: string, stationName: string): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });

  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: idempotent-test\nsequence:\n  - ${stationName}\n`
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
  failureClass: FailureClass
): Workpiece {
  const wp = createWorkpiece("idempotent-test", "boom");
  return failStation(
    wp,
    stationName,
    `seeded ${failureClass} failure`,
    {
      model: "test:test",
      tokens: { in: 0, out: 0 },
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z",
    },
    failureClass
  );
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

function readActivity(linePath: string): Array<Record<string, unknown>> {
  const activityPath = resolve(linePath, "queues", "activity.jsonl");
  if (!existsSync(activityPath)) return [];
  return readFileSync(activityPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

const orchestrators: Array<{ stop: () => void | Promise<void> }> = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;

beforeEach(() => {
  const snapDir = resolve(
    "/tmp",
    `assembly-test-idempotent-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(snapDir, { recursive: true });
  tempDirs.push(snapDir);
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = resolve(snapDir, "usage-status.json");

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
  if (originalSnapEnv === undefined) delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
  else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalSnapEnv;
  __resetUsageGateStateForTest();
});

describe("output-watcher idempotency", () => {
  test(
    "rescan firing over a still-pending retry produces duplicate_ignored, not a phantom error_bucket",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-idempotent-rescan-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      const stationName = "s1";
      createScriptLine(linePath, stationName);

      // Retry backoff must be LONGER than the watchFolder rescan interval
      // (default 10 s) so the source file is still in output/ when rescan
      // fires. That's the realistic race — inotify + rescan both point at
      // the same workpiece with the same mtime.
      const orch = await startOrchestrator({
        linePath,
        retryPolicy: {
          unknown: { maxRetries: 1, backoff: [15] },
        },
      });
      orchestrators.push(orch);
      await new Promise((r) => setTimeout(r, 150));

      const wp = buildFailedWorkpiece(stationName, "unknown");
      const outputPath = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "output",
        `${wp.id}.json`
      );
      writeFileSync(outputPath, JSON.stringify(wp, null, 2));

      // Wait for initial retry event to be logged.
      const gotRetry = await waitFor(() => {
        return readActivity(linePath).some(
          (e) => e.event === "retry" && e.workpiece === wp.id
        );
      }, 5_000);
      expect(gotRetry).toBe(true);

      // Now wait long enough for the 10 s rescan to fire while the setTimeout
      // for retry is still pending. The dedup guard must short-circuit the
      // second handler run.
      const gotDuplicate = await waitFor(() => {
        return readActivity(linePath).some(
          (e) =>
            e.event === "output_watcher_duplicate_ignored" &&
            e.workpiece === wp.id
        );
      }, 13_000);
      expect(gotDuplicate).toBe(true);

      // Crucially: only ONE retry event, and NO error_bucket event. Pre-fix
      // the rescan would re-increment the counter and push the workpiece
      // straight to the error bucket.
      const events = readActivity(linePath);
      const retries = events.filter(
        (e) => e.event === "retry" && e.workpiece === wp.id
      );
      expect(retries.length).toBe(1);
      const buckets = events.filter(
        (e) => e.event === "error_bucket" && e.workpiece === wp.id
      );
      expect(buckets.length).toBe(0);
    },
    20_000
  );

  test(
    "a truly new write (different mtime) is processed as a fresh event",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-idempotent-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      const stationName = "s1";
      createScriptLine(linePath, stationName);

      // Override envelope to zero retries so failures route to error/
      // synchronously — no setTimeout window to complicate the check.
      // DEFAULT_RETRY_POLICY.envelope is {maxRetries:1} which would retry
      // first and break the timing assumptions below.
      const orch = await startOrchestrator({
        linePath,
        retryPolicy: {
          envelope: { maxRetries: 0, backoff: [] },
        },
      });
      orchestrators.push(orch);
      await new Promise((r) => setTimeout(r, 150));

      // Drop a zero-retry envelope failure → routes to error/ on first watcher fire.
      const wp1 = buildFailedWorkpiece(stationName, "envelope");
      const outputDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "output"
      );
      writeFileSync(
        resolve(outputDir, `${wp1.id}.json`),
        JSON.stringify(wp1, null, 2)
      );

      const errorDir = resolve(linePath, "queues", "error");
      const first = await waitFor(
        () => readdirSync(errorDir).some((f) => f === `${wp1.id}.json`),
        3_000
      );
      expect(first).toBe(true);

      // A completely different workpiece: different id, different mtime — the
      // dedup map must not block it.
      const wp2 = buildFailedWorkpiece(stationName, "envelope");
      // Delay so the second file's mtime differs from the first on systems
      // with coarse mtime resolution.
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(
        resolve(outputDir, `${wp2.id}.json`),
        JSON.stringify(wp2, null, 2)
      );

      const second = await waitFor(
        () => readdirSync(errorDir).some((f) => f === `${wp2.id}.json`),
        3_000
      );
      expect(second).toBe(true);

      // Both should have produced exactly one error_bucket event each.
      const events = readActivity(linePath);
      const buckets = events.filter((e) => e.event === "error_bucket");
      expect(buckets.length).toBe(2);
      expect(buckets.some((e) => e.workpiece === wp1.id)).toBe(true);
      expect(buckets.some((e) => e.workpiece === wp2.id)).toBe(true);

      // No duplicate_ignored — these are genuinely distinct events.
      const dups = events.filter(
        (e) => e.event === "output_watcher_duplicate_ignored"
      );
      expect(dups.length).toBe(0);
    },
    10_000
  );
});
