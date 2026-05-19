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
import { startOrchestrator, type OrchestratorHandle } from "../orchestrator";
import { createWorkpiece, writeStation } from "../workpiece";
import { __resetUsageGateStateForTest } from "../usage";

const orchestrators: OrchestratorHandle[] = [];
const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

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
  await new Promise((r) => setTimeout(r, 100));
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  globalThis.fetch = originalFetch;
  __resetUsageGateStateForTest();
});

/**
 * Build a line with two stations (A, B) in the original sequence. Then
 * "remove" A from line.yaml by writing a new line.yaml with only B in
 * sequence. Seed processing/ on station A with a workpiece that's marked as
 * `done` for A. When the orchestrator starts, it should:
 *   1. Mount A as an orphan station.
 *   2. Route the done workpiece forward to B's inbox.
 *   3. B then runs and the workpiece reaches done/.
 */
function buildLineWithRemovedStation(linePath: string): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
  // New line.yaml: only B in sequence.
  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: orphan-test\nsequence:\n  - b\n`
  );

  // Station A (removed from sequence but its dir still exists on disk —
  // the predecessor created it).
  const aDir = resolve(linePath, "stations", "a");
  mkdirSync(aDir, { recursive: true });
  // We never spawn A in the test, but its AGENT.md needs to exist so it
  // looks like a real station dir (orphan detection only cares about
  // processing/, but be defensive).
  writeFileSync(resolve(aDir, "AGENT.md"), `---\nprovider: script\nscript: ok.ts\n---\n`);
  writeFileSync(resolve(aDir, "ok.ts"), `console.log(JSON.stringify({summary:"a-ok"}));\n`);

  // Station B (active in new sequence).
  const bDir = resolve(linePath, "stations", "b");
  mkdirSync(bDir, { recursive: true });
  writeFileSync(resolve(bDir, "AGENT.md"), `---\nprovider: script\nscript: ok.ts\n---\n`);
  writeFileSync(resolve(bDir, "ok.ts"), `console.log(JSON.stringify({summary:"b-ok"}));\n`);
}

describe("orphan station support", () => {
  test("removed-from-sequence station with done workpiece routes forward to next live section", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-orphan-route-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);
    buildLineWithRemovedStation(linePath);

    // Seed: workpiece in stations/a/queue/processing/, already marked done
    // for A. This simulates an adopted worker that finished its station's
    // work and dropped output (but we're simulating without spawning).
    let wp = createWorkpiece("orphan-test", "stranded by reload");
    wp = writeStation(wp, "a", { summary: "a finished" }, {
      model: "script",
      tokens: { in: 0, out: 0 },
      cost_usd: 0,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z",
    });
    // We need this file in OUTPUT/ for the orphan watcher to fire, not
    // processing/. But the orphan detector only mounts when processing/ is
    // non-empty. Seed processing/ with a dummy that triggers detection, and
    // separately drop the done-status wp in output/ so the watcher fires.
    const procDir = resolve(linePath, "stations", "a", "queue", "processing");
    mkdirSync(procDir, { recursive: true });
    writeFileSync(resolve(procDir, "placeholder.json"), JSON.stringify({
      id: "placeholder",
      line: "orphan-test",
      task: "...",
      input: {},
      stations: {},
    }, null, 2));
    const outDir = resolve(linePath, "stations", "a", "queue", "output");
    mkdirSync(outDir, { recursive: true });

    const orch = await startOrchestrator({ linePath });
    orchestrators.push(orch);

    // After orchestrator starts, drop the done workpiece into A's output/.
    // The orphan output watcher should pick it up and route to B's inbox.
    const orphanOutPath = resolve(outDir, `${wp.id}.json`);
    writeFileSync(orphanOutPath, JSON.stringify(wp, null, 2));

    // Wait for routing to happen. B runs the ok.ts script, which moves the
    // workpiece to done/.
    const doneDir = resolve(linePath, "queues", "done");
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const files = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const doneFiles = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
    expect(doneFiles.length).toBe(1);
    const finalWp = JSON.parse(readFileSync(resolve(doneDir, doneFiles[0]), "utf-8"));
    expect(finalWp.stations.a?.status).toBe("done");
    expect(finalWp.stations.b?.status).toBe("done");

    // Activity log should show orphan_routed_forward (a → b).
    const activityPath = resolve(linePath, "queues", "activity.jsonl");
    const events = readFileSync(activityPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const orphanMount = events.find((e) => e.event === "orphan_station_mounted" && e.station === "a");
    expect(orphanMount).toBeDefined();
    const orphanRouted = events.find((e) => e.event === "orphan_routed_forward" && e.from === "a" && e.to === "b");
    expect(orphanRouted).toBeDefined();
  }, 15_000);

  test("orphan station completion with no live sections left routes to done/", async () => {
    const linePath = resolve(
      "/tmp",
      `assembly-test-orphan-empty-seq-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);

    mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
    // New line.yaml has B in sequence (so sawLiveSection=true, route=done).
    writeFileSync(
      resolve(linePath, "line.yaml"),
      `name: orphan-done\nsequence:\n  - b\n`
    );

    const aDir = resolve(linePath, "stations", "a");
    mkdirSync(aDir, { recursive: true });
    writeFileSync(resolve(aDir, "AGENT.md"), `---\nprovider: script\nscript: ok.ts\n---\n`);
    writeFileSync(resolve(aDir, "ok.ts"), `console.log(JSON.stringify({summary:"ok"}));\n`);

    const bDir = resolve(linePath, "stations", "b");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(resolve(bDir, "AGENT.md"), `---\nprovider: script\nscript: ok.ts\n---\n`);
    writeFileSync(resolve(bDir, "ok.ts"), `console.log(JSON.stringify({summary:"ok"}));\n`);

    // Workpiece already done for BOTH A (orphan) and B (live).
    let wp = createWorkpiece("orphan-done", "everything finished");
    wp = writeStation(wp, "a", { summary: "a-finished" }, {
      model: "script", tokens: { in: 0, out: 0 }, cost_usd: 0,
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
    });
    wp = writeStation(wp, "b", { summary: "b-finished" }, {
      model: "script", tokens: { in: 0, out: 0 }, cost_usd: 0,
      started_at: "2026-01-01T00:00:02Z", finished_at: "2026-01-01T00:00:03Z",
    });

    // Seed processing/ on A so orphan is mounted.
    const procDir = resolve(aDir, "queue", "processing");
    mkdirSync(procDir, { recursive: true });
    writeFileSync(resolve(procDir, "placeholder.json"), JSON.stringify({
      id: "placeholder", line: "orphan-done", task: "...", input: {}, stations: {},
    }, null, 2));

    const orch = await startOrchestrator({ linePath });
    orchestrators.push(orch);

    // Drop the fully-done workpiece into orphan A's output/.
    const outDir = resolve(aDir, "queue", "output");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `${wp.id}.json`), JSON.stringify(wp, null, 2));

    // Wait for routing — should land in done/ via orphan_completed path.
    const doneDir = resolve(linePath, "queues", "done");
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const files = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const doneFiles = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
    expect(doneFiles.length).toBe(1);

    const activityPath = resolve(linePath, "queues", "activity.jsonl");
    const events = readFileSync(activityPath, "utf-8")
      .trim().split("\n").filter((l) => l).map((l) => JSON.parse(l));
    const completed = events.find((e) => e.event === "orphan_completed");
    expect(completed).toBeDefined();
  }, 15_000);

  test("drainInbox is a no-op on orphan sections — no spawn even with inbox files", async () => {
    // Build a line whose only station is orphan: nothing in sequence, the
    // station dir exists with files in processing/. Drop a file in its
    // inbox/ and assert no worker spawns (no processing/ activity from
    // drainInbox).
    const linePath = resolve(
      "/tmp",
      `assembly-test-orphan-no-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempDirs.push(linePath);

    mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
    mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
    writeFileSync(resolve(linePath, "line.yaml"), `name: orphan-no-spawn\nsequence:\n  - b\n`);

    const aDir = resolve(linePath, "stations", "a");
    mkdirSync(aDir, { recursive: true });
    writeFileSync(resolve(aDir, "AGENT.md"), `---\nprovider: script\nscript: should-not-run.ts\n---\n`);
    writeFileSync(resolve(aDir, "should-not-run.ts"),
      `appendFileSync(process.env.SENTINEL!, "WORKER RAN\\n");\nconsole.log(JSON.stringify({summary:"oh no"}));\n`);

    const bDir = resolve(linePath, "stations", "b");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(resolve(bDir, "AGENT.md"), `---\nprovider: script\nscript: ok.ts\n---\n`);
    writeFileSync(resolve(bDir, "ok.ts"), `console.log(JSON.stringify({summary:"ok"}));\n`);

    // Seed A's processing/ so orphan detector mounts it.
    const procDir = resolve(aDir, "queue", "processing");
    mkdirSync(procDir, { recursive: true });
    writeFileSync(resolve(procDir, "stuck.json"), JSON.stringify({
      id: "stuck", line: "orphan-no-spawn", task: "...", input: {}, stations: {},
    }, null, 2));

    const orch = await startOrchestrator({ linePath });
    orchestrators.push(orch);

    // Drop a workpiece in A's inbox AFTER startup — drainInbox would normally
    // spawn a worker. With orphan=true it must not.
    const inboxDir = resolve(aDir, "queue", "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const wp = createWorkpiece("orphan-no-spawn", "should not run");
    writeFileSync(resolve(inboxDir, `${wp.id}.json`), JSON.stringify(wp));

    await new Promise((r) => setTimeout(r, 1_500));

    // The decisive check: A's drainInbox is a no-op for orphan sections.
    // The post-drain workpiece must NOT be in processing/ (no spawn).
    // (It may have been moved by stale_recovery from processing/ → inbox/,
    // which is fine — that's standard recovery, not a spawn.)
    const procDir2 = resolve(aDir, "queue", "processing");
    const procFiles = readdirSync(procDir2).filter((f) => f.endsWith(".json"));
    // Either still stuck.json from the original seed, or empty.
    // What MUST be absent: a worker-spawned file (would be the wp.id file).
    expect(procFiles.includes(`${wp.id}.json`)).toBe(false);

    // The "did the script run" sentinel must NOT have been touched.
    // (We never set SENTINEL, but if a worker had spawned, it would have
    // crashed trying to read process.env.SENTINEL!. A crash would have
    // moved the file to output/ with status=failed. Verify no output/ files.)
    const outDirA = resolve(aDir, "queue", "output");
    const outputFiles = existsSync(outDirA)
      ? readdirSync(outDirA).filter((f) => f.endsWith(".json"))
      : [];
    expect(outputFiles.length).toBe(0);
  }, 10_000);
});
