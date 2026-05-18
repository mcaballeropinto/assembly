import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  renameSync,
} from "fs";
import {
  openStderrSink,
  tailStderrSink,
  stderrLogPathFor,
  unlinkStderrLog,
  moveStderrLogAlongside,
  appendStderrMarker,
} from "../stderr-log";

const TEMP_DIR = resolve("/tmp", `assembly-test-stderr-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
});

function makeWpPath(name: string): string {
  return resolve(TEMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe("stderr-log sidecar", () => {
  test("openStderrSink returns a writable fd and truncates pre-existing content", async () => {
    const wp = makeWpPath("truncate");
    const sidecar = stderrLogPathFor(wp);
    writeFileSync(sidecar, "old stale content\n");
    const fd = openStderrSink(wp);
    writeSync(fd, Buffer.from("fresh line\n"));
    closeSync(fd);
    const body = readFileSync(sidecar, "utf-8");
    expect(body).toBe("fresh line\n");
  });

  test("tailStderrSink reports chunks as they arrive", async () => {
    const wp = makeWpPath("tail");
    const sidecar = stderrLogPathFor(wp);
    const fd = openStderrSink(wp);
    const chunks: string[] = [];
    const stop = tailStderrSink(sidecar, (c) => chunks.push(c), { pollIntervalMs: 50 });

    writeSync(fd, Buffer.from("first\n"));
    await new Promise((r) => setTimeout(r, 120));
    writeSync(fd, Buffer.from("second\n"));
    await new Promise((r) => setTimeout(r, 120));
    closeSync(fd);
    stop();

    const joined = chunks.join("");
    expect(joined).toContain("first");
    expect(joined).toContain("second");
  });

  test("tailStderrSink survives the file being unlinked (success-path cleanup)", async () => {
    const wp = makeWpPath("unlink");
    const sidecar = stderrLogPathFor(wp);
    const fd = openStderrSink(wp);
    const chunks: string[] = [];
    const stop = tailStderrSink(sidecar, (c) => chunks.push(c), { pollIntervalMs: 50 });

    writeSync(fd, Buffer.from("captured before unlink\n"));
    await new Promise((r) => setTimeout(r, 120));
    // Worker on success path unlinks the sidecar.
    unlinkSync(sidecar);
    // tail does a final drain on stop(); we should not throw.
    stop();
    closeSync(fd);

    expect(chunks.join("")).toContain("captured before unlink");
  });

  test("moveStderrLogAlongside follows the workpiece rename", () => {
    const wp = makeWpPath("move");
    const sidecar = stderrLogPathFor(wp);
    writeFileSync(sidecar, "important post-mortem\n");

    const dest = resolve(TEMP_DIR, `moved-${Date.now()}.json`);
    moveStderrLogAlongside(wp, dest);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(stderrLogPathFor(dest))).toBe(true);
    expect(readFileSync(stderrLogPathFor(dest), "utf-8")).toBe("important post-mortem\n");
  });

  test("appendStderrMarker writes a one-line entry", () => {
    const wp = makeWpPath("marker");
    appendStderrMarker(wp, "--- adopted ---");
    appendStderrMarker(wp, "--- second marker ---\n");
    const body = readFileSync(stderrLogPathFor(wp), "utf-8");
    expect(body).toBe("--- adopted ---\n--- second marker ---\n");
  });

  test("ASSEMBLY_KEEP_STDERR_LOGS=1 forces retention on unlink", () => {
    const wp = makeWpPath("keep");
    const sidecar = stderrLogPathFor(wp);
    writeFileSync(sidecar, "should survive\n");

    const orig = process.env.ASSEMBLY_KEEP_STDERR_LOGS;
    process.env.ASSEMBLY_KEEP_STDERR_LOGS = "1";
    try {
      unlinkStderrLog(wp);
      expect(existsSync(sidecar)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.ASSEMBLY_KEEP_STDERR_LOGS;
      else process.env.ASSEMBLY_KEEP_STDERR_LOGS = orig;
    }

    unlinkStderrLog(wp);
    expect(existsSync(sidecar)).toBe(false);
  });
});

describe("worker stderr sidecar travels through queue moves", () => {
  test("moveFile carries .stderr.log alongside the workpiece", async () => {
    const { moveFile } = await import("../queue");
    const srcDir = resolve(TEMP_DIR, `src-${Date.now()}`);
    const destDir = resolve(TEMP_DIR, `dst-${Date.now()}`);
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
    const wp = resolve(srcDir, "task-x.json");
    writeFileSync(wp, "{}");
    writeFileSync(wp + ".stderr.log", "stderr from a failed worker\n");
    writeFileSync(wp + ".session.jsonl", "{\"type\":\"assembly_meta\"}\n");

    const moved = moveFile(wp, destDir);
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(moved + ".stderr.log")).toBe(true);
    expect(existsSync(moved + ".session.jsonl")).toBe(true);
    expect(readFileSync(moved + ".stderr.log", "utf-8")).toContain("failed worker");
  });
});
