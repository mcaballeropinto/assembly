import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { initLineQueue } from "../queue";
import { listHeld, releaseHeldTasks, InvalidTaskFileError } from "../held";
import { TaskFileName } from "../ids";

const TEMP_DIR = resolve("/tmp", `assembly-test-held-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "test-line");

function writeHeldFile(name: string, task: string, input: Record<string, unknown> = {}) {
  const heldDir = resolve(LINE_DIR, "queues", "held");
  mkdirSync(heldDir, { recursive: true });
  writeFileSync(resolve(heldDir, name), JSON.stringify({ task, input }));
}

function clearLineQueues() {
  for (const queue of ["held", "inbox"] as const) {
    const dir = resolve(LINE_DIR, "queues", queue);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function manifestEntries(queue: "inbox" | "held"): Array<Record<string, string>> {
  const manifest = resolve(LINE_DIR, "queues", queue, ".emitted.jsonl");
  if (!existsSync(manifest)) return [];
  return readFileSync(manifest, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeAll(() => {
  mkdirSync(LINE_DIR, { recursive: true });
  writeFileSync(
    resolve(LINE_DIR, "line.yaml"),
    `name: test-line\nsequence:\n  - station-a\n`
  );
  // Create station dir and queue
  const stationDir = resolve(LINE_DIR, "stations", "station-a");
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(resolve(stationDir, "AGENT.md"), "---\n---\nStation A");
  // Create line-level queues (including held/)
  initLineQueue(LINE_DIR);
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("listHeld", () => {
  test("returns empty array when held/ dir is missing", () => {
    const missingDir = resolve(TEMP_DIR, "no-such-line");
    const result = listHeld(missingDir);
    expect(result).toEqual([]);
  });

  test("returns empty array when held/ exists but is empty", () => {
    const result = listHeld(LINE_DIR);
    expect(result).toBeArray();
    expect(result.length).toBe(0);
  });

  test("returns HeldTask entries with correct shape", () => {
    writeHeldFile("task-001.json", "Do something");
    const result = listHeld(LINE_DIR);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const task = result.find((t) => t.fileName === TaskFileName("task-001.json"));
    expect(task).toBeDefined();
    expect(task!.id as string).toBe("task-001");
    expect(task!.task).toBe("Do something");
    expect(task!.fileName as string).toBe("task-001.json");
  });

  test("truncates task to 200 chars", () => {
    const longTask = "x".repeat(500);
    writeHeldFile("task-long.json", longTask);
    const result = listHeld(LINE_DIR);
    const task = result.find((t) => t.fileName === "task-long.json");
    expect(task).toBeDefined();
    expect(task!.task.length).toBe(200);
  });

  test("sorts ascending by mtime", async () => {
    // Create two more files with different write times
    writeHeldFile("task-a1.json", "First");
    await Bun.sleep(10);
    writeHeldFile("task-a2.json", "Second");
    const result = listHeld(LINE_DIR);
    // Just verify ordering is consistent - older files come first
    const names = result.map((t) => t.fileName);
    expect(names.indexOf(TaskFileName("task-a1.json"))).toBeLessThan(names.indexOf(TaskFileName("task-a2.json")));
  });
});

describe("releaseHeldTasks", () => {
  test("moves a specific file from held/ to inbox/", () => {
    writeHeldFile("task-release-1.json", "Release me");
    const result = releaseHeldTasks(LINE_DIR, { file: TaskFileName("task-release-1.json") });
    expect(result.released.map(f => f as string)).toContain("task-release-1.json");
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    // File should be in inbox, not held
    expect(existsSync(resolve(LINE_DIR, "queues", "held", "task-release-1.json"))).toBe(false);
    expect(existsSync(resolve(LINE_DIR, "queues", "inbox", "task-release-1.json"))).toBe(true);
  });

  test("returns skipped for a missing file (no throw)", () => {
    const result = releaseHeldTasks(LINE_DIR, { file: TaskFileName("missing.json") });
    expect(result.released).toHaveLength(0);
    expect(result.skipped.map(f => f as string)).toContain("missing.json");
    expect(result.errors).toHaveLength(0);
  });

  test("throws InvalidTaskFileError for path traversal (../evil.json)", () => {
    expect(() =>
      releaseHeldTasks(LINE_DIR, { file: "../evil.json" })
    ).toThrow(InvalidTaskFileError);
  });

  test("throws InvalidTaskFileError for non-json extension", () => {
    expect(() =>
      releaseHeldTasks(LINE_DIR, { file: "notjson.txt" })
    ).toThrow(InvalidTaskFileError);
  });

  test("throws InvalidTaskFileError when neither file nor all is provided", () => {
    expect(() => releaseHeldTasks(LINE_DIR, {})).toThrow(InvalidTaskFileError);
  });

  test("releases the next N oldest held files by mtime order", async () => {
    clearLineQueues();
    writeHeldFile("task-next-1.json", "Next 1");
    await Bun.sleep(10);
    writeHeldFile("task-next-2.json", "Next 2");
    await Bun.sleep(10);
    writeHeldFile("task-next-3.json", "Next 3");
    await Bun.sleep(10);
    writeHeldFile("task-next-4.json", "Next 4");

    const result = releaseHeldTasks(LINE_DIR, { next: 2 });

    expect(result.released).toEqual(["task-next-1.json", "task-next-2.json"]);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(readdirSync(resolve(LINE_DIR, "queues", "held")).filter((f) => f.endsWith(".json")).sort()).toEqual([
      "task-next-3.json",
      "task-next-4.json",
    ]);
    expect(existsSync(resolve(LINE_DIR, "queues", "inbox", "task-next-1.json"))).toBe(true);
    expect(existsSync(resolve(LINE_DIR, "queues", "inbox", "task-next-2.json"))).toBe(true);
    expect(manifestEntries("inbox").filter((entry) => entry.source === "release")).toEqual([
      expect.objectContaining({ filename: "task-next-1.json", source: "release" }),
      expect.objectContaining({ filename: "task-next-2.json", source: "release" }),
    ]);
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "throws InvalidTaskFileError for invalid next value %p",
    (next) => {
      expect(() => releaseHeldTasks(LINE_DIR, { next })).toThrow(InvalidTaskFileError);
    }
  );

  test("releases all files with { all: true }", () => {
    writeHeldFile("task-all-1.json", "Task 1");
    writeHeldFile("task-all-2.json", "Task 2");
    writeHeldFile("task-all-3.json", "Task 3");
    const result = releaseHeldTasks(LINE_DIR, { all: true });
    expect(result.released.length).toBeGreaterThanOrEqual(3);
    expect(result.errors).toHaveLength(0);
    // All held files should be gone
    const heldDir = resolve(LINE_DIR, "queues", "held");
    const { readdirSync } = require("fs");
    const remaining = existsSync(heldDir) ? readdirSync(heldDir).filter((f: string) => f.endsWith(".json")) : [];
    expect(remaining.length).toBe(0);
  });

  test("idempotency: second call on released file returns skipped", () => {
    writeHeldFile("task-idempotent.json", "Idempotent");
    // First release
    const r1 = releaseHeldTasks(LINE_DIR, { file: "task-idempotent.json" });
    expect(r1.released).toContain("task-idempotent.json");
    // Second release — file already moved
    const r2 = releaseHeldTasks(LINE_DIR, { file: "task-idempotent.json" });
    expect(r2.released).toHaveLength(0);
    expect(r2.skipped).toContain("task-idempotent.json");
    expect(r2.errors).toHaveLength(0);
  });

  test("auto-creates inbox/ if it does not exist", () => {
    writeHeldFile("task-inbox-create.json", "Auto create inbox");
    const inboxDir = resolve(LINE_DIR, "queues", "inbox");
    // Remove inbox temporarily
    if (existsSync(inboxDir)) {
      rmSync(inboxDir, { recursive: true, force: true });
    }
    const result = releaseHeldTasks(LINE_DIR, { file: "task-inbox-create.json" });
    expect(result.released).toContain("task-inbox-create.json");
    expect(existsSync(inboxDir)).toBe(true);
  });

  test("throws InvalidTaskFileError for path with slash", () => {
    expect(() =>
      releaseHeldTasks(LINE_DIR, { file: "some/path.json" })
    ).toThrow(InvalidTaskFileError);
  });
});

describe("initLineQueue creates held/", () => {
  test("queues/held/ exists after initLineQueue", () => {
    const tmpLine = resolve(TEMP_DIR, "init-test-line");
    mkdirSync(tmpLine, { recursive: true });
    writeFileSync(resolve(tmpLine, "line.yaml"), "name: init-test\nsequence:\n  - s\n");
    initLineQueue(tmpLine);
    expect(existsSync(resolve(tmpLine, "queues", "held"))).toBe(true);
    expect(existsSync(resolve(tmpLine, "queues", "inbox"))).toBe(true);
    expect(existsSync(resolve(tmpLine, "queues", "done"))).toBe(true);
    expect(existsSync(resolve(tmpLine, "queues", "error"))).toBe(true);
    expect(existsSync(resolve(tmpLine, "queues", "review"))).toBe(true);
  });
});
