import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { initLineQueue } from "../queue";
import { initSectionQueue } from "../queue";

const TEMP_DIR = resolve("/tmp", `assembly-test-held-route-${Date.now()}`);
const LINE_NAME = "held-route-test-line";
const LINE_DIR = resolve(TEMP_DIR, "lines", LINE_NAME);

const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;

let server: { stop: () => void; port: number; fetch?: (req: Request) => Promise<Response> } | null = null;

function writeHeldFile(name: string, task: string) {
  const heldDir = resolve(LINE_DIR, "queues", "held");
  mkdirSync(heldDir, { recursive: true });
  writeFileSync(resolve(heldDir, name), JSON.stringify({ task, input: {} }));
}

function queueJsonFiles(queue: "held" | "inbox") {
  const dir = resolve(LINE_DIR, "queues", queue);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

async function post(path: string, body: unknown) {
  return server!.fetch!(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
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

  // Start dashboard server on an OS-assigned port to avoid parallel test collisions.
  const { startGlobalDashboard } = await import("../global-dashboard");
  server = startGlobalDashboard({ port: 0 });

  // Wait for server to discover lines
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  if (server) server.stop();
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

  test("releases next held tasks oldest first — 200 with released array", async () => {
    writeHeldFile("task-next-route-1.json", "First next task");
    await Bun.sleep(10);
    writeHeldFile("task-next-route-2.json", "Second next task");
    await Bun.sleep(10);
    writeHeldFile("task-next-route-3.json", "Third next task");

    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, {
      next: 2,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { released: string[]; skipped: string[]; errors: unknown[] };
    expect(body.released).toEqual(["task-next-route-1.json", "task-next-route-2.json"]);
    expect(body.skipped).toHaveLength(0);
    expect(body.errors).toHaveLength(0);
    expect(queueJsonFiles("held")).toEqual(["task-next-route-3.json"]);
    expect(existsSync(resolve(LINE_DIR, "queues", "inbox", "task-next-route-1.json"))).toBe(true);
    expect(existsSync(resolve(LINE_DIR, "queues", "inbox", "task-next-route-2.json"))).toBe(true);
  });

  test.each([
    { next: 0 },
    { next: -1 },
    { next: 1.2 },
    { next: "2" },
    { taskFile: "task-next-invalid.json", next: 1 },
  ])("invalid next body returns 400 without moving files: %p", async (body) => {
    rmSync(resolve(LINE_DIR, "queues", "held"), { recursive: true, force: true });
    rmSync(resolve(LINE_DIR, "queues", "inbox"), { recursive: true, force: true });
    writeHeldFile("task-next-invalid.json", "Invalid next should not move");

    const res = await post(`/api/line/${encodeURIComponent(LINE_NAME)}/release`, body);

    expect(res.status).toBe(400);
    expect(queueJsonFiles("held")).toEqual(["task-next-invalid.json"]);
    expect(queueJsonFiles("inbox")).toEqual([]);
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
    expect(body.error).toContain("taskFile, all, or next required");
  });
});
