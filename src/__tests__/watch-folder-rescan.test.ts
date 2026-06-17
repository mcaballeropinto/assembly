import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "fs";
import { watchFolder } from "../queue";
import { startOrchestrator } from "../orchestrator";
import { __resetUsageGateStateForTest } from "../usage";
import { recordEmit } from "../emit-manifest";

const tempDirs: string[] = [];

function freshDir(label: string): string {
  const dir = resolve(
    "/tmp",
    `assembly-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("watchFolder rescan", () => {
  test("(A) rescan recovers a file when fs.watch is dead", async () => {
    const dir = freshDir("rescan-A");
    const seen: string[] = [];

    const stop = watchFolder(
      dir,
      (filePath) => {
        seen.push(filePath);
      },
      { rescanIntervalMs: 100 }
    );

    // Simulate inotify dropping every event by closing the underlying watcher.
    stop._watcher.close();

    // Drop a file — fs.watch is dead, so only the rescan can pick this up.
    const target = resolve(dir, "missed.json");
    writeFileSync(target, "{}");

    await new Promise((r) => setTimeout(r, 350));
    stop();

    expect(seen).toContain(target);
  });

  test("(B) idempotent handler sees exactly one invocation under normal operation", async () => {
    const dir = freshDir("rescan-B");
    let calls = 0;

    const stop = watchFolder(
      dir,
      (filePath) => {
        calls += 1;
        // Idempotent claim: remove file on first invocation, re-fires no-op.
        try {
          unlinkSync(filePath);
        } catch {}
      },
      { rescanIntervalMs: 50 }
    );

    writeFileSync(resolve(dir, "once.json"), "{}");
    await new Promise((r) => setTimeout(r, 200));
    stop();

    expect(calls).toBe(1);
  });

  test("(C) rescanIntervalMs: 0 disables the rescan", async () => {
    const dir = freshDir("rescan-C");
    const seen: string[] = [];

    const stop = watchFolder(
      dir,
      (filePath) => {
        seen.push(filePath);
      },
      { rescanIntervalMs: 0 }
    );

    // Kill fs.watch so only a rescan could ever find this file.
    stop._watcher.close();

    writeFileSync(resolve(dir, "orphan.json"), "{}");
    await new Promise((r) => setTimeout(r, 500));
    stop();

    expect(seen).toEqual([]);
  });

  test("(D) stop() clears the rescan timer", async () => {
    const dir = freshDir("rescan-D");
    let calls = 0;

    const stop = watchFolder(
      dir,
      () => {
        calls += 1;
      },
      { rescanIntervalMs: 50 }
    );

    // Pre-populate so rescan would re-fire indefinitely if not cleared.
    writeFileSync(resolve(dir, "stay.json"), "{}");
    await new Promise((r) => setTimeout(r, 120));
    stop._watcher.close(); // ensure post-stop fs.watch can't fire either
    const callsAtStop = calls;
    stop();

    await new Promise((r) => setTimeout(r, 250));

    expect(calls).toBe(callsAtStop);
  });
});

// --- End-to-end burst test ---

const orchestrators: Array<{ stop: () => void | Promise<void> }> = [];
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
const originalDisableUsageGate = process.env.ASSEMBLY_DISABLE_USAGE_GATE;

function createScriptLine(linePath: string, stationNames: string[]): void {
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });

  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: rescan-burst-test\nsequence:\n${stationNames.map((n) => `  - ${n}`).join("\n")}\n`
  );

  for (const name of stationNames) {
    const stationDir = resolve(linePath, "stations", name);
    mkdirSync(stationDir, { recursive: true });
    writeFileSync(
      resolve(stationDir, "AGENT.md"),
      `---\nprovider: script\nscript: ok.ts\n---\n`
    );
    writeFileSync(
      resolve(stationDir, "ok.ts"),
      `console.log(JSON.stringify({ summary: "ok from ${name}" }));\n`
    );
  }
}

describe("end-to-end burst", () => {
  beforeEach(() => {
    const snapDir = freshDir("snap");
    process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = resolve(
      snapDir,
      "usage-status.json"
    );
    process.env.ASSEMBLY_DISABLE_USAGE_GATE = "1";

    __resetUsageGateStateForTest();
  });

  afterEach(async () => {
    for (const o of orchestrators.splice(0)) {
      try {
        await o.stop();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
    if (originalSnapEnv === undefined)
      delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
    else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalSnapEnv;
    if (originalDisableUsageGate === undefined)
      delete process.env.ASSEMBLY_DISABLE_USAGE_GATE;
    else process.env.ASSEMBLY_DISABLE_USAGE_GATE = originalDisableUsageGate;
    __resetUsageGateStateForTest();
  });

  test(
    "(E) 10-file burst into the line inbox produces 10 task_received events",
    async () => {
      const linePath = freshDir("burst-line");
      createScriptLine(linePath, ["station-a"]);

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);
      await new Promise((r) => setTimeout(r, 200));

      const inbox = resolve(linePath, "queues", "inbox");
      for (let i = 0; i < 10; i++) {
        const name = `burst-${i}.json`;
        recordEmit(inbox, name, "cli");
        writeFileSync(
          resolve(inbox, name),
          JSON.stringify({ task: `burst ${i}`, input: { i } })
        );
      }

      const logPath = resolve(linePath, "queues", "activity.jsonl");
      const deadline = Date.now() + 15_000;
      let received = 0;
      while (Date.now() < deadline) {
        if (existsSync(logPath)) {
          const text = await Bun.file(logPath).text();
          received = text
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter((e) => e && e.event === "task_received").length;
          if (received >= 10) break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(received).toBe(10);
    },
    20_000
  );

  test(
    "(F) single raw task produces exactly one task_done (no double-dispatch race)",
    async () => {
      // Regression test for the line_inbox / section_inbox race:
      // claimFile used to move the raw {task, input} file into the first
      // section's inbox BEFORE the line-inbox handler finished writing
      // the enriched workpiece body. The section-inbox watcher could fire
      // on the moved-in file, spawn a worker on the raw shape, and then
      // the line-inbox handler's Bun.write recreated the file at the same
      // path — triggering the section-inbox watcher AGAIN and spawning a
      // second worker. The pipeline ran twice, with two task_done events
      // per raw enqueue.
      //
      // After the fix, enrichment happens in place in the line inbox via
      // tmp + rename, then claimFile moves the already-enriched workpiece
      // into the section inbox. There is only ever one workpiece file to
      // pick up, so exactly one task_done fires.
      const linePath = freshDir("single-raw-line");
      createScriptLine(linePath, ["station-a"]);

      const orch = await startOrchestrator({ linePath });
      orchestrators.push(orch);
      await new Promise((r) => setTimeout(r, 200));

      const inbox = resolve(linePath, "queues", "inbox");
      recordEmit(inbox, "lonely.json", "cli");
      writeFileSync(
        resolve(inbox, "lonely.json"),
        JSON.stringify({ task: "lonely", input: {} })
      );

      const logPath = resolve(linePath, "queues", "activity.jsonl");
      const deadline = Date.now() + 15_000;
      let taskDone = 0;
      let stationStart = 0;
      while (Date.now() < deadline) {
        if (existsSync(logPath)) {
          const events = (await Bun.file(logPath).text())
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          taskDone = events.filter((e) => e.event === "task_done").length;
          stationStart = events.filter(
            (e) => e.event === "station_start"
          ).length;
          if (taskDone >= 1) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // Settle window: if the bug were present, the second dispatch fires
      // ~50–500ms after the first task_done. Wait long enough to catch it.
      await new Promise((r) => setTimeout(r, 1500));
      const finalText = existsSync(logPath)
        ? await Bun.file(logPath).text()
        : "";
      const finalEvents = finalText
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      taskDone = finalEvents.filter((e) => e.event === "task_done").length;
      stationStart = finalEvents.filter(
        (e) => e.event === "station_start"
      ).length;

      expect(taskDone).toBe(1);
      expect(stationStart).toBe(1);
    },
    20_000
  );
});
