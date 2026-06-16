import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { initLineQueue, initSectionQueue } from "../queue";

const STATE_TTL_WAIT_MS = 2100;
const FLOW_TTL_WAIT_MS = 5100;

type TestServer = {
  stop: () => void;
  port: number;
  fetch?: (req: Request) => Promise<Response>;
};

type Fixture = {
  root: string;
  lineName: string;
  lineDir: string;
  server: TestServer;
};

const originalLineDirs = process.env.ASSEMBLY_LINE_DIRS;
const originalWebDistDir = process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
let currentFixture: Fixture | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(): void {
  if (originalLineDirs === undefined) delete process.env.ASSEMBLY_LINE_DIRS;
  else process.env.ASSEMBLY_LINE_DIRS = originalLineDirs;
  if (originalWebDistDir === undefined) delete process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR;
  else process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = originalWebDistDir;
}

function workpiece(id: string, status: "done" | "failed" = "done") {
  const started = "2026-04-01T00:00:00Z";
  const finished = "2026-04-01T00:00:05Z";
  return {
    id,
    line: currentFixture?.lineName ?? "cache-test-line",
    task: `Task ${id}`,
    input: { id },
    stations: {
      plan: {
        summary: status === "done" ? "completed" : "failed",
        content: "",
        status,
        started_at: started,
        finished_at: finished,
        model: "test-model",
        tokens: { in: 1, out: 1 },
        cost_usd: 0,
      },
    },
  };
}

function writeQueueFile(lineDir: string, queue: "inbox" | "done" | "error" | "held", fileName: string, value: unknown): void {
  const dir = resolve(lineDir, "queues", queue);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fileName), JSON.stringify(value));
}

function findColumn(body: any, key: string) {
  return body.columns.find((column: { key: string }) => column.key === key);
}

function itemsInFlight(body: any): number {
  const tile = body.tiles.find((t: { label: string }) => t.label === "Items in Flight");
  if (!tile) throw new Error("Items in Flight tile missing");
  return tile.rawValue;
}

async function createFixture(testName: string): Promise<Fixture> {
  const root = resolve("/tmp", `assembly-test-dashboard-cache-${testName}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const lineName = `cache-${testName}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const lineDir = resolve(root, "lines", lineName);
  const stationDir = resolve(lineDir, "stations", "plan");

  mkdirSync(stationDir, { recursive: true });
  writeFileSync(resolve(lineDir, "line.yaml"), `name: ${lineName}\nsequence:\n  - plan\n`);
  writeFileSync(resolve(stationDir, "AGENT.md"), "---\n---\nPlan");
  initSectionQueue(stationDir);
  initLineQueue(lineDir);

  process.env.ASSEMBLY_LINE_DIRS = resolve(root, "lines");
  process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR = resolve(root, "missing-web-dist");

  const { startGlobalDashboard } = await import("../global-dashboard");
  const server = startGlobalDashboard({ port: 0 });
  currentFixture = { root, lineName, lineDir, server };

  await sleep(STATE_TTL_WAIT_MS);
  return currentFixture;
}

async function request(path: string): Promise<Response> {
  if (!currentFixture?.server.fetch) throw new Error("Dashboard test fetch handler missing");
  return currentFixture.server.fetch(new Request(`http://localhost${path}`));
}

async function post(path: string, body: unknown): Promise<Response> {
  if (!currentFixture?.server.fetch) throw new Error("Dashboard test fetch handler missing");
  return currentFixture.server.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

afterEach(() => {
  if (currentFixture) {
    currentFixture.server.stop();
    rmSync(currentFixture.root, { recursive: true, force: true });
    currentFixture = null;
  }
  restoreEnv();
});

describe("global dashboard snapshot cache", () => {
  test("caches global state until its TTL expires", async () => {
    const fixture = await createFixture("global-ttl");

    const firstGlobal = await (await request("/api/state")).json() as any;
    writeQueueFile(fixture.lineDir, "done", "done-1.json", workpiece("done-1"));
    const cachedGlobal = await (await request("/api/state")).json() as any;
    expect(cachedGlobal.timestamp).toBe(firstGlobal.timestamp);
    expect(cachedGlobal.totals.totalDone).toBe(0);

    await sleep(STATE_TTL_WAIT_MS);
    const refreshedGlobal = await (await request("/api/state")).json() as any;
    expect(refreshedGlobal.timestamp).not.toBe(firstGlobal.timestamp);
    expect(refreshedGlobal.totals.totalDone).toBe(1);
  }, 7_000);

  test("caches per-line state until its TTL expires", async () => {
    const fixture = await createFixture("line-ttl");
    const linePath = `/api/line/${encodeURIComponent(fixture.lineName)}`;

    writeQueueFile(fixture.lineDir, "done", "done-1.json", workpiece("done-1"));
    const firstLine = await (await request(linePath)).json() as any;
    writeQueueFile(fixture.lineDir, "done", "done-2.json", workpiece("done-2"));
    const cachedLine = await (await request(linePath)).json() as any;
    expect(cachedLine.timestamp).toBe(firstLine.timestamp);
    expect(cachedLine.lineQueue.done).toBe(1);

    await sleep(STATE_TTL_WAIT_MS);
    const refreshedLine = await (await request(linePath)).json() as any;
    expect(refreshedLine.timestamp).not.toBe(firstLine.timestamp);
    expect(refreshedLine.lineQueue.done).toBe(2);
  }, 7_000);

  test("caches kanban state until its TTL expires", async () => {
    const fixture = await createFixture("kanban-ttl");
    const linePath = `/api/line/${encodeURIComponent(fixture.lineName)}`;

    const firstKanban = await (await request(`${linePath}/kanban`)).json() as any;
    writeQueueFile(fixture.lineDir, "inbox", "inbox-1.json", workpiece("inbox-1"));
    const cachedKanban = await (await request(`${linePath}/kanban`)).json() as any;
    expect(cachedKanban.lastUpdated).toBe(firstKanban.lastUpdated);
    expect(findColumn(cachedKanban, "inbox").cards.some((c: { id: string }) => c.id === "inbox-1")).toBe(false);

    await sleep(STATE_TTL_WAIT_MS);
    const refreshedKanban = await (await request(`${linePath}/kanban`)).json() as any;
    expect(refreshedKanban.lastUpdated).not.toBe(firstKanban.lastUpdated);
    expect(findColumn(refreshedKanban, "inbox").cards.some((c: { id: string }) => c.id === "inbox-1")).toBe(true);
  }, 7_000);

  test("caches flow metrics until its TTL expires", async () => {
    const fixture = await createFixture("flow-ttl");
    const linePath = `/api/line/${encodeURIComponent(fixture.lineName)}`;

    const firstFlow = await (await request(`${linePath}/flow-metrics`)).json() as any;
    writeQueueFile(fixture.lineDir, "inbox", "inbox-2.json", workpiece("inbox-2"));
    const cachedFlow = await (await request(`${linePath}/flow-metrics`)).json() as any;
    expect(cachedFlow.timestamp).toBe(firstFlow.timestamp);
    expect(itemsInFlight(cachedFlow)).toBe(itemsInFlight(firstFlow));

    await sleep(FLOW_TTL_WAIT_MS);
    const refreshedFlow = await (await request(`${linePath}/flow-metrics`)).json() as any;
    expect(refreshedFlow.timestamp).not.toBe(firstFlow.timestamp);
    expect(itemsInFlight(refreshedFlow)).toBe(itemsInFlight(firstFlow) + 1);
  }, 10_000);

  test("invalidates affected snapshots after successful mutations only", async () => {
    const fixture = await createFixture("mutations");
    const linePath = `/api/line/${encodeURIComponent(fixture.lineName)}`;

    writeQueueFile(fixture.lineDir, "error", "error-1.json", workpiece("error-1", "failed"));
    await request("/api/state");
    await request(`${linePath}/kanban`);

    const dismiss = await post(`${linePath}/errors/dismiss`, { fileNames: ["error-1.json"] });
    expect(dismiss.status).toBe(200);
    const dismissedState = await (await request("/api/state")).json() as any;
    const dismissedKanban = await (await request(`${linePath}/kanban`)).json() as any;
    expect(dismissedState.totals.totalErrors).toBe(0);
    expect(findColumn(dismissedKanban, "error")).toBeUndefined();

    const undismiss = await post(`${linePath}/errors/undismiss`, { fileNames: ["error-1.json"] });
    expect(undismiss.status).toBe(200);
    const undismissedState = await (await request("/api/state")).json() as any;
    const undismissedKanban = await (await request(`${linePath}/kanban`)).json() as any;
    expect(undismissedState.totals.totalErrors).toBe(1);
    expect(findColumn(undismissedKanban, "error").count).toBe(1);

    writeQueueFile(fixture.lineDir, "held", "held-1.json", { task: "Held task", input: {} });
    const preRelease = await (await request(linePath)).json() as any;
    const failedRelease = await post(`${linePath}/release`, { taskFile: "../evil.json" });
    expect(failedRelease.status).toBe(400);
    const afterFailedRelease = await (await request(linePath)).json() as any;
    expect(afterFailedRelease.timestamp).toBe(preRelease.timestamp);
    expect(afterFailedRelease.held).toHaveLength(preRelease.held.length);

    const release = await post(`${linePath}/release`, { taskFile: "held-1.json" });
    expect(release.status).toBe(200);
    const releasedState = await (await request(linePath)).json() as any;
    expect(releasedState.held).toHaveLength(0);
    expect(releasedState.lineQueue.inbox).toBe(1);
    expect(existsSync(resolve(fixture.lineDir, "queues", "inbox", "held-1.json"))).toBe(true);

    writeQueueFile(fixture.lineDir, "error", "error-2.json", workpiece("error-2", "failed"));
    await request("/api/state");
    await request(`${linePath}/kanban`);
    await request(`${linePath}/flow-metrics`);

    const retry = await post(`${linePath}/retry`, { fileName: "error-2.json" });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json() as { newFileName: string };
    const retriedState = await (await request("/api/state")).json() as any;
    const retriedKanban = await (await request(`${linePath}/kanban`)).json() as any;
    const retriedFlow = await (await request(`${linePath}/flow-metrics`)).json() as any;
    expect(retriedState.totals.totalInbox).toBe(2);
    expect(findColumn(retriedKanban, "inbox").cards.some((c: { fileName: string }) => c.fileName === retryBody.newFileName)).toBe(true);
    expect(itemsInFlight(retriedFlow)).toBe(2);

    const dismissedRaw = readFileSync(resolve(fixture.lineDir, "queues", "error", ".dismissed"), "utf-8");
    expect(Object.keys(JSON.parse(dismissedRaw))).toContain("error-2.json");
  });
});
