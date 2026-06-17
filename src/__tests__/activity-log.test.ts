import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { getFullState } from "../dashboard-data";
import { initSectionQueue, initLineQueue } from "../queue";

const TEMP_DIR = resolve("/tmp", `assembly-test-activity-log-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "lines", "activity-test-line");

const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;

let server: { stop: () => void; port: number } | null = null;

function request(path: string): Promise<Response> {
  return (server as { fetch?: (req: Request) => Promise<Response> })!.fetch!(
    new Request(`http://localhost${path}`)
  );
}

const activityEntries = [
  { ts: "2026-04-01T10:00:00Z", event: "task_received", workpiece: "wp-test-1", task: "test task" },
  { ts: "2026-04-01T10:00:01Z", event: "station_start", station: "plan", workpiece: "wp-test-1" },
  { ts: "2026-04-01T10:01:00Z", event: "retry", station: "plan", workpiece: "wp-test-1", attempt: 1, delay_s: 5, error: "Worker crashed" },
  { ts: "2026-04-01T10:01:10Z", event: "retry", station: "plan", workpiece: "wp-test-1", attempt: 2, delay_s: 15, error: "Worker crashed again" },
  { ts: "2026-04-01T10:01:30Z", event: "retry", station: "plan", workpiece: "wp-test-1", attempt: 3, delay_s: 60, error: "Still crashing" },
  { ts: "2026-04-01T10:03:00Z", event: "station_done", station: "plan", workpiece: "wp-test-1", summary: "planned" },
  { ts: "2026-04-01T10:03:01Z", event: "routed", from: "plan", to: "develop", workpiece: "wp-test-1" },
  { ts: "2026-04-01T10:05:00Z", event: "task_done", workpiece: "wp-test-1", summary: "all done" },
  { ts: "2026-04-01T10:06:00Z", event: "orchestrator_start", line: "activity-test-line", stations: ["plan", "develop"] },
];

beforeAll(async () => {
  // Create line directory structure
  mkdirSync(resolve(LINE_DIR, "stations", "plan"), { recursive: true });
  mkdirSync(resolve(LINE_DIR, "stations", "develop"), { recursive: true });

  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    "name: activity-test-line\nsequence:\n  - plan\n  - develop\n"
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

  // Create a completed workpiece
  const wp = {
    id: "wp-test-1",
    line: "activity-test-line",
    task: "test task",
    input: {},
    stations: {
      plan: {
        summary: "planned",
        status: "done",
        started_at: "2026-04-01T10:00:00Z",
        finished_at: "2026-04-01T10:03:00Z",
        model: "sonnet",
        tokens: { in: 500, out: 200 },
        cost_usd: 0.005,
      },
      develop: {
        summary: "developed",
        status: "done",
        started_at: "2026-04-01T10:03:00Z",
        finished_at: "2026-04-01T10:05:00Z",
        model: "opus",
        tokens: { in: 2000, out: 1000 },
        cost_usd: 0.05,
      },
    },
  };
  writeFileSync(
    resolve(LINE_DIR, "queues", "done", "wp-test-1.json"),
    JSON.stringify(wp)
  );

  // Write activity log
  const activityJsonl = activityEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(resolve(LINE_DIR, "queues", "activity.jsonl"), activityJsonl);

  // Set env for line discovery
  process.env.ASSEMBLY_LINE_DIRS = resolve(TEMP_DIR, "lines");
  process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = resolve(TEMP_DIR, "missing-web-dist");

  // Start dashboard server on an OS-assigned port to avoid parallel test collisions.
  const { startGlobalDashboard } = await import("../global-dashboard");
  server = startGlobalDashboard({ port: 0 });

  // Wait for server to be ready and lines discovered
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  if (server) server.stop();
  if (originalWebDistDir) process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = originalWebDistDir;
  else delete process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── Integration Tests ───────────────────────────────────────────

describe("Activity Log - API Data", () => {
  test("Activity API returns retry events with correct fields", async () => {
    const res = await request("/api/line/activity-test-line");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.activity).toBeDefined();
    expect(Array.isArray(data.activity)).toBe(true);

    // Find retry events
    const retryEvents = data.activity.filter((a: any) => a.event === "retry");
    expect(retryEvents.length).toBe(3);

    // Verify retry events have correct fields for grouping
    for (const re of retryEvents) {
      expect(re.workpiece).toBe("wp-test-1");
      expect(re.station).toBe("plan");
      expect(re.attempt).toBeDefined();
      expect(re.delay_s).toBeDefined();
      expect(re.error).toBeDefined();
    }
  });

  test("Activity data includes all event types", async () => {
    const res = await request("/api/line/activity-test-line");
    const data = await res.json();

    const events = data.activity.map((a: any) => a.event);
    expect(events).toContain("task_received");
    expect(events).toContain("retry");
    expect(events).toContain("station_done");
    expect(events).toContain("routed");
    expect(events).toContain("task_done");
    expect(events).toContain("orchestrator_start");
  });
});

describe("Activity Log - Backward compatibility", () => {
  test("getFullState still returns all expected fields", async () => {
    const state = (await getFullState(LINE_DIR)) as any;

    expect(state).toHaveProperty("line", "activity-test-line");
    expect(state).toHaveProperty("sequence");
    expect(state).toHaveProperty("lineQueue");
    expect(state).toHaveProperty("sections");
    expect(state).toHaveProperty("activity");
    expect(state).toHaveProperty("completed");
    expect(state).toHaveProperty("errors");
    expect(state).toHaveProperty("reviews");
    expect(state).toHaveProperty("triggers");
    expect(state).toHaveProperty("timestamp");
  });

  test("Activity entries without workpiece field are included", async () => {
    const state = (await getFullState(LINE_DIR)) as any;

    // orchestrator_start has no workpiece field
    const orchEvent = state.activity.find(
      (a: any) => a.event === "orchestrator_start"
    );
    expect(orchEvent).toBeDefined();
    expect(orchEvent.workpiece).toBeUndefined();
  });

  test("Completed workpieces are still correctly listed", async () => {
    const state = (await getFullState(LINE_DIR)) as any;

    expect(state.completed).toBeDefined();
    expect(state.completed.length).toBe(1);
    expect(state.completed[0].id as string).toBe("wp-test-1");
    expect(state.completed[0].fileName).toBe("wp-test-1.json");
  });
});

// ─── Additional edge case test ───────────────────

describe("Activity Log - Edge cases", () => {
  test("Empty activity line shows no-activity message", async () => {
    // Create a line with no activity
    const emptyLineDir = resolve(TEMP_DIR, "lines", "empty-activity-line");
    mkdirSync(resolve(emptyLineDir, "stations", "plan"), { recursive: true });
    writeFileSync(
      resolve(emptyLineDir, "line.yaml"),
      "name: empty-activity-line\nsequence:\n  - plan\n"
    );
    writeFileSync(
      resolve(emptyLineDir, "stations", "plan", "AGENT.md"),
      "---\n---\nPlan station"
    );
    initSectionQueue(resolve(emptyLineDir, "stations", "plan"));
    initLineQueue(emptyLineDir);

    const state = (await getFullState(emptyLineDir)) as any;
    expect(state.activity).toBeDefined();
    expect(state.activity.length).toBe(0);
  });

  test("Mixed retry sequences for different workpieces in activity data", async () => {
    // Create a separate line with mixed retries
    const mixedDir = resolve(TEMP_DIR, "lines", "mixed-retry-line");
    mkdirSync(resolve(mixedDir, "stations", "plan"), { recursive: true });
    writeFileSync(
      resolve(mixedDir, "line.yaml"),
      "name: mixed-retry-line\nsequence:\n  - plan\n"
    );
    writeFileSync(
      resolve(mixedDir, "stations", "plan", "AGENT.md"),
      "---\n---\nPlan station"
    );
    initSectionQueue(resolve(mixedDir, "stations", "plan"));
    initLineQueue(mixedDir);

    // Write activity with mixed retry sequences
    const mixedActivity = [
      { ts: "2026-04-01T10:01:00Z", event: "retry", station: "plan", workpiece: "wp-a", attempt: 1, error: "err1" },
      { ts: "2026-04-01T10:01:01Z", event: "retry", station: "plan", workpiece: "wp-a", attempt: 2, error: "err2" },
      { ts: "2026-04-01T10:01:02Z", event: "retry", station: "plan", workpiece: "wp-b", attempt: 1, error: "err3" },
      { ts: "2026-04-01T10:01:03Z", event: "retry", station: "plan", workpiece: "wp-b", attempt: 2, error: "err4" },
    ];
    writeFileSync(
      resolve(mixedDir, "queues", "activity.jsonl"),
      mixedActivity.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );

    const state = (await getFullState(mixedDir)) as any;
    expect(state.activity.length).toBe(4);

    // All 4 retry events should be present in raw data
    const retries = state.activity.filter((a: any) => a.event === "retry");
    expect(retries.length).toBe(4);

    // Should have retries for both wp-a and wp-b
    const wpARetries = retries.filter((a: any) => a.workpiece === "wp-a");
    const wpBRetries = retries.filter((a: any) => a.workpiece === "wp-b");
    expect(wpARetries.length).toBe(2);
    expect(wpBRetries.length).toBe(2);
  });

});
