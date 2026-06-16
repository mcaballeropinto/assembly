import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { createServer } from "node:net";

const TEMP_DIR = resolve("/tmp", `assembly-test-usage-route-${Date.now()}-${process.pid}`);
const SNAP_PATH = resolve(TEMP_DIR, "usage-status.json");
const LINE_DIR = resolve(TEMP_DIR, "lines");

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;
const originalSnapEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
const originalDashboardToken = process.env.ASSEMBLY_DASHBOARD_TOKEN;

let server: { stop: () => void; port: number; fetch?: (req: Request) => Promise<Response> } | null = null;

function writeSnapshot(payload: unknown) {
  writeFileSync(SNAP_PATH, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function removeSnapshot() {
  if (existsSync(SNAP_PATH)) unlinkSync(SNAP_PATH);
}

function request(path: string): Promise<Response> {
  return server!.fetch!(new Request(`http://localhost${path}`));
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.unref();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (typeof address !== "object" || address === null) {
        listener.close();
        reject(new Error("Could not allocate a temporary port"));
        return;
      }
      const port = address.port;
      listener.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

beforeAll(async () => {
  mkdirSync(LINE_DIR, { recursive: true });
  process.env.ASSEMBLY_LINE_DIRS = LINE_DIR;
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = SNAP_PATH;
  process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = resolve(TEMP_DIR, "missing-web-dist");

  const { startGlobalDashboard } = await import("../global-dashboard");
  server = startGlobalDashboard({ port: 0 });
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
  if (originalDashboardToken === undefined) delete process.env.ASSEMBLY_DASHBOARD_TOKEN;
  else process.env.ASSEMBLY_DASHBOARD_TOKEN = originalDashboardToken;
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
    const res = await request("/api/usage");
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
    const res = await request("/api/usage");
    expect(res.status).toBe(200);
    const body = await res.json() as { paused: boolean; pauseReason: string };
    expect(body.paused).toBe(true);
    expect(body.pauseReason).toMatch(/81\.2%/);
  });

  test("returns { state: 'unknown' } when snapshot missing (200, not 500)", async () => {
    removeSnapshot();
    const res = await request("/api/usage");
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string; reason?: string };
    expect(body.state).toBe("unknown");
    expect(body.reason).toBeDefined();
  });

  test("malformed JSON snapshot is treated as unknown (200, not 500)", async () => {
    writeSnapshot("{not valid json]]]");
    const res = await request("/api/usage");
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
    const res = await request("/api/usage");
    expect(res.status).toBe(200);
    const body = await res.json() as { checkedAt: string; ageMs: number | null };
    expect(body.checkedAt).toBe("not-a-date");
    expect(body.ageMs).toBeNull();
  });

  test("default host binds a real server to 127.0.0.1", async () => {
    const { startGlobalDashboard } = await import("../global-dashboard");
    const port = await getAvailablePort();
    const realServer = startGlobalDashboard({ port });
    try {
      const res = await fetch(`http://127.0.0.1:${realServer.port}/api/usage`);
      expect(res.status).toBe(200);
    } finally {
      realServer.stop();
    }
  });

  test("explicit loopback host binds a real server to 127.0.0.1", async () => {
    const { startGlobalDashboard } = await import("../global-dashboard");
    const port = await getAvailablePort();
    const realServer = startGlobalDashboard({ port, host: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${realServer.port}/api/usage`);
      expect(res.status).toBe(200);
    } finally {
      realServer.stop();
    }
  });

  test("non-loopback host without token warns but does not refuse yet", async () => {
    const { startGlobalDashboard } = await import("../global-dashboard");
    const originalWarn = console.warn;
    const warnings: string[] = [];
    delete process.env.ASSEMBLY_DASHBOARD_TOKEN;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    let warningServer: { stop: () => void } | null = null;
    try {
      warningServer = startGlobalDashboard({ port: 0, host: "0.0.0.0" });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("non-loopback");
      expect(warnings[0]).toContain("ASSEMBLY_DASHBOARD_TOKEN");
    } finally {
      if (warningServer) warningServer.stop();
      console.warn = originalWarn;
      if (originalDashboardToken === undefined) delete process.env.ASSEMBLY_DASHBOARD_TOKEN;
      else process.env.ASSEMBLY_DASHBOARD_TOKEN = originalDashboardToken;
    }
  });
});
