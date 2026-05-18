/**
 * Integration tests: section-worker emits task-events for a script-provider station.
 *
 * Spawns the real section-worker binary (via `bun run`) with a script provider
 * station so the test does not require the `claude` CLI. Verifies that the
 * task-events directory is created, that lifecycle events are emitted in the
 * right order, and that index.json is written on station completion.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve, basename } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { readTaskEvents, listTaskEventStations } from "../task-events";
import { startHeartbeat } from "../section-worker";

const TEMP_DIR = resolve("/tmp", `assembly-test-sw-te-${Date.now()}`);
const WORKER_PATH = resolve(import.meta.dir, "../section-worker.ts");

// ─── Helpers ────────────────────────────────────────────────────────

function createLine(name: string): string {
  const lineDir = resolve(TEMP_DIR, name);
  mkdirSync(resolve(lineDir, "queues"), { recursive: true });
  writeFileSync(
    resolve(lineDir, "line.yaml"),
    `name: ${name}\nsequence:\n  - s1\n`
  );
  return lineDir;
}

function createScriptStation(lineDir: string, stationName: string, scriptContent: string): string {
  const stationDir = resolve(lineDir, "stations", stationName);
  mkdirSync(resolve(stationDir, "queue", "processing"), { recursive: true });
  mkdirSync(resolve(stationDir, "queue", "output"), { recursive: true });

  writeFileSync(
    resolve(stationDir, "AGENT.md"),
    `---\nprovider: script\nscript: script.ts\n---\nTest station\n`
  );
  writeFileSync(resolve(stationDir, "script.ts"), scriptContent, { mode: 0o755 });
  return stationDir;
}

function createWorkpiece(stationDir: string, wpId: string): string {
  const wp = {
    id: wpId,
    line: "test-line",
    task: "test task",
    input: {},
    stations: {},
  };
  const wpPath = resolve(stationDir, "queue", "processing", `${wpId}.json`);
  writeFileSync(wpPath, JSON.stringify(wp));
  return wpPath;
}

async function runWorker(
  stationDir: string,
  wpPath: string,
  timeoutMs: number = 10000
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["bun", "run", WORKER_PATH, stationDir, wpPath],
    { stdout: "pipe", stderr: "pipe", env: process.env }
  );

  const timeoutHandle = setTimeout(() => proc.kill(), timeoutMs);
  const code = await proc.exited;
  clearTimeout(timeoutHandle);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

// ─── Setup / teardown ───────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
});

// ─── Integration tests ──────────────────────────────────────────────

describe("section-worker task-events integration (script provider)", () => {
  test("successful station emits lifecycle started + finished and writes index.json", async () => {
    const lineDir = createLine(`sw-te-success-${Date.now()}`);
    const stationDir = createScriptStation(lineDir, "s1",
      `console.log(JSON.stringify({ summary: "all done", content: "output" }));`
    );
    const wpId = `wp-te-${Date.now()}`;
    const wpPath = createWorkpiece(stationDir, wpId);

    const { code } = await runWorker(stationDir, wpPath);
    expect(code).toBe(0);

    // task-events directory must exist
    const teDir = resolve(lineDir, "queues", "task-events", wpId);
    expect(existsSync(teDir)).toBe(true);

    // events file must have lifecycle started + finished
    const page = readTaskEvents(lineDir, wpId, "s1");
    expect(page.events.length).toBeGreaterThanOrEqual(2);

    const kinds = page.events.map((e) => `${e.kind}:${e.detail && typeof e.detail === "object" && "subtype" in e.detail ? (e.detail as any).subtype : ""}`);
    expect(kinds).toContain("lifecycle:started");
    expect(kinds).toContain("lifecycle:finished");

    // first event must be lifecycle:started, last must be lifecycle:finished
    const first = page.events[0];
    expect(first.kind).toBe("lifecycle");
    expect((first.detail as any)?.subtype).toBe("started");

    const last = page.events[page.events.length - 1];
    expect(last.kind).toBe("lifecycle");
    expect((last.detail as any)?.subtype).toBe("finished");

    // index.json must exist with status ok
    const stations = listTaskEventStations(lineDir, wpId);
    expect(stations.length).toBe(1);
    expect(stations[0].name).toBe("s1");
    expect(stations[0].status).toBe("ok");
    expect(stations[0].finished_at).toBeTruthy();
  }, 15000);

  test("failed station emits lifecycle started + failed and marks index status error", async () => {
    const lineDir = createLine(`sw-te-fail-${Date.now()}`);
    const stationDir = createScriptStation(lineDir, "s1",
      `process.exit(1);`
    );
    const wpId = `wp-te-fail-${Date.now()}`;
    const wpPath = createWorkpiece(stationDir, wpId);

    const { code } = await runWorker(stationDir, wpPath);
    expect(code).toBe(1);

    const page = readTaskEvents(lineDir, wpId, "s1");
    expect(page.events.length).toBeGreaterThanOrEqual(2);

    const first = page.events[0];
    expect(first.kind).toBe("lifecycle");
    expect((first.detail as any)?.subtype).toBe("started");

    const last = page.events[page.events.length - 1];
    expect(last.kind).toBe("lifecycle");
    expect((last.detail as any)?.subtype).toBe("failed");

    const stations = listTaskEventStations(lineDir, wpId);
    expect(stations[0].status).toBe("error");
  }, 15000);

  test("heartbeat onTick callback emits task events during execution", async () => {
    const lineDir = createLine(`sw-te-hb-${Date.now()}`);
    mkdirSync(resolve(lineDir, "queues", "task-events", "wp-hb"), { recursive: true });

    const { appendTaskEvent } = await import("../task-events");
    const ref = { ms: Date.now() };

    const stop = startHeartbeat(
      lineDir,
      "s1",
      "wp-hb.json",
      Date.now(),
      ref,
      { interval_ms: 100 },
      (tick, elapsedS, silentS) => {
        appendTaskEvent(lineDir, "wp-hb", "s1", {
          kind: "heartbeat",
          summary: `tick ${tick} · elapsed ${elapsedS}s · silent ${silentS}s`,
        });
      }
    );

    await new Promise((r) => setTimeout(r, 350));
    stop();

    const page = readTaskEvents(lineDir, "wp-hb", "s1");
    expect(page.events.length).toBeGreaterThanOrEqual(2);
    expect(page.events[0].kind).toBe("heartbeat");
    expect(page.events[0].summary).toMatch(/tick \d+/);
    // sequences are monotonically increasing
    for (let i = 1; i < page.events.length; i++) {
      expect(page.events[i].seq).toBeGreaterThan(page.events[i - 1].seq);
    }
  });
});
