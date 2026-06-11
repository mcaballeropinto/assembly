import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { initLineQueue } from "../queue";
import { initSectionQueue } from "../queue";

const TEMP_DIR = resolve("/tmp", `assembly-test-held-route-${Date.now()}`);
const LINE_NAME = "held-route-test-line";
const LINE_DIR = resolve(TEMP_DIR, "lines", LINE_NAME);

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;
const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;

let server: { stop: () => void; port: number } | null = null;
let testPort: number;

function writeHeldFile(name: string, task: string) {
  const heldDir = resolve(LINE_DIR, "queues", "held");
  mkdirSync(heldDir, { recursive: true });
  writeFileSync(resolve(heldDir, name), JSON.stringify({ task, input: {} }));
}

async function post(path: string, body: unknown) {
  return fetch(`http://localhost:${testPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Create line directory structure
  const stationDir = resolve(LINE_DIR, "stations", "step-one");
  mkdirSync(stationDir, { recursive: true });

  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    `name: ${LINE_NAME}\nsequence:\n  - step-one\n`
  );
  writeFileSync(resolve(stationDir, "AGENT.md"), "---\n---\nStep One");

  initSectionQueue(stationDir);
  initLineQueue(LINE_DIR);

  // Write two held files for tests
  writeHeldFile("task-1.json", "First held task");
  writeHeldFile("task-2.json", "Second held task");

  // Set env so the dashboard discovers our temp line
  process.env.ASSEMBLY_LINE_DIRS = resolve(TEMP_DIR, "lines");
  process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = resolve(TEMP_DIR, "missing-web-dist");

  // Start dashboard server on a random port
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

  // Wait for server to discover lines
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  if (server) server.stop();
  if (originalLineDirs) {
    process.env.ASSEMBLY_LINE_DIRS = originalLineDirs;
  } else {
    delete process.env.ASSEMBLY_LINE_DIRS;
  }
  if (originalWebDistDir === undefined) delete process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
  else process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = originalWebDistDir;
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("POST /api/line/:name/release", () => {
  test("releases a specific taskFile — 200 with released array", async () => {
    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, {
      taskFile: "task-1.json",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { released: string[]; skipped: string[]; errors: unknown[] };
    expect(body.released).toContain("task-1.json");
    expect(body.skipped).toHaveLength(0);
    expect(body.errors).toHaveLength(0);
    // File should now be in inbox
    expect(existsSync(resolve(LINE_DIR, "queues", "inbox", "task-1.json"))).toBe(true);
    expect(existsSync(resolve(LINE_DIR, "queues", "held", "task-1.json"))).toBe(false);
  });

  test("releases all with { all: true } — 200, held/ empty after", async () => {
    // task-2.json should still be in held
    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, {
      all: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { released: string[]; skipped: string[]; errors: unknown[] };
    // task-1 was already moved, so it should be skipped or task-2 was released
    expect(body.errors).toHaveLength(0);
    // held/ should be empty
    const { readdirSync } = await import("fs");
    const heldDir = resolve(LINE_DIR, "queues", "held");
    const remaining = existsSync(heldDir)
      ? readdirSync(heldDir).filter((f: string) => f.endsWith(".json"))
      : [];
    expect(remaining.length).toBe(0);
  });

  test("path traversal returns 400", async () => {
    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, {
      taskFile: "../evil.json",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Invalid.*taskFile|taskFile/i);
  });

  test("non-existent file returns 200 with skipped", async () => {
    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, {
      taskFile: "nope.json",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { released: string[]; skipped: string[]; errors: unknown[] };
    expect(body.released).toHaveLength(0);
    expect(body.skipped).toContain("nope.json");
    expect(body.errors).toHaveLength(0);
  });

  test("unknown line returns 404", async () => {
    const res = await post(`/api/line/no-such-line/release`, {
      taskFile: "task-1.json",
    });
    expect(res.status).toBe(404);
  });

  test("empty body returns 400", async () => {
    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, {});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("taskFile or all required");
  });
});

describe("Dashboard HTML contains held release JS and CSS", () => {
  test("Dashboard HTML contains releaseCard function", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    const html = await res.text();
    expect(html).toContain("releaseCard");
    expect(html).toContain("releaseAllHeld");
    expect(html).toContain("onHeldCardKeydown");
  });

  test("Dashboard HTML contains held CSS rules", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    const html = await res.text();
    expect(html).toContain("held-card");
    expect(html).toContain("release-btn");
    expect(html).toContain("prefers-reduced-motion");
  });
});
