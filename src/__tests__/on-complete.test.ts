import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve, basename } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { resolvePath, triggerDownstream } from "../orchestrator";
import { createWorkpiece, writeStation } from "../workpiece";
import { validateLine } from "../line";
import { loadLine } from "../line";
import type { LineConfig, Workpiece } from "../types";

const TEMP_DIR = resolve("/tmp", `assembly-test-on-complete-${Date.now()}`);

/** Create a log collector for testing */
function createTestLog(): {
  log: (event: string, detail: Record<string, unknown>) => void;
  events: Array<{ event: string; detail: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  return {
    log: (event: string, detail: Record<string, unknown>) => {
      events.push({ event, detail });
    },
    events,
  };
}

/** Create a minimal line directory with line.yaml */
function createLineDir(name: string, config: Record<string, unknown>, parentDir?: string): string {
  const parent = parentDir ?? resolve(TEMP_DIR, "lines");
  const lineDir = resolve(parent, name);
  mkdirSync(resolve(lineDir, "stations", "dummy-station"), { recursive: true });
  mkdirSync(resolve(lineDir, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(lineDir, "queues", "done"), { recursive: true });

  // Write line.yaml
  const YAML = require("yaml");
  writeFileSync(resolve(lineDir, "line.yaml"), YAML.stringify(config));

  // Write a minimal AGENT.md for the dummy station
  writeFileSync(
    resolve(lineDir, "stations", "dummy-station", "AGENT.md"),
    "---\n---\nYou are a test station. Return a summary."
  );

  return lineDir;
}

/** Create a workpiece with station results for testing */
function createTestWorkpiece(): Workpiece {
  let wp = createWorkpiece("line-a", "Test task");
  wp = writeStation(wp, "recommend", { summary: "Recommended", data: { top_picks: ["AAPL", "GOOG"], has_actions: true } }, {
    model: "test-model",
    tokens: { in: 100, out: 50 },
    cost_usd: 0.01,
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:01:00Z",
  });
  wp = writeStation(wp, "fetch-market-data", { summary: "Market data fetched", data: { market: { spy: 500 } } }, {
    model: "test-model",
    tokens: { in: 200, out: 100 },
    cost_usd: 0.02,
    started_at: "2026-01-01T00:01:00Z",
    finished_at: "2026-01-01T00:02:00Z",
  });
  return wp;
}

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── resolvePath() tests ───────────────────────────────────────────

describe("resolvePath()", () => {
  test("resolves station data path (recommend.data.top_picks)", () => {
    const wp = createTestWorkpiece();
    const result = resolvePath(wp, "recommend.data.top_picks");
    expect(result).toEqual(["AAPL", "GOOG"]);
  });

  test("resolves station data path (fetch-market-data.data.market)", () => {
    const wp = createTestWorkpiece();
    const result = resolvePath(wp, "fetch-market-data.data.market");
    expect(result).toEqual({ spy: 500 });
  });

  test("resolves input path (input.market_type)", () => {
    let wp = createTestWorkpiece();
    wp.input = { market_type: "equity", region: "US" };
    const result = resolvePath(wp, "input.market_type");
    expect(result).toBe("equity");
  });

  test("resolves task path (task)", () => {
    const wp = createTestWorkpiece();
    const result = resolvePath(wp, "task");
    expect(result).toBe("Test task");
  });

  test("returns undefined for nonexistent station path", () => {
    const wp = createTestWorkpiece();
    const result = resolvePath(wp, "nonexistent.data.foo");
    expect(result).toBeUndefined();
  });

  test("returns undefined for deep path on null intermediate", () => {
    const wp = createTestWorkpiece();
    const result = resolvePath(wp, "recommend.data.deeply.nested.value");
    expect(result).toBeUndefined();
  });

  test("resolves boolean value (recommend.data.has_actions)", () => {
    const wp = createTestWorkpiece();
    const result = resolvePath(wp, "recommend.data.has_actions");
    expect(result).toBe(true);
  });
});

// ─── triggerDownstream() tests ─────────────────────────────────────

describe("triggerDownstream()", () => {
  test("creates task file in target inbox with correct structure (happy path)", async () => {
    const testId = `happy-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        {
          target: "line-b",
          pass: {
            signals: "recommend.data.top_picks",
            market: "fetch-market-data.data.market",
          },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    // Check that a task file was created in line-b's inbox
    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    // Read and verify the task file
    const taskContent = JSON.parse(readFileSync(resolve(lineBDir, "queues", "inbox", inboxFiles[0]), "utf-8"));
    expect(taskContent.task).toContain("Triggered by line-a");
    expect(taskContent.task).toContain(wp.id);
    expect(taskContent.input.triggered_by).toBe("line-a");
    expect(taskContent.input.source_run).toBe(wp.id);
    expect(taskContent.input.signals).toEqual(["AAPL", "GOOG"]);
    expect(taskContent.input.market).toEqual({ spy: 500 });

    // Verify log event
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("trigger_fired");
    expect(events[0].detail.source).toBe("line-a");
    expect(events[0].detail.target).toBe("line-b");
    expect(events[0].detail.workpiece).toBe(wp.id);
    expect(events[0].detail.input_keys).toContain("triggered_by");
    expect(events[0].detail.input_keys).toContain("signals");
    expect(events[0].detail.input_keys).toContain("market");
  });

  test("condition=truthy fires the trigger", async () => {
    const testId = `truthy-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        {
          target: "line-b",
          condition: "recommend.data.has_actions",
          pass: {
            picks: "recommend.data.top_picks",
          },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    // Trigger should fire since has_actions is true
    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    expect(events.length).toBe(1);
    expect(events[0].event).toBe("trigger_fired");
  });

  test("condition=falsy skips the trigger and logs trigger_skipped", async () => {
    const testId = `falsy-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        {
          target: "line-b",
          condition: "recommend.data.nonexistent_field",
          pass: {
            picks: "recommend.data.top_picks",
          },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    // No task file should be created
    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(0);

    // Should log trigger_skipped
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("trigger_skipped");
    expect(events[0].detail.source).toBe("line-a");
    expect(events[0].detail.target).toBe("line-b");
    expect(events[0].detail.reason).toContain("condition");
    expect(events[0].detail.reason).toContain("falsy");
  });

  test("missing pass paths result in undefined values in input", async () => {
    const testId = `missing-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        {
          target: "line-b",
          pass: {
            valid_field: "recommend.data.top_picks",
            missing_field: "nonexistent.data.something",
          },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    const taskContent = JSON.parse(readFileSync(resolve(lineBDir, "queues", "inbox", inboxFiles[0]), "utf-8"));
    expect(taskContent.input.valid_field).toEqual(["AAPL", "GOOG"]);
    // Missing field should not be present (JSON.stringify omits undefined)
    expect(taskContent.input.missing_field).toBeUndefined();

    expect(events[0].event).toBe("trigger_fired");
  });

  test("multiple targets fire multiple triggers", async () => {
    const testId = `multi-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    const lineCDir = resolve(linesDir, "line-c");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(resolve(lineCDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        {
          target: "line-b",
          pass: { signals: "recommend.data.top_picks" },
        },
        {
          target: "line-c",
          pass: { market: "fetch-market-data.data.market" },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    // Both target inboxes should have files
    const lineBFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    const lineCFiles = readdirSync(resolve(lineCDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    expect(lineBFiles.length).toBe(1);
    expect(lineCFiles.length).toBe(1);

    // Verify both log events
    expect(events.length).toBe(2);
    expect(events[0].event).toBe("trigger_fired");
    expect(events[0].detail.target).toBe("line-b");
    expect(events[1].event).toBe("trigger_fired");
    expect(events[1].detail.target).toBe("line-c");
  });

  test("no on_complete configured results in no-op", async () => {
    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
    };

    await triggerDownstream(wp, config, "/tmp/nonexistent", log);

    expect(events.length).toBe(0);
  });

  test("empty on_complete array results in no-op", async () => {
    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [],
    };

    await triggerDownstream(wp, config, "/tmp/nonexistent", log);

    expect(events.length).toBe(0);
  });

  test("creates target inbox directory if it does not exist", async () => {
    const testId = `mkdir-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(lineADir, { recursive: true });
    // Intentionally do NOT create line-b's inbox

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        {
          target: "line-b",
          pass: { signals: "recommend.data.top_picks" },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    // Inbox should have been created
    expect(existsSync(resolve(lineBDir, "queues", "inbox"))).toBe(true);
    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter(f => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    expect(events[0].event).toBe("trigger_fired");
  });
});

// ─── validateLine() with on_complete tests ─────────────────────────

describe("triggerDownstream() — fanout", () => {
  test("emits one downstream task per element, each carrying input[as]=[element]", async () => {
    const testId = `fanout-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    let wp = createTestWorkpiece();
    wp = writeStation(
      wp,
      "validate",
      {
        summary: "ok",
        data: {
          qualifying_items: [
            { name: "Acme", website: "https://acme.example" },
            { name: "Globex", website: "https://globex.example" },
            { name: "Initech", website: "https://initech.example" },
          ],
          qualifying_count: 3,
        },
      },
      {
        model: "test",
        tokens: { in: 1, out: 1 },
        cost_usd: 0,
        started_at: "2026-01-01T00:02:00Z",
        finished_at: "2026-01-01T00:03:00Z",
      }
    );

    const config: LineConfig = {
      name: "line-a",
      sequence: ["validate"],
      on_complete: [
        {
          target: "line-b",
          fanout: { over: "validate.data.qualifying_items", as: "seed_items" },
          condition: "validate.data.qualifying_count",
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox"))
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(inboxFiles.length).toBe(3);

    const tasks = inboxFiles.map((f) =>
      JSON.parse(readFileSync(resolve(lineBDir, "queues", "inbox", f), "utf-8"))
    );

    // Each task carries exactly one item in a singleton array, plus
    // shared metadata (triggered_by, source_run, fanout_index, fanout_total).
    expect(tasks[0].input.seed_items).toEqual([{ name: "Acme", website: "https://acme.example" }]);
    expect(tasks[1].input.seed_items).toEqual([{ name: "Globex", website: "https://globex.example" }]);
    expect(tasks[2].input.seed_items).toEqual([{ name: "Initech", website: "https://initech.example" }]);

    expect(tasks[0].input.fanout_index).toBe(0);
    expect(tasks[2].input.fanout_index).toBe(2);
    expect(tasks[0].input.fanout_total).toBe(3);
    expect(tasks[0].input.triggered_by).toBe("line-a");

    // task title should mark which fanout child this is
    expect(tasks[0].task).toContain("fanout 1/3");
    expect(tasks[2].task).toContain("fanout 3/3");

    // single trigger_fired log carries fanout count
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("trigger_fired");
    expect((events[0].detail.fanout as { count: number }).count).toBe(3);
  });

  test("fanout over an empty array logs trigger_skipped and emits no tasks", async () => {
    const testId = `fanout-empty-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    let wp = createTestWorkpiece();
    wp = writeStation(
      wp,
      "validate",
      { summary: "none", data: { qualifying_items: [], qualifying_count: 0 } },
      { model: "t", tokens: { in: 1, out: 1 }, cost_usd: 0,
        started_at: "2026-01-01T00:02:00Z", finished_at: "2026-01-01T00:03:00Z" }
    );

    const config: LineConfig = {
      name: "line-a",
      sequence: ["validate"],
      on_complete: [
        { target: "line-b", fanout: { over: "validate.data.qualifying_items", as: "seed_items" } },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    const inboxFiles = readdirSync(resolve(lineBDir, "queues", "inbox")).filter((f) => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(0);
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("trigger_skipped");
    expect(events[0].detail.reason).toContain("non-empty array");
  });

  test("fanout merges `pass` mappings into every emitted task", async () => {
    // pass-resolved fields are shared context (a run id, a config block, etc.)
    // and should accompany every per-element fanout task.
    const testId = `fanout-pass-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const lineBDir = resolve(linesDir, "line-b");
    mkdirSync(resolve(lineBDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log } = createTestLog();
    let wp = createTestWorkpiece();
    wp = writeStation(
      wp,
      "validate",
      { summary: "ok", data: { qualifying_items: [{ name: "X" }, { name: "Y" }], shared_run: "run-123" } },
      { model: "t", tokens: { in: 1, out: 1 }, cost_usd: 0,
        started_at: "2026-01-01T00:02:00Z", finished_at: "2026-01-01T00:03:00Z" }
    );

    const config: LineConfig = {
      name: "line-a",
      sequence: ["validate"],
      on_complete: [
        {
          target: "line-b",
          fanout: { over: "validate.data.qualifying_items", as: "seed_items" },
          pass: { run_id: "validate.data.shared_run" },
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    const tasks = readdirSync(resolve(lineBDir, "queues", "inbox"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(resolve(lineBDir, "queues", "inbox", f), "utf-8")));

    expect(tasks.length).toBe(2);
    expect(tasks[0].input.run_id).toBe("run-123");
    expect(tasks[1].input.run_id).toBe("run-123");
    expect(tasks[0].input.seed_items).toEqual([{ name: "X" }]);
    expect(tasks[1].input.seed_items).toEqual([{ name: "Y" }]);
  });
});

// ─── target_path (dynamic target) tests ────────────────────────────

describe("triggerDownstream() — target_path", () => {
  test("resolves target_path from input and lands tasks in the resolved line's inbox", async () => {
    const testId = `dyn-target-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    const targetDir = resolve(linesDir, "target-line");
    const otherDir = resolve(linesDir, "other-line");
    mkdirSync(resolve(targetDir, "queues", "inbox"), { recursive: true });
    mkdirSync(resolve(otherDir, "queues", "inbox"), { recursive: true });
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    let wp = createTestWorkpiece();
    wp.input = { target_line: "target-line" };
    wp = writeStation(
      wp,
      "validate",
      {
        summary: "ok",
        data: {
          qualifying_items: [{ name: "Acme" }, { name: "Globex" }],
          qualifying_count: 2,
        },
      },
      { model: "t", tokens: { in: 1, out: 1 }, cost_usd: 0,
        started_at: "2026-01-01T00:02:00Z", finished_at: "2026-01-01T00:03:00Z" }
    );

    const config: LineConfig = {
      name: "line-a",
      sequence: ["validate"],
      on_complete: [
        {
          target_path: "input.target_line",
          fanout: { over: "validate.data.qualifying_items", as: "seed_items" },
          condition: "validate.data.qualifying_count",
        },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    // Tasks land in target-line (resolved from input.target_line),
    // NOT other-line — even though other-line is also a sibling.
    const targetTasks = readdirSync(resolve(targetDir, "queues", "inbox"))
      .filter((f) => f.endsWith(".json"));
    const otherTasks = readdirSync(resolve(otherDir, "queues", "inbox"))
      .filter((f) => f.endsWith(".json"));
    expect(targetTasks.length).toBe(2);
    expect(otherTasks.length).toBe(0);

    // log event records the resolved target name
    expect(events[0].event).toBe("trigger_fired");
    expect(events[0].detail.target).toBe("target-line");
  });

  test("missing target_path resolution skips the trigger", async () => {
    const testId = `dyn-target-miss-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);
    const lineADir = resolve(linesDir, "line-a");
    mkdirSync(lineADir, { recursive: true });

    const { log, events } = createTestLog();
    const wp = createTestWorkpiece();
    // No input.target_line on the workpiece.

    const config: LineConfig = {
      name: "line-a",
      sequence: ["recommend"],
      on_complete: [
        { target_path: "input.target_line", pass: { picks: "recommend.data.top_picks" } },
      ],
    };

    await triggerDownstream(wp, config, lineADir, log);

    expect(events.length).toBe(1);
    expect(events[0].event).toBe("trigger_skipped");
    expect(events[0].detail.reason).toContain("did not resolve");
  });
});

describe("validateLine() with on_complete", () => {
  test("valid on_complete targeting existing sibling line passes validation", async () => {
    const testId = `valid-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    // Create line-a with on_complete targeting line-b
    createLineDir("line-a", {
      name: "line-a",
      sequence: ["dummy-station"],
      on_complete: [{ target: "line-b", pass: { data: "dummy-station.data.result" } }],
    }, linesDir);

    // Create line-b as target
    createLineDir("line-b", {
      name: "line-b",
      sequence: ["dummy-station"],
    }, linesDir);

    const errors = await validateLine(resolve(linesDir, "line-a"));

    // Should have no errors about on_complete targets
    const onCompleteErrors = errors.filter(e => e.includes("on_complete"));
    expect(onCompleteErrors.length).toBe(0);
  });

  test("on_complete targeting nonexistent line directory returns error", async () => {
    const testId = `nonexistent-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    createLineDir("line-a", {
      name: "line-a",
      sequence: ["dummy-station"],
      on_complete: [{ target: "nonexistent-line", pass: { data: "dummy-station.data.result" } }],
    }, linesDir);

    const errors = await validateLine(resolve(linesDir, "line-a"));

    const targetErrors = errors.filter(e => e.includes("nonexistent-line") && e.includes("directory not found"));
    expect(targetErrors.length).toBeGreaterThan(0);
  });

  test("on_complete targeting directory without line.yaml returns error", async () => {
    const testId = `noyaml-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    createLineDir("line-a", {
      name: "line-a",
      sequence: ["dummy-station"],
      on_complete: [{ target: "no-yaml-line" }],
    }, linesDir);

    // Create target directory but don't put line.yaml in it
    mkdirSync(resolve(linesDir, "no-yaml-line"), { recursive: true });

    const errors = await validateLine(resolve(linesDir, "line-a"));

    const yamlErrors = errors.filter(e => e.includes("no-yaml-line") && e.includes("missing line.yaml"));
    expect(yamlErrors.length).toBeGreaterThan(0);
  });

  test("on_complete with only target_path (no static target) loads and validates", async () => {
    const testId = `validate-target-path-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    createLineDir("line-a", {
      name: "line-a",
      sequence: ["dummy-station"],
      on_complete: [
        { target_path: "input.target_line", pass: { x: "dummy-station.data.x" } },
      ],
    }, linesDir);

    // No sibling target line is required — target_path is dynamic.
    const errors = await validateLine(resolve(linesDir, "line-a"));
    const onCompleteErrors = errors.filter((e) => e.includes("on_complete"));
    expect(onCompleteErrors.length).toBe(0);
  });

  test("on_complete with neither target nor target_path errors", async () => {
    const testId = `validate-no-target-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    createLineDir("line-a", {
      name: "line-a",
      sequence: ["dummy-station"],
      on_complete: [{ pass: { x: "dummy-station.data.x" } } as unknown as Record<string, unknown>],
    }, linesDir);

    const errors = await validateLine(resolve(linesDir, "line-a"));
    expect(errors.some((e) => e.includes("'target' or 'target_path'"))).toBe(true);
  });

  test("detects circular A -> B -> A triggers", async () => {
    const testId = `circular-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    createLineDir("line-a", {
      name: "line-a",
      sequence: ["dummy-station"],
      on_complete: [{ target: "line-b" }],
    }, linesDir);

    createLineDir("line-b", {
      name: "line-b",
      sequence: ["dummy-station"],
      on_complete: [{ target: "line-a" }],
    }, linesDir);

    const errors = await validateLine(resolve(linesDir, "line-a"));

    const circularErrors = errors.filter(e => e.includes("circular"));
    expect(circularErrors.length).toBeGreaterThan(0);
  });
});

// ─── backward compatibility tests ──────────────────────────────────

describe("backward compatibility", () => {
  test("line.yaml without on_complete loads successfully", async () => {
    const testId = `compat-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    const lineDir = createLineDir("plain-line", {
      name: "plain-line",
      sequence: ["dummy-station"],
    }, linesDir);

    const { config } = await loadLine(lineDir);
    expect(config.name).toBe("plain-line");
    expect(config.on_complete).toBeUndefined();
  });

  test("line.yaml without on_complete validates without errors", async () => {
    const testId = `compat-validate-${Date.now()}`;
    const linesDir = resolve(TEMP_DIR, testId);

    const lineDir = createLineDir("valid-line", {
      name: "valid-line",
      sequence: ["dummy-station"],
    }, linesDir);

    const errors = await validateLine(lineDir);
    expect(errors.length).toBe(0);
  });
});
