import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from "fs";
import {
  appendTaskEvent,
  readTaskEvents,
  listTaskEventStations,
  initTaskEventDir,
  updateTaskEventIndex,
} from "../task-events";

const TEMP_DIR = resolve("/tmp", `assembly-test-task-events-${Date.now()}`);
const LINE_PATH = resolve(TEMP_DIR, "test-line");

beforeEach(() => {
  mkdirSync(resolve(LINE_PATH, "queues"), { recursive: true });
});

afterAll(() => {
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
});

describe("initTaskEventDir", () => {
  test("creates task-events directory for a workpiece", () => {
    initTaskEventDir(LINE_PATH, "wp-init-1");
    expect(existsSync(resolve(LINE_PATH, "queues", "task-events", "wp-init-1"))).toBe(true);
  });

  test("is idempotent — calling twice does not throw", () => {
    initTaskEventDir(LINE_PATH, "wp-init-2");
    initTaskEventDir(LINE_PATH, "wp-init-2");
    expect(existsSync(resolve(LINE_PATH, "queues", "task-events", "wp-init-2"))).toBe(true);
  });
});

describe("appendTaskEvent + readTaskEvents round-trip", () => {
  test("appended events are readable in order", () => {
    const wpId = "wp-rt-1";
    initTaskEventDir(LINE_PATH, wpId);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "lifecycle", summary: "Started", detail: { subtype: "started" } });
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "heartbeat", summary: "tick 1" });
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "lifecycle", summary: "Finished" });

    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    expect(page.events.length).toBe(3);
    expect(page.events[0].kind).toBe("lifecycle");
    expect(page.events[0].summary).toBe("Started");
    expect(page.events[1].kind).toBe("heartbeat");
    expect(page.events[2].kind).toBe("lifecycle");
    expect(page.events[2].summary).toBe("Finished");
    expect(page.total).toBe(3);
  });

  test("sequence numbers increment per file", () => {
    const wpId = "wp-seq-1";
    initTaskEventDir(LINE_PATH, wpId);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "heartbeat", summary: "tick 1" });
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "heartbeat", summary: "tick 2" });
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "heartbeat", summary: "tick 3" });

    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    expect(page.events[0].seq).toBeLessThan(page.events[1].seq);
    expect(page.events[1].seq).toBeLessThan(page.events[2].seq);
  });

  test("different stations have independent sequence counters", () => {
    const wpId = "wp-seq-2";
    initTaskEventDir(LINE_PATH, wpId);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "heartbeat", summary: "a1" });
    appendTaskEvent(LINE_PATH, wpId, "station-b", { kind: "heartbeat", summary: "b1" });
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "heartbeat", summary: "a2" });

    const pageA = readTaskEvents(LINE_PATH, wpId, "station-a");
    const pageB = readTaskEvents(LINE_PATH, wpId, "station-b");
    expect(pageA.events.length).toBe(2);
    expect(pageB.events.length).toBe(1);
    expect(pageA.events[0].station).toBe("station-a");
    expect(pageB.events[0].station).toBe("station-b");
  });

  test("each event has a ts field", () => {
    const wpId = "wp-ts-1";
    initTaskEventDir(LINE_PATH, wpId);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "message", summary: "hello" });
    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    expect(page.events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("readTaskEvents on nonexistent file returns empty page", () => {
    const page = readTaskEvents(LINE_PATH, "wp-nonexistent", "station-z");
    expect(page.events).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBe(0);
  });
});

describe("detail truncation", () => {
  test("detail under 8KB is stored as-is", () => {
    const wpId = "wp-detail-1";
    initTaskEventDir(LINE_PATH, wpId);
    const smallDetail = { foo: "bar", nums: [1, 2, 3] };
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "message", summary: "test", detail: smallDetail });
    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    expect(page.events[0].detail).toEqual(smallDetail);
  });

  test("detail over 8KB is replaced with truncation marker", () => {
    const wpId = "wp-detail-2";
    initTaskEventDir(LINE_PATH, wpId);
    const bigDetail = { data: "x".repeat(10000) };
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "message", summary: "big", detail: bigDetail });
    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    const d = page.events[0].detail as any;
    expect(d.truncated).toBe(true);
    expect(typeof d.original_bytes).toBe("number");
    expect(d.original_bytes).toBeGreaterThan(8192);
  });
});

describe("summary truncation", () => {
  test("summary over 300 chars is truncated with ellipsis", () => {
    const wpId = "wp-summ-1";
    initTaskEventDir(LINE_PATH, wpId);
    const longSummary = "a".repeat(400);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "message", summary: longSummary });
    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    expect(page.events[0].summary.length).toBeLessThanOrEqual(300);
    expect(page.events[0].summary.endsWith("…")).toBe(true);
  });

  test("summary exactly 300 chars is stored unchanged", () => {
    const wpId = "wp-summ-2";
    initTaskEventDir(LINE_PATH, wpId);
    const exactSummary = "b".repeat(300);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "message", summary: exactSummary });
    const page = readTaskEvents(LINE_PATH, wpId, "station-a");
    expect(page.events[0].summary).toBe(exactSummary);
  });
});

describe("appendTaskEvent failure handling", () => {
  test("does not throw when directory does not exist", () => {
    // Do NOT call initTaskEventDir — directory missing, should swallow error
    expect(() => {
      appendTaskEvent(LINE_PATH, "wp-no-dir", "station-x", { kind: "heartbeat", summary: "tick" });
    }).not.toThrow();
  });
});

describe("pagination", () => {
  function seedEvents(wpId: string, count: number) {
    initTaskEventDir(LINE_PATH, wpId);
    for (let i = 0; i < count; i++) {
      appendTaskEvent(LINE_PATH, wpId, "pager", { kind: "heartbeat", summary: `tick ${i + 1}` });
    }
  }

  test("limit=10 returns at most 10 events", () => {
    seedEvents("wp-pg-1", 25);
    const page = readTaskEvents(LINE_PATH, "wp-pg-1", "pager", { limit: 10 });
    expect(page.events.length).toBe(10);
    expect(page.has_more).toBe(true);
    expect(page.total).toBe(25);
  });

  test("after=N returns events with seq > N", () => {
    seedEvents("wp-pg-2", 10);
    const first = readTaskEvents(LINE_PATH, "wp-pg-2", "pager", { limit: 5 });
    const afterCursor = first.next_cursor;
    const next = readTaskEvents(LINE_PATH, "wp-pg-2", "pager", { after: afterCursor, limit: 10 });
    expect(next.events.every((e) => e.seq > afterCursor)).toBe(true);
    expect(next.events.length).toBe(5);
  });

  test("before=N returns events with seq < N", () => {
    seedEvents("wp-pg-3", 10);
    const allPage = readTaskEvents(LINE_PATH, "wp-pg-3", "pager", { limit: 10 });
    const midSeq = allPage.events[5].seq;
    const earlier = readTaskEvents(LINE_PATH, "wp-pg-3", "pager", { before: midSeq, limit: 100 });
    expect(earlier.events.every((e) => e.seq < midSeq)).toBe(true);
  });
});

describe("updateTaskEventIndex + listTaskEventStations", () => {
  test("index is written and readable", () => {
    const wpId = "wp-idx-1";
    initTaskEventDir(LINE_PATH, wpId);
    appendTaskEvent(LINE_PATH, wpId, "station-a", { kind: "lifecycle", summary: "Started" });
    updateTaskEventIndex(LINE_PATH, wpId, "station-a", "running", new Date().toISOString());

    const stations = listTaskEventStations(LINE_PATH, wpId);
    expect(stations.length).toBe(1);
    expect(stations[0].name).toBe("station-a");
    expect(stations[0].status).toBe("running");
    expect(stations[0].event_count).toBeGreaterThanOrEqual(1);
  });

  test("index is updated to ok on station finish", () => {
    const wpId = "wp-idx-2";
    initTaskEventDir(LINE_PATH, wpId);
    const startedAt = new Date().toISOString();
    updateTaskEventIndex(LINE_PATH, wpId, "station-a", "running", startedAt);
    updateTaskEventIndex(LINE_PATH, wpId, "station-a", "ok", startedAt, new Date().toISOString());

    const stations = listTaskEventStations(LINE_PATH, wpId);
    expect(stations[0].status).toBe("ok");
    expect(stations[0].finished_at).toBeTruthy();
  });

  test("multiple stations tracked in one index", () => {
    const wpId = "wp-idx-3";
    initTaskEventDir(LINE_PATH, wpId);
    const t = new Date().toISOString();
    updateTaskEventIndex(LINE_PATH, wpId, "station-a", "ok", t, t);
    updateTaskEventIndex(LINE_PATH, wpId, "station-b", "running", t);

    const stations = listTaskEventStations(LINE_PATH, wpId);
    expect(stations.length).toBe(2);
    const names = stations.map((s) => s.name);
    expect(names).toContain("station-a");
    expect(names).toContain("station-b");
  });

  test("listTaskEventStations returns [] for missing index", () => {
    const stations = listTaskEventStations(LINE_PATH, "wp-no-index");
    expect(stations).toEqual([]);
  });
});
