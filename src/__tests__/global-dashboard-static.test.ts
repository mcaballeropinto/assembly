import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";

const TEMP_DIR = resolve("/tmp", `assembly-test-dashboard-static-${Date.now()}-${process.pid}`);
const LINE_DIR = resolve(TEMP_DIR, "lines");
const WEB_DIST_DIR = resolve(TEMP_DIR, "web-dist");
const INDEX_PATH = resolve(WEB_DIST_DIR, "index.html");
const ASSETS_DIR = resolve(WEB_DIST_DIR, "assets");
const CSS_PATH = resolve(ASSETS_DIR, "test-dashboard.css");

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;
const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;

let server: { stop: () => void; port: number; fetch?: (req: Request) => Promise<Response> } | null = null;

function writeTestBundle() {
  mkdirSync(ASSETS_DIR, { recursive: true });
  writeFileSync(
    INDEX_PATH,
    '<!doctype html><html><head><title>Assembly Vite Test</title></head><body><div id="root">vite-dist-marker</div></body></html>'
  );
  writeFileSync(CSS_PATH, ".dashboard-test { color: rgb(1, 2, 3); }\n");
}

beforeAll(async () => {
  mkdirSync(LINE_DIR, { recursive: true });
  writeTestBundle();

  process.env.ASSEMBLY_LINE_DIRS = LINE_DIR;
  process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = WEB_DIST_DIR;

  const { startGlobalDashboard } = await import("../global-dashboard");
  server = startGlobalDashboard({ port: 0 });
  if (!server) throw new Error("Unable to start dashboard test server");
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(() => {
  if (server) server.stop();
  if (originalLineDirs === undefined) delete process.env.ASSEMBLY_LINE_DIRS;
  else process.env.ASSEMBLY_LINE_DIRS = originalLineDirs;
  if (originalWebDistDir === undefined) delete process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
  else process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = originalWebDistDir;
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  writeTestBundle();
});

afterEach(() => {
  writeTestBundle();
});

describe("dashboard static bundle serving", () => {
  function request(path: string): Promise<Response> {
    if (!server?.fetch) throw new Error("Dashboard test fetch handler missing");
    return server.fetch(new Request(`http://localhost${path}`));
  }

  test("serves web/dist/index.html for root and client routes", async () => {
    const rootRes = await request("/");
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type") ?? "").toContain("text/html");
    expect(await rootRes.text()).toContain("vite-dist-marker");

    const routeRes = await request("/line/example/workpiece/123");
    expect(routeRes.status).toBe(200);
    expect(routeRes.headers.get("content-type") ?? "").toContain("text/html");
    expect(await routeRes.text()).toContain("vite-dist-marker");
  });

  test("serves assets from web/dist/assets with MIME type", async () => {
    const res = await request("/assets/test-dashboard.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/css");
    expect(await res.text()).toBe(".dashboard-test { color: rgb(1, 2, 3); }\n");
  });

  test("returns 404 for missing assets and traversal attempts", async () => {
    const missing = await request("/assets/nope.css");
    expect(missing.status).toBe(404);

    const traversal = await request("/assets/%2e%2e%2findex.html");
    expect(traversal.status).toBe(404);
  });

  test("keeps API routes ahead of SPA and assets", async () => {
    const res = await request("/api/state");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = await res.json() as { version: string };
    expect(body.version).toBe("2026.05.24");
  });

  test("falls back to legacy embedded dashboard when index.html is absent", async () => {
    if (existsSync(INDEX_PATH)) unlinkSync(INDEX_PATH);

    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Global Dashboard");
    expect(html).toContain("usage-compact-mount");
    expect(html).toContain("loadUsage");
  });
});
