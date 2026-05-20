import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, rmSync } from "fs";
import {
  HANDOFF_VERSION,
  handoffPathForPid,
  writeHandoffState,
  findLatestHandoff,
  consumeHandoffState,
  isPidAlive,
  type HandoffState,
} from "../handoff";
import { ASSEMBLY_HOME } from "../paths";

// `ASSEMBLY_HOME` is pinned to /tmp/assembly-test-home-<pid> by the preload at
// src/__tests__/setup.ts (configured in bunfig.toml). We clear handoff-*.json
// files between tests so order doesn't matter; the directory itself is shared
// across tests in this file and across all test files in this process.
function clearHandoffFiles() {
  if (!existsSync(ASSEMBLY_HOME)) return;
  for (const f of readdirSync(ASSEMBLY_HOME)) {
    if (f.startsWith("handoff-") && f.endsWith(".json")) {
      try { unlinkSync(resolve(ASSEMBLY_HOME, f)); } catch {}
    }
  }
}

beforeEach(() => {
  clearHandoffFiles();
});

afterEach(() => {
  clearHandoffFiles();
});

function makeState(pid: number, extra: Partial<HandoffState> = {}): HandoffState {
  return {
    version: HANDOFF_VERSION,
    old_pid: pid,
    handoff_started_at: new Date().toISOString(),
    workers: [],
    lines: [],
    ...extra,
  };
}

describe("handoff state file", () => {
  test("writeHandoffState round-trips through findLatestHandoff", () => {
    const state = makeState(12345, {
      workers: [{
        pid: 99999,
        pgid: 99999,
        line_path: "/tmp/some-line",
        line_name: "demo",
        section_name: "step1",
        section_dir: "/tmp/some-line/stations/step1",
        processing_path: "/tmp/some-line/stations/step1/queue/processing/task-1.json",
        workpiece_id: "wp-abc",
        started_at: "2026-05-13T00:00:00Z",
        flush_grace_s: 30,
        stderr_sidecar: "/tmp/some-line/stations/step1/queue/processing/task-1.json.stderr.log",
      }],
      lines: [{
        line_path: "/tmp/some-line",
        line_name: "demo",
        retry_counts: { "wp-abc:step1": 1 },
        usage_paused: false,
      }],
    });
    writeHandoffState(state);

    const loaded = findLatestHandoff();
    expect(loaded).not.toBeNull();
    expect(loaded!.state.old_pid).toBe(12345);
    expect(loaded!.state.workers.length).toBe(1);
    expect(loaded!.state.workers[0].pid).toBe(99999);
    expect(loaded!.state.lines[0].retry_counts["wp-abc:step1"]).toBe(1);
  });

  test("findLatestHandoff picks the newest file when multiple exist", async () => {
    writeHandoffState(makeState(111));
    // small sleep to give mtime resolution
    await new Promise((r) => setTimeout(r, 30));
    writeHandoffState(makeState(222));
    const loaded = findLatestHandoff();
    expect(loaded!.state.old_pid).toBe(222);
  });

  test("findLatestHandoff rejects unknown version", () => {
    const path = handoffPathForPid(333);
    // Hand-write an unknown version so we don't accidentally invoke the
    // version-bump path.
    writeFileSync(path, JSON.stringify({ version: 999, old_pid: 333, workers: [], lines: [] }));
    expect(findLatestHandoff()).toBeNull();
  });

  test("consumeHandoffState removes the file", () => {
    const path = writeHandoffState(makeState(444));
    expect(existsSync(path)).toBe(true);
    consumeHandoffState(path);
    expect(existsSync(path)).toBe(false);
  });

  test("isPidAlive returns true for our own pid, false for pid 1 and a definitely-dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // pid 1 is init — treated as not-adoptable by isPidAlive guard.
    expect(isPidAlive(1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    // A pid that's almost certainly unused. If by cosmic luck this is in use,
    // we re-roll once.
    let dead = 2147483647;
    if (isPidAlive(dead)) dead = 2147483646;
    expect(isPidAlive(dead)).toBe(false);
  });
});

describe("orchestrator stop({ handoff: true })", () => {
  test("does NOT signal workers and does NOT sweep processing/", async () => {
    // Build a tiny line with a script provider that sleeps long enough to
    // still be running when we call stop({ handoff: true }). Then verify:
    //   1. The worker process is still alive after stop returns.
    //   2. processing/ still contains the workpiece (no aborted sweep).
    const linePath = resolve(
      "/tmp",
      `assembly-test-handoff-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    try {
      mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
      mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
      writeFileSync(
        resolve(linePath, "line.yaml"),
        `name: handoff-stop-test\nflush_grace: 2\nsequence:\n  - slow\n`
      );
      const stationDir = resolve(linePath, "stations", "slow");
      mkdirSync(stationDir, { recursive: true });
      writeFileSync(
        resolve(stationDir, "AGENT.md"),
        `---\nprovider: script\nscript: slow.ts\n---\n`
      );
      writeFileSync(
        resolve(stationDir, "slow.ts"),
        `await new Promise((r) => setTimeout(r, 20_000));\nconsole.log(JSON.stringify({ summary: "ok" }));\n`
      );

      // Disable usage gate by mocking fetch (mirrors orchestrator-shutdown.test.ts).
      const originalFetch = globalThis.fetch;
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

      try {
        const { __resetUsageGateStateForTest } = await import("../usage");
        __resetUsageGateStateForTest();
        const { startOrchestrator } = await import("../orchestrator");
        const { createWorkpiece } = await import("../workpiece");
        const { recordEmit } = await import("../emit-manifest");

        const orch = await startOrchestrator({ linePath });
        const wp = createWorkpiece("handoff-stop-test", "long-running");
        const stationInbox = resolve(stationDir, "queue", "inbox");
        recordEmit(stationInbox, `${wp.id}.json`, "recovery");
        writeFileSync(resolve(stationInbox, `${wp.id}.json`), JSON.stringify(wp));

        // Wait for the worker to start (file appears in processing/).
        const processingDir = resolve(stationDir, "queue", "processing");
        const start = Date.now();
        while (Date.now() - start < 5_000) {
          if (existsSync(processingDir) &&
              require("fs").readdirSync(processingDir).filter((f: string) => f.endsWith(".json")).length > 0) {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        const snapshot = orch.getHandoffSnapshot();
        expect(snapshot.workers.length).toBe(1);
        const workerPid = snapshot.workers[0].pid;
        expect(workerPid).toBeGreaterThan(1);

        // Handoff stop — should NOT kill the worker.
        await orch.stop({ handoff: true });

        // Worker should still be alive.
        let alive = true;
        try { process.kill(workerPid, 0); } catch { alive = false; }
        expect(alive).toBe(true);

        // processing/ should still contain the workpiece (no sweep).
        const remaining = require("fs").readdirSync(processingDir)
          .filter((f: string) => f.endsWith(".json"));
        expect(remaining.length).toBe(1);

        // Clean up: now kill the worker by its pgid so the test exits.
        try { process.kill(-workerPid, "SIGKILL"); } catch {}
        // Wait briefly so the worker is reaped before tear-down.
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      try { rmSync(linePath, { recursive: true, force: true }); } catch {}
    }
  }, 30_000);
});
