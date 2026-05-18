import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve, join } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { homedir } from "os";
import { startOrchestrator } from "../orchestrator";
import { createWorkpiece } from "../workpiece";
import { __resetUsageGateStateForTest } from "../usage";
import { recordEmit } from "../emit-manifest";

/**
 * Build a minimal line with one `script` station whose script sleeps long
 * enough that stop() can catch it mid-flight. The script writes nothing to
 * the workpiece, so the section-worker's SIGUSR2 handler must write an
 * `aborted` failure envelope.
 */
function createSleepLine(
  linePath: string,
  stationName: string,
  sleepSeconds: number
): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });

  writeFileSync(
    resolve(linePath, "line.yaml"),
    // flush_grace: 2 so the SIGKILL fallback fires fast if the handler fails.
    `name: shutdown-test\nflush_grace: 2\nsequence:\n  - ${stationName}\n`
  );

  const stationDir = resolve(linePath, "stations", stationName);
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(
    resolve(stationDir, "AGENT.md"),
    `---\nprovider: script\nscript: slow.ts\n---\n`
  );
  writeFileSync(
    resolve(stationDir, "slow.ts"),
    `await new Promise((r) => setTimeout(r, ${sleepSeconds * 1000}));\nconsole.log(JSON.stringify({ summary: "ok" }));\n`
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

const orchestrators: Array<{ stop: () => void | Promise<void> }> = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;

beforeEach(() => {
  const snapDir = resolve(
    "/tmp",
    `assembly-test-shutdown-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

describe("orchestrator graceful shutdown", () => {
  test(
    "stop() mid-flight: worker flushes an `aborted` failure to output/",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-shutdown-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      const stationName = "slow-station";
      createSleepLine(linePath, stationName, 30); // 30 s — guaranteed mid-flight

      const orch = await startOrchestrator({ linePath });
      // Don't push to orchestrators[]; we're calling stop() inside the test.

      // Drop a workpiece into the station inbox directly so the worker spawns
      // without waiting for the line-inbox → claim step. recordEmit is the
      // producer-allowlist contract for authorized inbox writes.
      const wp = createWorkpiece("shutdown-test", "abort me");
      const stationInboxDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "inbox"
      );
      const inboxPath = resolve(stationInboxDir, `${wp.id}.json`);
      recordEmit(stationInboxDir, `${wp.id}.json`, "recovery");
      writeFileSync(inboxPath, JSON.stringify(wp, null, 2));

      // Wait until the worker has claimed the file (file appears in processing/).
      const processingDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "processing"
      );
      const claimed = await waitFor(
        () => existsSync(processingDir) && readdirSync(processingDir).length > 0,
        5_000
      );
      expect(claimed).toBe(true);

      // Give the worker another moment to install its SIGUSR2 handler.
      await new Promise((r) => setTimeout(r, 300));

      // Call stop() — orchestrator sends SIGUSR2, waits flush_grace, then sweeps.
      await orch.stop();

      // The workpiece should now be in the station's output/ dir with an
      // `aborted` failure. Either the SIGUSR2 handler wrote it, or the sweep
      // did — both paths set failure_class: "aborted".
      const outputDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "output"
      );
      const outFiles = readdirSync(outputDir).filter((f) => f.endsWith(".json"));
      expect(outFiles.length).toBe(1);

      const outWp = JSON.parse(
        readFileSync(resolve(outputDir, outFiles[0]), "utf-8")
      );
      expect(outWp.id).toBe(wp.id);
      expect(outWp.stations[stationName]?.status).toBe("failed");
      expect(outWp.stations[stationName]?.failure_class).toBe("aborted");
      expect(outWp.stations[stationName]?.summary).toMatch(/aborted|daemon shutdown/i);

      // Activity log should NOT show an idle-timeout event for this shutdown —
      // the idle watchdog must short-circuit while isShuttingDown is set.
      const activityPath = resolve(linePath, "queues", "activity.jsonl");
      if (existsSync(activityPath)) {
        const events = readFileSync(activityPath, "utf-8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l));

        // Should see orchestrator_stop and either station_aborted or the
        // worker's own flush event, but NOT station_timeout.
        const timeoutEvents = events.filter(
          (e) => e.event === "station_timeout" && e.workpiece === wp.id
        );
        expect(timeoutEvents.length).toBe(0);

        const stopEvent = events.find((e) => e.event === "orchestrator_stop");
        expect(stopEvent).toBeDefined();
      }
    },
    20_000
  );

  test(
    "sweep writes `aborted` for processing/ file left behind after SIGKILL",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-shutdown-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      const stationName = "sweep-station";

      // Build the line with NO worker running — we seed processing/ directly,
      // then call stop() to exercise the post-kill sweep path deterministically.
      mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
      writeFileSync(
        resolve(linePath, "line.yaml"),
        `name: sweep-test\nsequence:\n  - ${stationName}\n`
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

      const orch = await startOrchestrator({ linePath });
      await new Promise((r) => setTimeout(r, 150));

      // Seed a workpiece directly in processing/ to simulate a worker that
      // died without flushing (e.g. SIGKILLed before its handler ran).
      const wp = createWorkpiece("sweep-test", "stranded");
      const processingDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "processing"
      );
      mkdirSync(processingDir, { recursive: true });
      const processingPath = resolve(processingDir, `${wp.id}.json`);
      writeFileSync(processingPath, JSON.stringify(wp, null, 2));

      // stop() should sweep processing/ and write an `aborted` failure.
      await orch.stop();

      const outputDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "output"
      );
      expect(existsSync(resolve(outputDir, `${wp.id}.json`))).toBe(true);
      expect(existsSync(processingPath)).toBe(false);

      const outWp = JSON.parse(
        readFileSync(resolve(outputDir, `${wp.id}.json`), "utf-8")
      );
      expect(outWp.stations[stationName]?.status).toBe("failed");
      expect(outWp.stations[stationName]?.failure_class).toBe("aborted");

      // And the sweep should have emitted station_aborted.
      const activityPath = resolve(linePath, "queues", "activity.jsonl");
      const events = readFileSync(activityPath, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
      const abortedEvent = events.find(
        (e) => e.event === "station_aborted" && e.workpiece === wp.id
      );
      expect(abortedEvent).toBeDefined();
      expect(abortedEvent.reason).toBe("daemon_shutdown");
    },
    15_000
  );

  test(
    "already-done processing/ file routes to output/ without overwriting",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-shutdown-done-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      const stationName = "done-station";

      mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
      writeFileSync(
        resolve(linePath, "line.yaml"),
        `name: done-test\nsequence:\n  - ${stationName}\n`
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

      const orch = await startOrchestrator({ linePath });
      await new Promise((r) => setTimeout(r, 150));

      // Seed a workpiece in processing/ that is already marked as done
      // (worker wrote the result but died before renaming to output).
      const wp = createWorkpiece("done-test", "finished");
      wp.stations[stationName] = {
        status: "done",
        summary: "already finished",
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:01Z",
        model: "script",
        tokens: { in: 0, out: 0 },
        cost_usd: 0,
      };
      const processingDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "processing"
      );
      mkdirSync(processingDir, { recursive: true });
      const processingPath = resolve(processingDir, `${wp.id}.json`);
      writeFileSync(processingPath, JSON.stringify(wp, null, 2));

      await orch.stop();

      const outputDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "output"
      );
      const outPath = resolve(outputDir, `${wp.id}.json`);
      expect(existsSync(outPath)).toBe(true);

      // The sweep must NOT overwrite a completed result with aborted.
      const outWp = JSON.parse(readFileSync(outPath, "utf-8"));
      expect(outWp.stations[stationName]?.status).toBe("done");
      expect(outWp.stations[stationName]?.summary).toBe("already finished");
      expect(outWp.stations[stationName]?.failure_class).toBeUndefined();
    },
    10_000
  );

  // Regression: a test daemon (or any second daemon) that accidentally
  // discovers a production line via inherited ASSEMBLY_LINE_DIRS used to
  // write an `aborted` envelope to the live worker's processing/ file at
  // shutdown — corrupting the real workpiece and triggering a duplicate
  // worker spawn. The sweep must respect cross-daemon liveness: if a
  // section-worker.ts process anywhere on the host is holding the file
  // open (matched via /proc cmdline), the sweep skips it. The live worker
  // moves the file out itself when it finishes.
  test.skipIf(process.platform !== "linux")(
    "sweep skips processing/ file held by an external live worker",
    async () => {
      const linePath = resolve(
        "/tmp",
        `assembly-test-shutdown-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      tempDirs.push(linePath);
      const stationName = "skip-station";

      mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
      writeFileSync(
        resolve(linePath, "line.yaml"),
        `name: skip-test\nsequence:\n  - ${stationName}\n`
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

      const orch = await startOrchestrator({ linePath });
      await new Promise((r) => setTimeout(r, 150));

      // Seed a workpiece in processing/ — pretend it's owned by some OTHER
      // daemon's worker on the same line (a test daemon spawned with
      // production ASSEMBLY_LINE_DIRS leaked into env).
      const wp = createWorkpiece("skip-test", "do not abort me");
      const processingDir = resolve(
        linePath,
        "stations",
        stationName,
        "queue",
        "processing"
      );
      mkdirSync(processingDir, { recursive: true });
      const processingPath = resolve(processingDir, `${wp.id}.json`);
      writeFileSync(processingPath, JSON.stringify(wp, null, 2));

      // Spawn a decoy section-worker.ts that "holds" the file (its argv
      // contains both "section-worker.ts" and the processing path, so
      // findWorkerForWorkpiece treats it as alive).
      const decoyDir = resolve(linePath, "decoy");
      mkdirSync(decoyDir, { recursive: true });
      const decoyScript = resolve(decoyDir, "section-worker.ts");
      writeFileSync(decoyScript, `await new Promise(() => {});\n`);
      const decoy = Bun.spawn(["bun", "run", decoyScript, processingPath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const decoyPid = decoy.pid!;
      try {
        // Let /proc/<pid>/cmdline populate.
        await new Promise((r) => setTimeout(r, 200));

        await orch.stop();

        // The processing/ file must be untouched. No output/ write, no
        // overwrite of the workpiece JSON.
        expect(existsSync(processingPath)).toBe(true);
        const stillWp = JSON.parse(readFileSync(processingPath, "utf-8"));
        expect(stillWp.id).toBe(wp.id);
        expect(stillWp.stations[stationName]).toBeUndefined();

        const outPath = resolve(
          linePath,
          "stations",
          stationName,
          "queue",
          "output",
          `${wp.id}.json`
        );
        expect(existsSync(outPath)).toBe(false);

        // Activity log shows shutdown_sweep_skip, not station_aborted, for
        // this workpiece.
        const activityPath = resolve(linePath, "queues", "activity.jsonl");
        const events = readFileSync(activityPath, "utf-8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l));
        const skip = events.find(
          (e) => e.event === "shutdown_sweep_skip" && e.workpiece === wp.id
        );
        expect(skip).toBeDefined();
        expect(skip.reason).toBe("worker_still_alive");
        expect(skip.pid).toBe(decoyPid);

        const aborted = events.find(
          (e) => e.event === "station_aborted" && e.workpiece === wp.id
        );
        expect(aborted).toBeUndefined();
      } finally {
        try { process.kill(decoyPid, "SIGKILL"); } catch {}
      }
    },
    10_000
  );
});
