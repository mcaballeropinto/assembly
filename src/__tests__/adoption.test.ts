import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import {
  startOrchestrator,
  type OrchestratorHandle,
} from "../orchestrator";
import { createWorkpiece } from "../workpiece";
import {
  HANDOFF_VERSION,
  type HandoffState,
  type HandoffWorker,
} from "../handoff";
import { __resetUsageGateStateForTest } from "../usage";
import { LineName } from '../ids';

// Disable usage gate. Mirrors orchestrator-shutdown.test.ts pattern.
const originalFetch = globalThis.fetch;
const orchestrators: OrchestratorHandle[] = [];
const tempDirs: string[] = [];
const sleepingWorkers: number[] = [];

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  expect(predicate()).toBe(true);
}

beforeEach(() => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : String(url);
    if (urlStr.includes("/api/oauth/usage")) {
      return new Response(JSON.stringify({
        five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(url as any);
  }) as typeof fetch;
  __resetUsageGateStateForTest();
});

afterEach(async () => {
  for (const o of orchestrators.splice(0)) {
    try { await o.stop({ handoff: true }); } catch {}
  }
  // Kill any externally-spawned sleeping workers from these tests so the
  // bun test runner can exit.
  for (const pid of sleepingWorkers.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await new Promise((r) => setTimeout(r, 100));
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  globalThis.fetch = originalFetch;
  __resetUsageGateStateForTest();
});

/**
 * Build a minimal line + spawn a long-running section-worker subprocess
 * directly (without involving an orchestrator). Returns the metadata that
 * a handoff file would contain for that worker.
 */
async function spawnDetachedWorker(opts: {
  linePath: string;
  stationName: string;
  sleepSeconds: number;
}): Promise<HandoffWorker> {
  const { linePath, stationName, sleepSeconds } = opts;
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: adoption-test\nflush_grace: 2\nsequence:\n  - ${stationName}\n`
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

  const wp = createWorkpiece(LineName("adoption-test"), "adopt me");
  const processingDir = resolve(stationDir, "queue", "processing");
  mkdirSync(processingDir, { recursive: true });
  const processingPath = resolve(processingDir, `${wp.id}.json`);
  writeFileSync(processingPath, JSON.stringify(wp, null, 2));
  // Pre-create the stderr sidecar with some bytes so the adoption tail has
  // something to read (mirrors the file Bun.spawn would have written).
  writeFileSync(processingPath + ".stderr.log", "[predecessor captured this]\n");

  // Spawn the worker directly. Use the same code path as the orchestrator
  // (detached, own process group) so adopting it exercises the real flow.
  const workerPath = resolve(__dirname, "..", "section-worker.ts");
  const fd = require("fs").openSync(processingPath + ".stderr.log", "a");
  const proc = Bun.spawn(["bun", "run", workerPath, stationDir, processingPath], {
    stdout: "pipe",
    stderr: fd,
    env: { ...process.env },
    cwd: resolve(linePath, ".."),
    detached: true,
  });
  try { require("fs").closeSync(fd); } catch {}

  // Wait for the worker to actually start (small grace so the kernel
  // installs its sleep timer and SIGUSR2 handler).
  await new Promise((r) => setTimeout(r, 400));

  return {
    pid: proc.pid!,
    pgid: proc.pid!,
    line_path: linePath,
    line_name: "adoption-test",
    section_name: stationName,
    section_dir: stationDir,
    processing_path: processingPath,
    workpiece_id: wp.id,
    started_at: new Date().toISOString(),
    flush_grace_s: 2,
    stderr_sidecar: processingPath + ".stderr.log",
  };
}

describe("worker adoption", () => {
  test("adoption registers worker in activeWorkerHandles and preserves processing/ file", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-adopt-basic-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);

    const handoffWorker = await spawnDetachedWorker({
      linePath,
      stationName: "slow",
      sleepSeconds: 30,
    });
    sleepingWorkers.push(handoffWorker.pid);

    const state: HandoffState = {
      version: HANDOFF_VERSION,
      old_pid: 99999, // anything — we're not coordinating with a real predecessor
      handoff_started_at: new Date().toISOString(),
      workers: [handoffWorker],
      lines: [{
        line_path: linePath,
        line_name: "adoption-test",
        retry_counts: { [`${handoffWorker.workpiece_id}:slow`]: 1 },
        usage_paused: false,
      }],
    };

    const orch = await startOrchestrator({ linePath, handoffState: state });
    orchestrators.push(orch);

    // Worker should still be in processing/.
    expect(existsSync(handoffWorker.processing_path)).toBe(true);

    // Snapshot the new orchestrator's handle should include the adopted worker.
    const snap = orch.getHandoffSnapshot();
    expect(snap.workers.length).toBe(1);
    expect(snap.workers[0].pid).toBe(handoffWorker.pid);
    // Retry counts carried over.
    expect(snap.line.retry_counts[`${handoffWorker.workpiece_id}:slow`]).toBe(1);

    // Known-pids exposed for reaper safety.
    const known = orch.getKnownWorkerPids();
    expect(known.has(handoffWorker.pid)).toBe(true);

    // Adoption appends a marker line to the stderr sidecar so post-mortem
    // shows where the handoff happened.
    const sidecarBody = readFileSync(handoffWorker.stderr_sidecar, "utf-8");
    expect(sidecarBody).toContain("adopted by daemon");
  }, 20_000);

  test("adoption skips dead pid entries — falls through to standard stale recovery", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-adopt-dead-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);

    // Build the line with the station but no live worker.
    mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
    writeFileSync(
      resolve(linePath, "line.yaml"),
      `name: adoption-dead-test\nsequence:\n  - work\n`
    );
    const stationDir = resolve(linePath, "stations", "work");
    mkdirSync(stationDir, { recursive: true });
    writeFileSync(resolve(stationDir, "AGENT.md"), `---\nprovider: script\nscript: ok.ts\n---\n`);
    writeFileSync(resolve(stationDir, "ok.ts"), `console.log(JSON.stringify({summary:"ok"}));\n`);

    const wp = createWorkpiece(LineName("adoption-dead-test"), "stranded");
    const processingDir = resolve(stationDir, "queue", "processing");
    mkdirSync(processingDir, { recursive: true });
    const processingPath = resolve(processingDir, `${wp.id}.json`);
    writeFileSync(processingPath, JSON.stringify(wp, null, 2));

    const deadState: HandoffState = {
      version: HANDOFF_VERSION,
      old_pid: 99998,
      handoff_started_at: new Date().toISOString(),
      // A pid that's almost certainly dead.
      workers: [{
        pid: 2147483647,
        pgid: 2147483647,
        line_path: linePath,
        line_name: "adoption-dead-test",
        section_name: "work",
        section_dir: stationDir,
        processing_path: processingPath,
        workpiece_id: wp.id,
        started_at: "2026-05-13T00:00:00Z",
        flush_grace_s: 30,
        stderr_sidecar: processingPath + ".stderr.log",
      }],
      lines: [],
    };

    const orch = await startOrchestrator({ linePath, handoffState: deadState });
    orchestrators.push(orch);

    // No live worker → activeWorkerHandles empty → known pids empty.
    expect(orch.getKnownWorkerPids().size).toBe(0);

    // Standard recovery picks up the orphaned processing/ file, requeues it to
    // inbox, and drainInbox spawns the script worker. Under full-suite load this
    // can take longer than a fixed sleep, so poll for the terminal state.
    const doneDir = resolve(linePath, "queues", "done");
    await waitFor(
      () => readdirSync(doneDir).filter((f) => f.endsWith(".json")).length === 1,
      20_000
    );
  }, 30_000);
});
