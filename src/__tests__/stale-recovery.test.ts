import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve, basename } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { recoverStaleProcessing, type SectionInfo } from "../orchestrator";
import { initSectionQueue, initLineQueue } from "../queue";
import {
  createWorkpiece,
  writeStation,
  failStation,
  escalateStation,
} from "../workpiece";

const TEMP_DIR = resolve("/tmp", `assembly-test-stale-recovery-${Date.now()}`);

/** Create a test section with initialized queue directories */
function createTestSection(name: string, subDir?: string): SectionInfo {
  const base = subDir ? resolve(TEMP_DIR, subDir) : TEMP_DIR;
  const dir = resolve(base, "stations", name);
  mkdirSync(dir, { recursive: true });
  const queue = initSectionQueue(dir);
  return { name, dir, queue };
}

/** Create a log collector for testing */
function createTestLog(): {
  log: (event: string, detail: Record<string, unknown>) => void;
  events: Array<{ event: string; detail: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  return {
    log: (event: string, detail: Record<string, unknown>) => {
      events.push({ event, detail });
    },
    events,
  };
}

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── recoverStaleProcessing() tests ─────────────────────────────────

describe("recoverStaleProcessing()", () => {
  test("completed workpiece (status:done) in processing/ is moved to output/", async () => {
    const section = createTestSection("station-a", `done-to-output-${Date.now()}`);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-done-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Create a workpiece with a completed station result
    let wp = createWorkpiece("test-line", "test task");
    wp = writeStation(wp, "station-a", { summary: "All done" }, {
      model: "test-model",
      tokens: { in: 100, out: 50 },
      cost_usd: 0.01,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
    });

    // Place it in processing/
    const filePath = resolve(section.queue.processing, `${wp.id}.json`);
    writeFileSync(filePath, JSON.stringify(wp, null, 2));

    const result = await recoverStaleProcessing([section], errorDir, log);

    // File should be in output/, not processing/
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(resolve(section.queue.output, `${wp.id}.json`))).toBe(true);

    // Verify log event
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("stale_recovery");
    expect(events[0].detail.action).toBe("routed_to_output");
    expect(events[0].detail.station).toBe("station-a");
    expect(events[0].detail.workpiece).toBe(wp.id);

    // Verify return value
    expect(result).toEqual({ recovered: 1, errors: 0 });
  });

  test("incomplete workpiece (no station result) in processing/ is moved to inbox/", async () => {
    const section = createTestSection("station-b", `no-result-${Date.now()}`);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-noresult-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Create a workpiece with no station result
    const wp = createWorkpiece("test-line", "test task");

    // Place it in processing/
    const filePath = resolve(section.queue.processing, `${wp.id}.json`);
    writeFileSync(filePath, JSON.stringify(wp, null, 2));

    const result = await recoverStaleProcessing([section], errorDir, log);

    // File should be in inbox/, not processing/
    expect(existsSync(filePath)).toBe(false);
    const inboxPath = resolve(section.queue.inbox, `${wp.id}.json`);
    expect(existsSync(inboxPath)).toBe(true);

    // Verify the workpiece in inbox has no station result
    const recovered = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(recovered.stations["station-b"]).toBeUndefined();

    // Verify log event
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("stale_recovery");
    expect(events[0].detail.action).toBe("requeued_to_inbox");

    expect(result).toEqual({ recovered: 1, errors: 0 });
  });

  test("failed workpiece (status:failed) in processing/ is cleared and moved to inbox/", async () => {
    const section = createTestSection("station-c", `failed-${Date.now()}`);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-failed-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Create a workpiece with a failed station result
    let wp = createWorkpiece("test-line", "test task");
    wp = failStation(wp, "station-c", "Something went wrong", {
      model: "test-model",
      tokens: { in: 50, out: 20 },
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:30Z",
    });

    // Place it in processing/
    const filePath = resolve(section.queue.processing, `${wp.id}.json`);
    writeFileSync(filePath, JSON.stringify(wp, null, 2));

    const result = await recoverStaleProcessing([section], errorDir, log);

    // File should be in inbox/
    expect(existsSync(filePath)).toBe(false);
    const inboxPath = resolve(section.queue.inbox, `${wp.id}.json`);
    expect(existsSync(inboxPath)).toBe(true);

    // Verify the station result is cleared
    const recovered = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(recovered.stations["station-c"]).toBeUndefined();

    // Verify log event
    expect(events[0].event).toBe("stale_recovery");
    expect(events[0].detail.action).toBe("requeued_to_inbox");

    expect(result).toEqual({ recovered: 1, errors: 0 });
  });

  test("corrupted JSON in processing/ is moved to error bucket", async () => {
    const section = createTestSection("station-d", `corrupted-${Date.now()}`);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-corrupted-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Place corrupted JSON in processing/
    const filePath = resolve(section.queue.processing, "corrupted-wp.json");
    writeFileSync(filePath, "{ not valid json!!!");

    const result = await recoverStaleProcessing([section], errorDir, log);

    // File should be in error dir, not processing/
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(resolve(errorDir, "corrupted-wp.json"))).toBe(true);

    // Verify log event
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("stale_recovery_error");
    expect(events[0].detail.station).toBe("station-d");
    expect(events[0].detail.file).toBe("corrupted-wp.json");

    expect(result).toEqual({ recovered: 0, errors: 1 });
  });

  test("multiple workpieces across multiple stations are all recovered", async () => {
    const subDir = `multi-${Date.now()}`;
    const section1 = createTestSection("station-1", subDir);
    const section2 = createTestSection("station-2", subDir);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-multi-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Station-1: completed workpiece
    let wp1 = createWorkpiece("test-line", "task 1");
    wp1 = writeStation(wp1, "station-1", { summary: "Done" }, {
      model: "test-model",
      tokens: { in: 100, out: 50 },
      cost_usd: 0.01,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
    });
    writeFileSync(
      resolve(section1.queue.processing, `${wp1.id}.json`),
      JSON.stringify(wp1, null, 2)
    );

    // Station-2: incomplete workpiece
    const wp2 = createWorkpiece("test-line", "task 2");
    writeFileSync(
      resolve(section2.queue.processing, `${wp2.id}.json`),
      JSON.stringify(wp2, null, 2)
    );

    const result = await recoverStaleProcessing(
      [section1, section2],
      errorDir,
      log
    );

    // Station-1 file should be in output/
    expect(existsSync(resolve(section1.queue.output, `${wp1.id}.json`))).toBe(true);
    // Station-2 file should be in inbox/
    expect(existsSync(resolve(section2.queue.inbox, `${wp2.id}.json`))).toBe(true);

    expect(result).toEqual({ recovered: 2, errors: 0 });
    expect(events.length).toBe(2);
  });

  test("stale progress sidecar rolls up into stations[name].rounds before being unlinked", async () => {
    const section = createTestSection("station-rounds", `rounds-${Date.now()}`);
    const { log } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-rounds-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Done workpiece WITHOUT rounds — simulates a worker that crashed
    // after writing the result but before attachRounds() ran.
    let wp = createWorkpiece("test-line", "rounds task");
    wp = writeStation(wp, "station-rounds", { summary: "Done" }, {
      model: "test-model",
      tokens: { in: 100, out: 50 },
      cost_usd: 0.01,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
    });

    const filePath = resolve(section.queue.processing, `${wp.id}.json`);
    writeFileSync(filePath, JSON.stringify(wp, null, 2));

    // Seed the progress sidecar with tool_use events.
    const progressLines = [
      { phase: "llm", status: "running", tool: "Read", turns: 1 },
      { phase: "llm", status: "running", tool: "Read", turns: 2 },
      { phase: "llm", status: "running", tool: "Bash", turns: 3 },
    ];
    writeFileSync(
      filePath + ".progress.jsonl",
      progressLines.map((l) => JSON.stringify(l)).join("\n") + "\n"
    );

    await recoverStaleProcessing([section], errorDir, log);

    const outPath = resolve(section.queue.output, `${wp.id}.json`);
    expect(existsSync(outPath)).toBe(true);

    const recovered = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(recovered.stations["station-rounds"].rounds).toEqual({
      turns: 3,
      tools: { Read: 2, Bash: 1 },
    });

    // Sidecar must be cleaned up after rollup.
    expect(existsSync(filePath + ".progress.jsonl")).toBe(false);
  });

  test("empty processing/ directories result in no-op", async () => {
    const section = createTestSection("station-empty", `empty-${Date.now()}`);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-empty-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    const result = await recoverStaleProcessing([section], errorDir, log);

    expect(result).toEqual({ recovered: 0, errors: 0 });
    expect(events.length).toBe(0);
  });

  test("escalated workpiece in processing/ is requeued to inbox (not output)", async () => {
    const section = createTestSection("station-esc", `escalated-${Date.now()}`);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-esc-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Create a workpiece with an escalated station result
    let wp = createWorkpiece("test-line", "test task");
    wp = escalateStation(wp, "station-esc", "Needs human review", {
      model: "test-model",
      tokens: { in: 200, out: 100 },
      cost_usd: 0.02,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:02:00Z",
    });

    const filePath = resolve(section.queue.processing, `${wp.id}.json`);
    writeFileSync(filePath, JSON.stringify(wp, null, 2));

    const result = await recoverStaleProcessing([section], errorDir, log);

    // Should be in inbox (not output), since only "done" goes to output
    expect(existsSync(filePath)).toBe(false);
    const inboxPath = resolve(section.queue.inbox, `${wp.id}.json`);
    expect(existsSync(inboxPath)).toBe(true);

    // Station result should be cleared
    const recovered = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(recovered.stations["station-esc"]).toBeUndefined();

    expect(events[0].detail.action).toBe("requeued_to_inbox");
    expect(result).toEqual({ recovered: 1, errors: 0 });
  });

  test("previous station results are preserved during recovery", async () => {
    const subDir = `preserve-${Date.now()}`;
    // Station-2 is in processing, but station-1 was already completed
    const section2 = createTestSection("station-2", subDir);
    const { log, events } = createTestLog();
    const errorDir = resolve(TEMP_DIR, `error-preserve-${Date.now()}`);
    mkdirSync(errorDir, { recursive: true });

    // Create a workpiece that completed station-1 and is now in station-2's processing
    let wp = createWorkpiece("test-line", "test task");
    wp = writeStation(wp, "station-1", { summary: "Station 1 done" }, {
      model: "test-model",
      tokens: { in: 100, out: 50 },
      cost_usd: 0.01,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
    });
    // station-2 has no result yet (worker was killed before running)

    const filePath = resolve(section2.queue.processing, `${wp.id}.json`);
    writeFileSync(filePath, JSON.stringify(wp, null, 2));

    const result = await recoverStaleProcessing([section2], errorDir, log);

    // File should be in station-2's inbox
    const inboxPath = resolve(section2.queue.inbox, `${wp.id}.json`);
    expect(existsSync(inboxPath)).toBe(true);

    // Station-1 result should still be intact
    const recovered = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(recovered.stations["station-1"]).toBeDefined();
    expect(recovered.stations["station-1"].status).toBe("done");
    expect(recovered.stations["station-1"].summary).toBe("Station 1 done");

    // Station-2 result should not exist
    expect(recovered.stations["station-2"]).toBeUndefined();

    expect(result).toEqual({ recovered: 1, errors: 0 });
  });
});
