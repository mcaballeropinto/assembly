import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { getFullState } from "../dashboard-data";
import { initSectionQueue, initLineQueue } from "../queue";

/**
 * Tests for activity log improvements:
 * - Filter toggle buttons rendering (8 event-type toggles)
 * - Retry grouping logic (consecutive retries collapsed)
 * - Clickable workpiece IDs (wp-id-link class)
 * - toggleActivityFilter and toggleRetryGroup functions
 */

const TEMP_DIR = resolve("/tmp", `assembly-test-activity-log-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "lines", "activity-test-line");

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;

let server: { stop: () => void; port: number } | null = null;

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

  // Start dashboard server
  const { startGlobalDashboard } = await import("../global-dashboard");
  const port = 14100 + Math.floor(Math.random() * 1000);
  server = startGlobalDashboard({ port });

  // Wait for server to be ready and lines discovered
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

// ─── Integration Tests ──────��──────────────────────────────────

describe("Activity Log - Filter Toggle Buttons", () => {
  test("Dashboard HTML contains 8 filter toggle buttons with correct labels", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The filter buttons are embedded in the JS template string of the dashboard
    expect(html).toContain("activity-filter-btn");
    expect(html).toContain("toggleActivityFilter");

    // The 8 filter type labels should appear in the JS code
    expect(html).toContain("'done'");
    expect(html).toContain("'retry'");
    expect(html).toContain("'error'");
    expect(html).toContain("'routed'");
    expect(html).toContain("'escalated'");
    expect(html).toContain("'received'");
    expect(html).toContain("'task done'");
    expect(html).toContain("'trigger'");
  });

  test("Dashboard HTML contains toggleActivityFilter function", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    expect(html).toContain("function toggleActivityFilter(eventType)");
  });

  test("Dashboard HTML contains toggleRetryGroup function", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    expect(html).toContain("function toggleRetryGroup(groupId)");
  });
});

describe("Activity Log - API Data", () => {
  test("Activity API returns retry events with correct fields", async () => {
    const res = await fetch(
      `http://localhost:${server!.port}/api/line/activity-test-line`
    );
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
    const res = await fetch(
      `http://localhost:${server!.port}/api/line/activity-test-line`
    );
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

describe("Activity Log - Detail View Rendering", () => {
  test("Detail view contains activity-filters container for filter buttons", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The activity-filters container holds the toggle buttons
    expect(html).toContain("activity-filters");
    // Filter types array defines the 8 buttons
    expect(html).toContain("filterTypes");
  });

  test("Detail view renders retry group elements", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // Check for retry-group related CSS and HTML structure
    expect(html).toContain("retry-group-header");
    expect(html).toContain("retry-group-entries");
    expect(html).toContain("retry-toggle");
  });

  test("Detail view renders wp-id-link elements for clickable workpiece IDs", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // Check for wp-id-link class in CSS and JS template
    expect(html).toContain("wp-id-link");
    expect(html).toContain("openDrawer");
  });

  test("Detail view filters entries based on activityFilters state", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The filtering logic uses activityFilters object
    expect(html).toContain("activityFilters");
    expect(html).toContain("filteredEntries");
  });

  test("Detail view groups consecutive retry entries", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The grouping logic creates retry_group objects
    expect(html).toContain("_type: 'retry_group'");
    expect(html).toContain("groupedEntries");
    expect(html).toContain("retryGroupCount");
  });
});

describe("Activity Log - Overview page unchanged", () => {
  test("Overview page activity rendering does NOT contain filter buttons", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The overview's activity section uses class="activity" and class="line-tag"
    expect(html).toContain("line-tag");

    // The renderOverview function should NOT contain activity-filters
    const overviewMatch = html.match(/function renderOverview[\s\S]*?function renderDetail/);
    expect(overviewMatch).toBeTruthy();
    if (overviewMatch) {
      expect(overviewMatch[0]).not.toContain("activity-filters");
      expect(overviewMatch[0]).not.toContain("toggleActivityFilter");
    }
  });
});

describe("Activity Log - Filter reset on navigation", () => {
  test("selectLine resets activityFilters to empty object", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // Check that selectLine function contains activityFilters reset
    const selectLineMatch = html.match(/function selectLine[\s\S]*?function goBack/);
    expect(selectLineMatch).toBeTruthy();
    if (selectLineMatch) {
      expect(selectLineMatch[0]).toContain("activityFilters = {}");
    }
  });

  test("goBack resets activityFilters to empty object", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // Check that goBack function contains activityFilters reset
    const goBackMatch = html.match(/function goBack[\s\S]*?function metricCard/);
    expect(goBackMatch).toBeTruthy();
    if (goBackMatch) {
      expect(goBackMatch[0]).toContain("activityFilters = {}");
    }
  });
});

describe("Activity Log - No post-DOM filter re-application needed", () => {
  test("renderDetail does filtering during render, not after DOM rebuild", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The new implementation filters during rendering, so there's no
    // setActivityFilter call after innerHTML assignment
    const renderDetailMatch = html.match(/function renderDetail[\s\S]*?function selectLine/);
    expect(renderDetailMatch).toBeTruthy();
    if (renderDetailMatch) {
      // Should NOT contain the old post-DOM filter re-application
      expect(renderDetailMatch[0]).not.toContain("setActivityFilter");
    }
  });
});

describe("Activity Log - CSS classes present", () => {
  test("CSS contains activity-filters styles", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    expect(html).toContain(".activity-filters");
    expect(html).toContain(".activity-filter-btn");
    expect(html).toContain(".activity-filter-btn.active");
  });

  test("CSS contains retry-group-header and retry-group-entries styles", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    expect(html).toContain(".retry-group-header");
    expect(html).toContain(".retry-group-entries");
    expect(html).toContain(".retry-toggle");
    expect(html).toContain(".retry-group-entries.expanded");
  });

  test("CSS contains wp-id-link styles", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    expect(html).toContain(".wp-id-link");
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
    expect(state.completed[0].id).toBe("wp-test-1");
    expect(state.completed[0].fileName).toBe("wp-test-1.json");
  });
});

// ─── Grouping Logic Tests (via rendered HTML) ─────────────────

describe("Activity Log - Retry grouping in rendered output", () => {
  test("Consecutive retry events produce retry_group in JS rendering code", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // Verify that the grouping logic handles consecutive retries
    expect(html).toContain("_type: 'retry_group'");
    expect(html).toContain("retryRun.length >= 2");
  });

  test("Retry grouping checks workpiece match for consecutive entries", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The grouping logic checks workpiece identity for consecutive retries
    expect(html).toContain("filteredEntries[gi + 1].workpiece === entry.workpiece");
  });
});

describe("Activity Log - Filter logic verification", () => {
  test("Filter logic maps event types to filter keys correctly", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // Verify the filter mapping logic is present for key event types
    expect(html).toContain("'station_done'");
    expect(html).toContain("'task_done'");
    expect(html).toContain("'retry'");
    expect(html).toContain("'routed'");
    expect(html).toContain("'escalated'");
    expect(html).toContain("'task_received'");
    expect(html).toContain("'trigger_fired'");
    expect(html).toContain("'trigger_skipped'");
    expect(html).toContain("'error_bucket'");
  });
});

// ─── Additional edge case test ────────���────────

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

  test("Single retry is not collapsed (via code verification)", async () => {
    const res = await fetch(`http://localhost:${server!.port}/`);
    const html = await res.text();

    // The grouping only collapses when retryRun.length >= 2
    expect(html).toContain("retryRun.length >= 2");
  });
});
