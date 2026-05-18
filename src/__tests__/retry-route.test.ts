import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
import { initLineQueue, initSectionQueue } from "../queue";
import { readDismissed } from "../error-dismiss";

const TEMP_DIR = resolve("/tmp", `assembly-test-retry-route-${Date.now()}`);
const LINE_NAME = "retry-route-test-line";
const LINE_DIR = resolve(TEMP_DIR, "lines", LINE_NAME);

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;

let server: { stop: () => void; port: number } | null = null;
let testPort: number;

function seedErrorFile(name: string, id: string) {
  const errorDir = resolve(LINE_DIR, "queues", "error");
  mkdirSync(errorDir, { recursive: true });
  writeFileSync(
    resolve(errorDir, name),
    JSON.stringify({
      id,
      line: LINE_NAME,
      task: "Task needing retry",
      input: { key: "val" },
      stations: {
        plan: {
          summary: "failed",
          status: "failed",
          started_at: "2026-04-01T00:00:00Z",
          finished_at: "2026-04-01T00:00:05Z",
          model: "sonnet",
          tokens: { in: 10, out: 5 },
          cost_usd: 0.001,
        },
      },
    })
  );
}

async function post(path: string, body: unknown) {
  return fetch(`http://localhost:${testPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const stationDir = resolve(LINE_DIR, "stations", "plan");
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    `name: ${LINE_NAME}\nsequence:\n  - plan\n`
  );
  writeFileSync(resolve(stationDir, "AGENT.md"), "---\n---\nPlan");

  initSectionQueue(stationDir);
  initLineQueue(LINE_DIR);

  process.env.ASSEMBLY_LINE_DIRS = resolve(TEMP_DIR, "lines");

  const { startGlobalDashboard } = await import("../global-dashboard");
  testPort = 16800 + Math.floor(Math.random() * 200);
  server = startGlobalDashboard({ port: testPort });

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

describe("POST /api/line/:name/retry", () => {
  test("retries an errored workpiece — 200, new inbox file, original dismissed, activity logged", async () => {
    seedErrorFile("wp-retry-1.json", "run-original-1");

    const res = await post(
      `/api/line/${encodeURIComponent(LINE_NAME)}/retry`,
      { fileName: "wp-retry-1.json" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      newId: string;
      newFileName: string;
    };
    expect(body.ok).toBe(true);
    expect(body.newFileName).toBe(body.newId + ".json");

    // New inbox file
    const inboxPath = resolve(LINE_DIR, "queues", "inbox", body.newFileName);
    expect(existsSync(inboxPath)).toBe(true);
    const written = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(written.id).toBe(body.newId);
    expect(written.task).toBe("Task needing retry");
    expect(written.input).toEqual({ key: "val" });
    expect(written.parent_run_id).toBe("run-original-1");

    // Original dismissed
    const dismissed = readDismissed(LINE_DIR);
    expect(Object.keys(dismissed)).toContain("wp-retry-1.json");

    // Activity log got a retry_manual event
    const logPath = resolve(LINE_DIR, "queues", "activity.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const logLines = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const retryEvents = logLines.filter((e) => e.event === "retry_manual");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    const last = retryEvents[retryEvents.length - 1];
    expect(last.workpiece).toBe(body.newId);
    expect(last.parent_run_id).toBe("run-original-1");
    expect(last.source_file).toBe("wp-retry-1.json");
  });

  test("path traversal — 400", async () => {
    const res = await post(
      `/api/line/${encodeURIComponent(LINE_NAME)}/retry`,
      { fileName: "../evil.json" }
    );
    expect(res.status).toBe(400);
  });

  test("missing fileName — 400", async () => {
    const res = await post(
      `/api/line/${encodeURIComponent(LINE_NAME)}/retry`,
      {}
    );
    expect(res.status).toBe(400);
  });

  test("unknown error file — 404", async () => {
    const res = await post(
      `/api/line/${encodeURIComponent(LINE_NAME)}/retry`,
      { fileName: "never-existed.json" }
    );
    expect(res.status).toBe(404);
  });

  test("unknown line — 404", async () => {
    const res = await post(`/api/line/no-such-line/retry`, {
      fileName: "wp.json",
    });
    expect(res.status).toBe(404);
  });
});

describe("Dashboard HTML contains drawer retry/dismiss JS and CSS", () => {
  test("HTML contains retry/dismiss handlers", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    const html = await res.text();
    expect(html).toContain("retryErroredWorkpiece");
    expect(html).toContain("confirmDismissForever");
    expect(html).toContain("dismissForever");
  });

  test("HTML contains drawer action CSS", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    const html = await res.text();
    expect(html).toContain("drawer-actions");
    expect(html).toContain("drawer-action-primary");
    expect(html).toContain("drawer-action-danger");
  });
});
