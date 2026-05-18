import { test, expect, describe, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { isQueueSidecarFile, listQueue, watchFolder } from "../queue";

const tempDirs: string[] = [];

function freshDir(label: string): string {
  const dir = resolve(
    "/tmp",
    `assembly-test-sidecar-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("isQueueSidecarFile", () => {
  test("flags .retry.json sidecars", () => {
    expect(isQueueSidecarFile("task-1234.retry.json")).toBe(true);
    expect(isQueueSidecarFile("task-1234-005-from-foo.retry.json")).toBe(true);
  });

  test("flags atomic-write temp files", () => {
    expect(isQueueSidecarFile("task-1234.json.tmp.987")).toBe(true);
    expect(isQueueSidecarFile("task-1234.tmp.42")).toBe(true);
  });

  test("flags .envelope.json sidecars", () => {
    expect(isQueueSidecarFile("task-1234.json.envelope.json")).toBe(true);
    expect(
      isQueueSidecarFile("task-1234-005-from-foo.json.envelope.json")
    ).toBe(true);
  });

  test("does not flag plain workpiece files", () => {
    expect(isQueueSidecarFile("task-1234.json")).toBe(false);
    expect(isQueueSidecarFile("task-1234-005-from-foo.json")).toBe(false);
    expect(isQueueSidecarFile("task-retry-history.json")).toBe(false);
  });
});

describe("listQueue sidecar filtering", () => {
  test("excludes .retry.json sidecars", () => {
    const dir = freshDir("listq-retry");
    writeFileSync(resolve(dir, "task-1.json"), "{}");
    writeFileSync(resolve(dir, "task-1.retry.json"), "{}");
    writeFileSync(resolve(dir, "task-2.json"), "{}");

    const files = listQueue(dir).map((p) => p.split("/").pop());
    expect(files).toEqual(["task-1.json", "task-2.json"]);
  });

  test("excludes atomic-write temp files", () => {
    const dir = freshDir("listq-tmp");
    writeFileSync(resolve(dir, "task-1.json"), "{}");
    writeFileSync(resolve(dir, "task-1.json.tmp.987"), "{}");

    const files = listQueue(dir).map((p) => p.split("/").pop());
    expect(files).toEqual(["task-1.json"]);
  });

  test("excludes .envelope.json sidecars", () => {
    const dir = freshDir("listq-env");
    writeFileSync(resolve(dir, "task-1.json"), "{}");
    writeFileSync(resolve(dir, "task-1.json.envelope.json"), '{"summary":"x"}');
    writeFileSync(resolve(dir, "task-2.json"), "{}");

    const files = listQueue(dir).map((p) => p.split("/").pop());
    expect(files).toEqual(["task-1.json", "task-2.json"]);
  });
});

describe("watchFolder sidecar filtering", () => {
  test("does not fire for .retry.json sidecars dropped into the watched dir", async () => {
    const dir = freshDir("watch-retry");
    const seen: string[] = [];

    const stop = watchFolder(
      dir,
      (filePath) => {
        seen.push(filePath.split("/").pop()!);
      },
      { rescanIntervalMs: 50 }
    );

    // The retry sidecar must not trigger the watcher — otherwise the
    // output watcher tries to read it as a workpiece and crashes on
    // workpiece.stations[section.name] (it's a RetryState shape, no .stations).
    writeFileSync(resolve(dir, "task-99.retry.json"), '{"retry_count":1}');
    await new Promise((r) => setTimeout(r, 250));

    // A real workpiece in the same dir should still fire.
    writeFileSync(resolve(dir, "task-99.json"), "{}");
    await new Promise((r) => setTimeout(r, 250));
    stop();

    expect(seen).toContain("task-99.json");
    expect(seen).not.toContain("task-99.retry.json");
  });

  test("does not fire for .tmp.<pid> atomic-write temps", async () => {
    const dir = freshDir("watch-tmp");
    const seen: string[] = [];

    const stop = watchFolder(
      dir,
      (filePath) => {
        seen.push(filePath.split("/").pop()!);
      },
      { rescanIntervalMs: 50 }
    );

    writeFileSync(resolve(dir, "task-7.json.tmp.123"), "{}");
    await new Promise((r) => setTimeout(r, 200));
    stop();

    expect(seen).not.toContain("task-7.json.tmp.123");
  });
});
