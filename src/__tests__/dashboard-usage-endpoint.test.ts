import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "fs";

const TEMP_DIR = resolve("/tmp", `assembly-test-usage-route-${Date.now()}-${process.pid}`);
const SNAP_PATH = resolve(TEMP_DIR, "usage-status.json");
const LINE_DIR = resolve(TEMP_DIR, "lines");

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;

let server: { stop: () => void; port: number } | null = null;
let testPort: number;

function writeSnapshot(payload: unknown) {
  writeFileSync(SNAP_PATH, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function removeSnapshot() {
  if (existsSync(SNAP_PATH)) unlinkSync(SNAP_PATH);
}

beforeAll(async () => {
  mkdirSync(LINE_DIR, { recursive: true });
  process.env.ASSEMBLY_LINE_DIRS = LINE_DIR;
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = SNAP_PATH;
  process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = resolve(TEMP_DIR, "missing-web-dist");

  const { startGlobalDashboard } = await import("../global-dashboard");
  for (let attempt = 0; attempt < 20 && !server; attempt++) {
    testPort = 20000 + Math.floor(Math.random() * 30000);
    try {
      server = startGlobalDashboard({ port: testPort });
    } catch (err) {
      if (!String((err as Error).message).includes("port")) throw err;
    }
  }
  if (!server) throw new Error("Unable to start dashboard test server");
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(() => {
  if (server) server.stop();
  if (originalLineDirs === undefined) delete process.env.ASSEMBLY_LINE_DIRS;
  else process.env.ASSEMBLY_LINE_DIRS = originalLineDirs;
  if (originalSnapEnv === undefined) delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
  else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalSnapEnv;
  if (originalWebDistDir === undefined) delete process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
  else process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = originalWebDistDir;
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  removeSnapshot();
});

describe("GET /api/usage", () => {
  test("returns snapshot + ageMs when file present", async () => {
    const checkedAt = new Date(Date.now() - 5000).toISOString();
    writeSnapshot({
      checkedAt,
      threshold: 75,
      paused: false,
      providers: {
        codex: {
          buckets: [
            { label: "5h session", utilization: 17, resets_at: "2026-04-20T15:00:00Z" },
            { label: "7d", utilization: 28, resets_at: "2026-04-24T16:00:00Z" },
          ],
        },
      },
    });
    const res = await fetch(`http://localhost:${testPort}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checkedAt: string;
      threshold: number;
      paused: boolean;
      providers: Record<string, { buckets: Array<{ label: string; utilization: number }> }>;
      ageMs: number;
    };
    expect(body.checkedAt).toBe(checkedAt);
    expect(body.threshold).toBe(75);
    expect(body.paused).toBe(false);
    expect(body.providers.codex.buckets.length).toBe(2);
    expect(body.providers.codex.buckets[0].label).toBe("5h session");
    expect(typeof body.ageMs).toBe("number");
    expect(body.ageMs).toBeGreaterThanOrEqual(0);
  });

  test("paused snapshot round-trips with pauseReason", async () => {
    writeSnapshot({
      checkedAt: new Date().toISOString(),
      threshold: 75,
      paused: true,
      pauseReason: "codex: 5h session at 81.2% (>= 75%), resets 2026-04-20T15:00:00Z",
      providers: {
        codex: {
          buckets: [
            { label: "5h session", utilization: 81.2, resets_at: "2026-04-20T15:00:00Z" },
          ],
        },
      },
    });
    const res = await fetch(`http://localhost:${testPort}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json() as { paused: boolean; pauseReason: string };
    expect(body.paused).toBe(true);
    expect(body.pauseReason).toMatch(/81\.2%/);
  });

  test("returns { state: 'unknown' } when snapshot missing (200, not 500)", async () => {
    removeSnapshot();
    const res = await fetch(`http://localhost:${testPort}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string; reason?: string };
    expect(body.state).toBe("unknown");
    expect(body.reason).toBeDefined();
  });

  test("malformed JSON snapshot is treated as unknown (200, not 500)", async () => {
    writeSnapshot("{not valid json]]]");
    const res = await fetch(`http://localhost:${testPort}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string };
    expect(body.state).toBe("unknown");
  });

  test("ageMs is null when checkedAt is not a valid ISO date", async () => {
    writeSnapshot({
      checkedAt: "not-a-date",
      threshold: 75,
      paused: false,
      providers: { codex: { buckets: [] } },
    });
    const res = await fetch(`http://localhost:${testPort}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json() as { checkedAt: string; ageMs: number | null };
    expect(body.checkedAt).toBe("not-a-date");
    expect(body.ageMs).toBeNull();
  });
});

describe("Dashboard HTML exposes usage panel mount + client JS", () => {
  test("HTML contains usage-panel-mount and loadUsage", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    const html = await res.text();
    expect(html).toContain("usage-panel-mount");
    expect(html).toContain("loadUsage");
    expect(html).toContain("providers['codex']");
    expect(html).not.toContain("providers['claude-code']");
  });

  test("HTML contains compact usage indicator mount + popover plumbing", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    const html = await res.text();
    // Compact mount lives inside the subtitle header row.
    expect(html).toContain('id="usage-compact-mount"');
    // View-state CSS swaps compact vs full card between detail/overview.
    expect(html).toContain("body.view-detail #usage-panel-mount");
    expect(html).toContain("body:not(.view-detail) #usage-compact-mount");
    // Client-side builders + popover interaction helpers are wired up.
    expect(html).toContain("buildUsageCompactHtml");
    expect(html).toContain("toggleUsagePopover");
    expect(html).toContain("handleUsagePopoverKey");
    // prefers-reduced-motion branch present for the popover.
    expect(html).toContain("prefers-reduced-motion: reduce");
    // applyViewState is what toggles body.view-detail and re-renders usage.
    expect(html).toContain("applyViewState");
  });
});
