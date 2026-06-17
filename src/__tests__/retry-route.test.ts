import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";
import { initLineQueue, initSectionQueue } from "../queue";
import { readDismissed } from "../error-dismiss";

const TEMP_DIR = resolve("/tmp", `assembly-test-retry-route-${Date.now()}`);
const LINE_NAME = "retry-route-test-line";
const LINE_DIR = resolve(TEMP_DIR, "lines", LINE_NAME);

let server: { stop: () => void; port: number; fetch?: (req: Request) => Promise<Response> } | null = null;

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

function seedReviewFile(name: string, id: string) {
  const reviewDir = resolve(LINE_DIR, "queues", "review");
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(
    resolve(reviewDir, name),
    JSON.stringify({
      id,
      line: LINE_NAME,
      task: "Task needing review retry",
      input: { key: "review" },
      stations: {
        plan: {
          summary: "planned",
          status: "done",
          started_at: "2026-04-01T00:00:00Z",
          finished_at: "2026-04-01T00:00:05Z",
          model: "sonnet",
          tokens: { in: 10, out: 5 },
          cost_usd: 0.001,
        },
        develop: {
          summary: "Escalated: tests failed",
          status: "escalated",
          data: { escalation_reason: "Tests failed in develop worktree" },
          eval: { pass: false, feedback: "Tests failed in develop worktree", action: "retry" },
          started_at: "2026-04-01T00:00:05Z",
          finished_at: "2026-04-01T00:00:10Z",
          model: "script",
          tokens: { in: 0, out: 0 },
          cost_usd: 0,
        },
      },
    })
  );
}

async function post(path: string, body: unknown) {
  return server!.fetch!(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
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

  const { startGlobalDashboard } = await import("../global-dashboard");
  server = startGlobalDashboard({
    port: 0,
    lineDirs: [resolve(TEMP_DIR, "lines")],
    webDistDir: resolve(TEMP_DIR, "missing-web-dist"),
  });
});

afterAll(() => {
  if (server) server.stop();
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

describe("POST /api/line/:name/retry-review", () => {
  test("requeues a review workpiece at the escalated station", async () => {
    seedReviewFile("wp-review-route-1.json", "run-review-route-1");

    const res = await post(
      `/api/line/${encodeURIComponent(LINE_NAME)}/retry-review`,
      { fileName: "wp-review-route-1.json" }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; fileName: string; station: string };
    expect(body.ok).toBe(true);
    expect(body.fileName).toBe("wp-review-route-1.json");
    expect(body.station).toBe("develop");

    const inboxPath = resolve(LINE_DIR, "stations", "develop", "queue", "inbox", "wp-review-route-1.json");
    expect(existsSync(inboxPath)).toBe(true);
    const written = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(written.stations.develop.previous_attempts[0].eval.feedback).toContain("Tests failed");
    expect(existsSync(resolve(LINE_DIR, "queues", "review", ".retried", "wp-review-route-1.json"))).toBe(true);
  });
});
