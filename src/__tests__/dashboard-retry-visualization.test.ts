import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { getKanbanState, type KanbanState, type KanbanColumn } from "../dashboard-data";
import { initSectionQueue, initLineQueue } from "../queue";
import { writeRetryState, type RetryState } from "../retry-state";

const TEMP_DIR = resolve("/tmp", `assembly-test-dash-retry-viz-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "test-line");

function makeWorkpiece(id: string, task: string = "test task") {
  return JSON.stringify({
    id,
    line: "test-line",
    task,
    input: {},
    stations: {},
  });
}

function findColumn(state: KanbanState, key: string): KanbanColumn | undefined {
  return state.columns.find((c) => c.key === key);
}

beforeAll(() => {
  mkdirSync(LINE_DIR, { recursive: true });

  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    `name: test-line\nsequence:\n  - station-a\n  - station-b\n`
  );

  const stationA = resolve(LINE_DIR, "stations", "station-a");
  const stationB = resolve(LINE_DIR, "stations", "station-b");
  mkdirSync(stationA, { recursive: true });
  mkdirSync(stationB, { recursive: true });
  writeFileSync(resolve(stationA, "AGENT.md"), "---\n---\nTest station A");
  writeFileSync(resolve(stationB, "AGENT.md"), "---\n---\nTest station B");
  initSectionQueue(stationA);
  initSectionQueue(stationB);
  initLineQueue(LINE_DIR);
});

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("getKanbanState with retry sidecar", () => {
  test("card without retry sidecar has no retry field", async () => {
    const wpPath = resolve(LINE_DIR, "stations", "station-a", "queue", "inbox", "wp-no-retry.json");
    writeFileSync(wpPath, makeWorkpiece("wp-no-retry"));

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-a:inbox");
    expect(col).toBeDefined();

    const card = col!.cards.find((c) => c.id === "wp-no-retry");
    expect(card).toBeDefined();
    expect(card!.retry).toBeUndefined();

    // Cleanup
    require("fs").unlinkSync(wpPath);
  });

  test("card with retry sidecar has retry field populated", async () => {
    const wpPath = resolve(LINE_DIR, "stations", "station-a", "queue", "inbox", "wp-retrying.json");
    writeFileSync(wpPath, makeWorkpiece("wp-retrying"));

    const retryState: RetryState = {
      retry_count: 2,
      max_retries: 3,
      failure_class: "provider",
      in_backoff: false,
      exhausted: false,
    };
    writeRetryState(wpPath, retryState);

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-a:inbox");
    const card = col!.cards.find((c) => c.id === "wp-retrying");
    expect(card).toBeDefined();
    expect(card!.retry).toBeDefined();
    expect(card!.retry!.retry_count).toBe(2);
    expect(card!.retry!.max_retries).toBe(3);
    expect(card!.retry!.failure_class).toBe("provider");
    expect(card!.retry!.in_backoff).toBe(false);

    // Cleanup
    require("fs").unlinkSync(wpPath);
    require("fs").unlinkSync(wpPath.replace(".json", ".retry.json"));
  });

  test("card with in_backoff sidecar shows backoff_until", async () => {
    const wpPath = resolve(LINE_DIR, "stations", "station-a", "queue", "inbox", "wp-backoff.json");
    writeFileSync(wpPath, makeWorkpiece("wp-backoff"));

    const backoffUntil = new Date(Date.now() + 30_000).toISOString();
    writeRetryState(wpPath, {
      retry_count: 1,
      max_retries: 3,
      failure_class: "crash",
      in_backoff: true,
      backoff_until: backoffUntil,
      exhausted: false,
    });

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-a:inbox");
    const card = col!.cards.find((c) => c.id === "wp-backoff");
    expect(card!.retry!.in_backoff).toBe(true);
    expect(card!.retry!.backoff_until).toBe(backoffUntil);

    // Cleanup
    require("fs").unlinkSync(wpPath);
    require("fs").unlinkSync(wpPath.replace(".json", ".retry.json"));
  });

  test("exhausted sidecar is reflected in card", async () => {
    const wpPath = resolve(LINE_DIR, "stations", "station-a", "queue", "inbox", "wp-exhausted.json");
    writeFileSync(wpPath, makeWorkpiece("wp-exhausted"));

    writeRetryState(wpPath, {
      retry_count: 3,
      max_retries: 3,
      failure_class: "crash",
      in_backoff: false,
      exhausted: true,
    });

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-a:inbox");
    const card = col!.cards.find((c) => c.id === "wp-exhausted");
    expect(card!.retry!.exhausted).toBe(true);
    expect(card!.retry!.retry_count).toBe(3);

    // Cleanup
    require("fs").unlinkSync(wpPath);
    require("fs").unlinkSync(wpPath.replace(".json", ".retry.json"));
  });

  test("column retrying_count aggregates retrying cards", async () => {
    const wpPath1 = resolve(LINE_DIR, "stations", "station-a", "queue", "inbox", "wp-r1.json");
    const wpPath2 = resolve(LINE_DIR, "stations", "station-a", "queue", "inbox", "wp-r2.json");
    writeFileSync(wpPath1, makeWorkpiece("wp-r1"));
    writeFileSync(wpPath2, makeWorkpiece("wp-r2"));

    writeRetryState(wpPath1, {
      retry_count: 1,
      max_retries: 3,
      in_backoff: true,
      backoff_until: new Date(Date.now() + 10000).toISOString(),
      exhausted: false,
    });
    writeRetryState(wpPath2, {
      retry_count: 2,
      max_retries: 3,
      in_backoff: false,
      exhausted: false,
    });

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-a:inbox");
    expect(col!.retrying_count).toBe(2);
    expect(col!.exhausted_count).toBeUndefined();

    // Cleanup
    require("fs").unlinkSync(wpPath1);
    require("fs").unlinkSync(wpPath2);
    require("fs").unlinkSync(wpPath1.replace(".json", ".retry.json"));
    require("fs").unlinkSync(wpPath2.replace(".json", ".retry.json"));
  });

  test("column exhausted_count aggregates exhausted cards", async () => {
    const wpPath = resolve(LINE_DIR, "stations", "station-b", "queue", "inbox", "wp-ex1.json");
    writeFileSync(wpPath, makeWorkpiece("wp-ex1"));

    writeRetryState(wpPath, {
      retry_count: 2,
      max_retries: 2,
      failure_class: "crash",
      in_backoff: false,
      exhausted: true,
    });

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-b:inbox");
    expect(col!.exhausted_count).toBe(1);

    // Cleanup
    require("fs").unlinkSync(wpPath);
    require("fs").unlinkSync(wpPath.replace(".json", ".retry.json"));
  });

  test("column with no retrying cards has no retry aggregates", async () => {
    const wpPath = resolve(LINE_DIR, "stations", "station-b", "queue", "inbox", "wp-clean.json");
    writeFileSync(wpPath, makeWorkpiece("wp-clean"));

    const state = (await getKanbanState(LINE_DIR)) as KanbanState;
    const col = findColumn(state, "station-b:inbox");
    expect(col!.retrying_count).toBeUndefined();
    expect(col!.exhausted_count).toBeUndefined();

    // Cleanup
    require("fs").unlinkSync(wpPath);
  });
});
