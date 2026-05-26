import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "fs";
import {
  findWorkerForWorkpiece,
  recoverStaleProcessing,
  type SectionInfo,
} from "../orchestrator";
import { initSectionQueue } from "../queue";
import { createWorkpiece } from "../workpiece";
import { LineName, StationName } from '../ids';

// Only runs on Linux — /proc scanning is the liveness signal. On other
// platforms findWorkerForWorkpiece returns null by design (fall-through to
// normal requeue), which is tested indirectly by the existing stale-recovery
// suite.
const isLinux = process.platform === "linux";

const TEMP_DIR = resolve(
  "/tmp",
  `assembly-test-orch-stale-recovery-${Date.now()}`
);

function createTestSection(name: string, subDir: string): SectionInfo {
  const base = resolve(TEMP_DIR, subDir);
  const dir = resolve(base, "stations", name);
  mkdirSync(dir, { recursive: true });
  const queue = initSectionQueue(dir);
  return { name, dir, queue };
}

function createLog() {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  return {
    log: (event: string, detail: Record<string, unknown>) =>
      events.push({ event, detail }),
    events,
  };
}

/**
 * Spawn a decoy process whose argv contains both "section-worker.ts" and the
 * given workpiece path, so findWorkerForWorkpiece() picks it up as a live
 * worker. The decoy just sleeps; the caller must kill it in cleanup.
 */
function spawnDecoyWorker(workpiecePath: string): { pid: number; kill: () => void } {
  // Create a stub named section-worker.ts that simply blocks — the cmdline
  // seen by /proc will be:
  //   bun\0run\0/tmp/.../section-worker.ts\0<workpiecePath>\0
  const decoyDir = resolve(TEMP_DIR, `decoy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(decoyDir, { recursive: true });
  const decoyScript = resolve(decoyDir, "section-worker.ts");
  writeFileSync(
    decoyScript,
    `// Decoy worker — blocks on stdin so it stays alive until killed.
await new Promise(() => {});
`
  );
  const proc = Bun.spawn(["bun", "run", decoyScript, workpiecePath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    pid: proc.pid!,
    kill: () => {
      try { process.kill(proc.pid!, "SIGKILL"); } catch {}
    },
  };
}

beforeEach(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
});

describe.skipIf(!isLinux)("findWorkerForWorkpiece()", () => {
  test("returns a pid when a matching section-worker process is alive", async () => {
    const wpPath = resolve(TEMP_DIR, `wp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(wpPath, "{}");

    const decoy = spawnDecoyWorker(wpPath);
    try {
      // Give Linux a beat to populate /proc/<pid>/cmdline.
      await new Promise((r) => setTimeout(r, 150));

      const found = findWorkerForWorkpiece(wpPath);
      expect(found).toBe(decoy.pid);
    } finally {
      decoy.kill();
    }
  });

  test("returns null when no matching process exists", () => {
    const wpPath = resolve(TEMP_DIR, `nomatch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    expect(findWorkerForWorkpiece(wpPath)).toBeNull();
  });
});

describe.skipIf(!isLinux)("recoverStaleProcessing() liveness check", () => {
  test(
    "skips requeue when an old daemon's worker is still alive",
    async () => {
      const section = createTestSection("s1", `live-${Date.now()}`);
      const errorDir = resolve(TEMP_DIR, `live-error-${Date.now()}`);
      mkdirSync(errorDir, { recursive: true });
      const { log, events } = createLog();

      // Seed a workpiece in processing/ with NO station result (so normal
      // recovery would requeue).
      const wp = createWorkpiece(LineName("stale-test"), "still running");
      const processingPath = resolve(section.queue.processing, `${wp.id}.json`);
      writeFileSync(processingPath, JSON.stringify(wp, null, 2));

      const decoy = spawnDecoyWorker(processingPath);
      try {
        await new Promise((r) => setTimeout(r, 150));

        const result = await recoverStaleProcessing([section], errorDir, log);

        // The file must be left alone — live worker still holds it.
        expect(existsSync(processingPath)).toBe(true);
        expect(existsSync(resolve(section.queue.inbox, `${wp.id}.json`))).toBe(false);

        // Logged as skip, not as normal requeue.
        const skip = events.find((e) => e.event === "stale_recovery_skip");
        expect(skip).toBeDefined();
        expect(skip!.detail.workpiece).toBe(wp.id);
        expect(skip!.detail.reason).toBe("worker_still_alive");
        expect(skip!.detail.pid).toBe(decoy.pid);

        // Counted as recovered (handed off to the live worker, not an error).
        expect(result.recovered).toBe(1);
        expect(result.errors).toBe(0);
      } finally {
        decoy.kill();
      }
    },
    10_000
  );

  test(
    "requeues to inbox when no live worker is holding the file",
    async () => {
      const section = createTestSection("s2", `dead-${Date.now()}`);
      const errorDir = resolve(TEMP_DIR, `dead-error-${Date.now()}`);
      mkdirSync(errorDir, { recursive: true });
      const { log, events } = createLog();

      const wp = createWorkpiece(LineName("stale-test"), "dead worker");
      const processingPath = resolve(section.queue.processing, `${wp.id}.json`);
      writeFileSync(processingPath, JSON.stringify(wp, null, 2));

      const result = await recoverStaleProcessing([section], errorDir, log);

      // Normal requeue path — file moved to inbox, no skip event.
      expect(existsSync(processingPath)).toBe(false);
      expect(existsSync(resolve(section.queue.inbox, `${wp.id}.json`))).toBe(true);

      const skip = events.find((e) => e.event === "stale_recovery_skip");
      expect(skip).toBeUndefined();

      const normal = events.find(
        (e) => e.event === "stale_recovery" && e.detail.action === "requeued_to_inbox"
      );
      expect(normal).toBeDefined();
      expect(result).toEqual({ recovered: 1, errors: 0 });
    },
    5_000
  );

  test(
    "done workpiece in processing/ skips liveness check and routes to output",
    async () => {
      // The liveness check is only for non-done results; done routes directly
      // to output without checking /proc. A live worker is irrelevant for
      // already-completed workpieces.
      const section = createTestSection("s3", `done-${Date.now()}`);
      const errorDir = resolve(TEMP_DIR, `done-error-${Date.now()}`);
      mkdirSync(errorDir, { recursive: true });
      const { log, events } = createLog();

      const wp = createWorkpiece(LineName("stale-test"), "was done");
      wp.stations[StationName("s3")] = {
        status: "done",
        summary: "finished",
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:01Z",
        model: "test",
        tokens: { in: 0, out: 0 },
        cost_usd: 0,
      };
      const processingPath = resolve(section.queue.processing, `${wp.id}.json`);
      writeFileSync(processingPath, JSON.stringify(wp, null, 2));

      // Even with a decoy matching the path, done path takes precedence.
      const decoy = spawnDecoyWorker(processingPath);
      try {
        await new Promise((r) => setTimeout(r, 150));

        await recoverStaleProcessing([section], errorDir, log);

        expect(existsSync(processingPath)).toBe(false);
        expect(existsSync(resolve(section.queue.output, `${wp.id}.json`))).toBe(true);
        const routed = events.find(
          (e) => e.event === "stale_recovery" && e.detail.action === "routed_to_output"
        );
        expect(routed).toBeDefined();
        const skip = events.find((e) => e.event === "stale_recovery_skip");
        expect(skip).toBeUndefined();
      } finally {
        decoy.kill();
      }
    },
    10_000
  );
});
