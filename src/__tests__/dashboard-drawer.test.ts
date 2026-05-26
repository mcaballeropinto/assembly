import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { initSectionQueue, initLineQueue } from "../queue";
import { appendTaskEvent, initTaskEventDir, updateTaskEventIndex } from "../task-events";
import { WorkpieceId, StationName } from "../ids";

/**
 * Integration tests for the workpiece detail drawer API.
 * Tests that GET /api/workpiece/:line/:filename returns _activity field.
 */

const TEMP_DIR = resolve("/tmp", `assembly-test-drawer-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "lines", "drawer-test-line");

// We need to set ASSEMBLY_LINE_DIRS so discoverLines finds our test line
const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;

let server: { stop: () => void; port: number } | null = null;

beforeAll(async () => {
  // Create line directory structure
  mkdirSync(resolve(LINE_DIR, "stations", "plan"), { recursive: true });
  mkdirSync(resolve(LINE_DIR, "stations", "develop"), { recursive: true });

  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    "name: drawer-test-line\nsequence:\n  - plan\n  - develop\n"
  );

  writeFileSync(
    resolve(LINE_DIR, "stations", "plan", "AGENT.md"),
    "---\n---\nPlan station"
  );
  writeFileSync(
    resolve(LINE_DIR, "stations", "develop", "AGENT.md"),
    "---\n---\nDevelop station"
  );

  initSectionQueue(resolve(LINE_DIR, "stations", "plan"));
  initSectionQueue(resolve(LINE_DIR, "stations", "develop"));
  initLineQueue(LINE_DIR);

  // Create a workpiece in done/
  const wp = {
    id: "drawer-wp-1",
    line: "drawer-test-line",
    task: "Test drawer workpiece",
    input: {},
    stations: {
      plan: {
        summary: "planned",
        status: "done",
        started_at: "2026-04-01T10:00:00Z",
        finished_at: "2026-04-01T10:01:00Z",
        model: "sonnet",
        tokens: { in: 500, out: 200 },
        cost_usd: 0.005,
      },
      develop: {
        summary: "developed",
        status: "done",
        started_at: "2026-04-01T10:01:00Z",
        finished_at: "2026-04-01T10:03:00Z",
        model: "opus",
        tokens: { in: 2000, out: 1000 },
        cost_usd: 0.05,
      },
    },
  };
  writeFileSync(
    resolve(LINE_DIR, "queues", "done", "drawer-wp-1.json"),
    JSON.stringify(wp)
  );

  // Create a workpiece with previous_attempts
  const wpWithRetries = {
    id: "drawer-wp-retries",
    line: "drawer-test-line",
    task: "Test workpiece with retries",
    input: {},
    stations: {
      plan: {
        summary: "planned after retry",
        status: "done",
        started_at: "2026-04-01T11:02:00Z",
        finished_at: "2026-04-01T11:04:00Z",
        model: "sonnet",
        tokens: { in: 800, out: 300 },
        cost_usd: 0.008,
        previous_attempts: [
          {
            summary: "Failed: idle timeout after 900s",
            status: "failed",
            started_at: "2026-04-01T10:45:00Z",
            finished_at: "2026-04-01T11:00:02Z",
            model: "sonnet",
            tokens: { in: 400, out: 100 },
            cost_usd: 0.003,
            failure_class: "timeout",
            rounds: { turns: 88, tools: { Read: 17, Bash: 25 } },
          },
          {
            summary: "Failed: Response is not valid JSON",
            status: "failed",
            started_at: "2026-04-01T11:00:30Z",
            finished_at: "2026-04-01T11:01:45Z",
            model: "sonnet",
            tokens: { in: 300, out: 80 },
            cost_usd: 0.002,
            failure_class: "envelope",
            rounds: { turns: 52, tools: { Read: 10 } },
          },
        ],
      },
    },
  };
  writeFileSync(
    resolve(LINE_DIR, "queues", "done", "drawer-wp-retries.json"),
    JSON.stringify(wpWithRetries)
  );

  // Create activity log with entries for this workpiece and others
  const activity = [
    JSON.stringify({ ts: "2026-04-01T10:00:00Z", event: "routed", station: "plan", workpiece: "drawer-wp-1" }),
    JSON.stringify({ ts: "2026-04-01T10:00:30Z", event: "station_done", station: "plan", workpiece: "drawer-wp-1", summary: "planned" }),
    JSON.stringify({ ts: "2026-04-01T10:00:15Z", event: "routed", station: "plan", workpiece: "other-wp" }),
    JSON.stringify({ ts: "2026-04-01T10:01:00Z", event: "routed", station: "develop", workpiece: "drawer-wp-1" }),
    JSON.stringify({ ts: "2026-04-01T10:03:00Z", event: "task_done", workpiece: "drawer-wp-1", summary: "all done" }),
  ];
  writeFileSync(
    resolve(LINE_DIR, "queues", "activity.jsonl"),
    activity.join("\n") + "\n"
  );

  // Set ASSEMBLY_LINE_DIRS so discoverLines picks up our test line directory
  process.env.ASSEMBLY_LINE_DIRS = resolve(TEMP_DIR, "lines");

  // Dynamic import to pick up the env var
  const { startGlobalDashboard } = await import("../global-dashboard");

  // Use a random high port
  const port = 14000 + Math.floor(Math.random() * 1000);
  server = startGlobalDashboard({ port });

  // Wait for server to be ready and lines to be discovered
  // The refreshLines() call is async, give it time to complete
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  if (server) server.stop();
  if (originalLineDirs) process.env.ASSEMBLY_LINE_DIRS = originalLineDirs;
  else delete process.env.ASSEMBLY_LINE_DIRS;
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("Drawer prior attempts rendering", () => {
  test("workpiece with previous_attempts is returned via API", async () => {
    // Create a workpiece with previous_attempts
    const wpWithRetries = {
      id: "drawer-wp-retries",
      line: "drawer-test-line",
      task: "Test workpiece with retries",
      input: {},
      stations: {
        plan: {
          summary: "planned after retry",
          status: "done",
          started_at: "2026-04-01T10:02:00Z",
          finished_at: "2026-04-01T10:03:00Z",
          model: "sonnet",
          tokens: { in: 500, out: 200 },
          cost_usd: 0.005,
          previous_attempts: [
            {
              summary: "Failed: timeout after 900s",
              status: "failed",
              started_at: "2026-04-01T09:45:00Z",
              finished_at: "2026-04-01T10:00:02Z",
              model: "sonnet",
              tokens: { in: 300, out: 100 },
              cost_usd: 0.003,
              failure_class: "timeout",
              rounds: { turns: 88, tools: { Read: 17, Bash: 25 } },
            },
            {
              summary: "Failed: Response is not valid JSON",
              status: "failed",
              started_at: "2026-04-01T10:00:30Z",
              finished_at: "2026-04-01T10:01:30Z",
              model: "sonnet",
              tokens: { in: 200, out: 80 },
              cost_usd: 0.002,
              failure_class: "envelope",
              rounds: { turns: 52, tools: { Read: 10 } },
            },
          ],
        },
      },
    };
    writeFileSync(
      resolve(LINE_DIR, "queues", "done", "drawer-wp-retries.json"),
      JSON.stringify(wpWithRetries)
    );

    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-retries.json`
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.id as string).toBe("drawer-wp-retries");
    expect(data.stations.plan.previous_attempts).toBeDefined();
    expect(data.stations.plan.previous_attempts.length).toBe(2);
    expect(data.stations.plan.previous_attempts[0].failure_class).toBe("timeout");
    expect(data.stations.plan.previous_attempts[1].failure_class).toBe("envelope");
  });

  test("dashboard HTML includes prior attempts rendering logic", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("timeline-prior-attempts");
    expect(html).toContain("previous_attempts");
    expect(html).toContain("Prior attempts (");
  });

  test("workpiece without previous_attempts returns cleanly", async () => {
    // The original drawer-wp-1 has no previous_attempts
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-1.json`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stations.plan.previous_attempts).toBeUndefined();
  });
});

describe("Workpiece API with _activity", () => {
  test("returns workpiece with _activity field", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-1.json`
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.id as string).toBe("drawer-wp-1");
    expect(data.task).toBe("Test drawer workpiece");
    expect(data.stations).toBeDefined();
    expect(data.stations.plan).toBeDefined();
    expect(data.stations.develop).toBeDefined();

    // _activity should contain only entries for drawer-wp-1
    expect(data._activity).toBeDefined();
    expect(Array.isArray(data._activity)).toBe(true);
    expect(data._activity.length).toBe(4); // 4 entries for drawer-wp-1
    for (const entry of data._activity) {
      expect(entry.workpiece).toBe("drawer-wp-1");
    }
  });

  test("_activity is in reverse chronological order", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-1.json`
    );
    const data = await res.json();

    // Should be reversed: task_done (10:03) first, routed to plan (10:00) last
    expect(data._activity[0].event).toBe("task_done");
    expect(data._activity[data._activity.length - 1].event).toBe("routed");
    expect(data._activity[data._activity.length - 1].station).toBe("plan");
  });

  test("returns 404 for unknown workpiece", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/ghost.json`
    );
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  test("returns 404 for unknown line", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/nonexistent-line/drawer-wp-1.json`
    );
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  test("workpiece with previous_attempts serves the retry history", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-retries.json`
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.id as string).toBe("drawer-wp-retries");
    expect(data.stations.plan.previous_attempts).toBeDefined();
    expect(data.stations.plan.previous_attempts).toHaveLength(2);
    expect(data.stations.plan.previous_attempts[0].failure_class).toBe("timeout");
    expect(data.stations.plan.previous_attempts[1].failure_class).toBe("envelope");
  });

  test("workpiece without previous_attempts has no field", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-1.json`
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.stations.plan.previous_attempts).toBeUndefined();
    expect(data.stations.develop.previous_attempts).toBeUndefined();
  });
});

describe("Task events API", () => {
  beforeAll(() => {
    // Seed task-events for drawer-wp-1
    const wpId = WorkpieceId("drawer-wp-1");
    initTaskEventDir(LINE_DIR, wpId);
    const startedAt = "2026-04-01T10:00:00Z";
    appendTaskEvent(LINE_DIR, wpId, StationName("plan"), { kind: "lifecycle", summary: "Started", detail: { subtype: "started" } });
    appendTaskEvent(LINE_DIR, wpId, StationName("plan"), { kind: "heartbeat", summary: "tick 1 · elapsed 5s · silent 2s" });
    appendTaskEvent(LINE_DIR, wpId, StationName("plan"), { kind: "tool_call", summary: "Read /foo/bar.ts", detail: { tool_name: "Read", input_preview: '{"file_path":"/foo/bar.ts"}' } });
    appendTaskEvent(LINE_DIR, wpId, StationName("plan"), { kind: "lifecycle", summary: "Finished", detail: { subtype: "finished" } });
    updateTaskEventIndex(LINE_DIR, wpId, StationName("plan"), "ok", startedAt, "2026-04-01T10:01:00Z");
  });

  test("/api/task-events/:line/:wpId returns station list", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/task-events/drawer-test-line/drawer-wp-1`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stations).toBeDefined();
    expect(Array.isArray(data.stations)).toBe(true);
    const planStation = data.stations.find((s: any) => s.name === "plan");
    expect(planStation).toBeDefined();
    expect(planStation.status).toBe("ok");
    expect(planStation.event_count).toBeGreaterThanOrEqual(4);
  });

  test("/api/task-events/:line/:wpId/:station returns events", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/task-events/drawer-test-line/drawer-wp-1/plan`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events).toBeDefined();
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThanOrEqual(4);
    expect(data.total).toBeGreaterThanOrEqual(4);
    // First event should be lifecycle started
    expect(data.events[0].kind).toBe("lifecycle");
    expect(data.events[0].summary).toBe("Started");
    // Last event should be lifecycle finished
    const last = data.events[data.events.length - 1];
    expect(last.kind).toBe("lifecycle");
    expect(last.summary).toBe("Finished");
  });

  test("/api/task-events/:line/:wpId/:station supports after= cursor", async () => {
    const firstRes = await fetch(
      `http://localhost:${server!.port}/api/task-events/drawer-test-line/drawer-wp-1/plan?limit=2`
    );
    const firstPage = await firstRes.json();
    const cursor = firstPage.next_cursor;

    const nextRes = await fetch(
      `http://localhost:${server!.port}/api/task-events/drawer-test-line/drawer-wp-1/plan?after=${cursor}`
    );
    expect(nextRes.status).toBe(200);
    const nextPage = await nextRes.json();
    expect(nextPage.events.every((e: any) => e.seq > cursor)).toBe(true);
  });

  test("/api/task-events returns empty stations for unknown workpiece", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/task-events/drawer-test-line/wp-does-not-exist`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stations).toEqual([]);
  });

  test("/api/task-events/:line/:wpId/:station returns empty for unknown station", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/task-events/drawer-test-line/drawer-wp-1/no-such-station`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events).toEqual([]);
    expect(data.total).toBe(0);
  });

  test("/api/workpiece includes _taskEventStations in response", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/workpiece/drawer-test-line/drawer-wp-1.json`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data._taskEventStations).toBeDefined();
    expect(Array.isArray(data._taskEventStations)).toBe(true);
  });
});
