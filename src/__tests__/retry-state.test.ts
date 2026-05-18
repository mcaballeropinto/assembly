import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import {
  writeRetryState,
  readRetryState,
  clearRetryState,
  cleanupOrphanedRetryStates,
  retrySidecarPath,
  type RetryState,
} from "../retry-state";

const TEMP_DIR = resolve("/tmp", `assembly-test-retry-state-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("retrySidecarPath", () => {
  test("replaces .json with .retry.json", () => {
    expect(retrySidecarPath("/path/to/wp-1234.json")).toBe(
      "/path/to/wp-1234.retry.json"
    );
  });

  test("handles path without .json extension", () => {
    // Degenerate case: no .json suffix → appends nothing (no-op regex)
    expect(retrySidecarPath("/path/to/file")).toBe("/path/to/file");
  });
});

describe("writeRetryState / readRetryState", () => {
  test("writes and reads a valid sidecar", () => {
    const wpPath = resolve(TEMP_DIR, "wp-write-test.json");
    const state: RetryState = {
      retry_count: 2,
      max_retries: 3,
      failure_class: "provider",
      in_backoff: true,
      backoff_until: "2026-04-20T18:15:42Z",
      exhausted: false,
    };
    writeRetryState(wpPath, state);

    const sidecar = retrySidecarPath(wpPath);
    expect(existsSync(sidecar)).toBe(true);

    const read = readRetryState(wpPath);
    expect(read).not.toBeNull();
    expect(read!.retry_count).toBe(2);
    expect(read!.max_retries).toBe(3);
    expect(read!.failure_class).toBe("provider");
    expect(read!.in_backoff).toBe(true);
    expect(read!.backoff_until).toBe("2026-04-20T18:15:42Z");
    expect(read!.exhausted).toBe(false);
  });

  test("atomic write (temp file is cleaned up)", () => {
    const wpPath = resolve(TEMP_DIR, "wp-atomic-test.json");
    const state: RetryState = {
      retry_count: 1,
      max_retries: 2,
      in_backoff: false,
      exhausted: false,
    };
    writeRetryState(wpPath, state);

    // No .tmp files left behind
    const files = require("fs").readdirSync(TEMP_DIR) as string[];
    const tmpFiles = files.filter((f: string) => f.includes(".tmp."));
    expect(tmpFiles.length).toBe(0);
  });

  test("overwrites existing sidecar", () => {
    const wpPath = resolve(TEMP_DIR, "wp-overwrite-test.json");
    writeRetryState(wpPath, {
      retry_count: 1,
      max_retries: 3,
      in_backoff: true,
      backoff_until: "2026-04-20T18:00:00Z",
      exhausted: false,
    });
    writeRetryState(wpPath, {
      retry_count: 2,
      max_retries: 3,
      in_backoff: true,
      backoff_until: "2026-04-20T18:01:00Z",
      exhausted: false,
    });

    const read = readRetryState(wpPath);
    expect(read!.retry_count).toBe(2);
    expect(read!.backoff_until).toBe("2026-04-20T18:01:00Z");
  });
});

describe("readRetryState", () => {
  test("returns null when sidecar does not exist", () => {
    const wpPath = resolve(TEMP_DIR, "wp-nonexistent.json");
    const read = readRetryState(wpPath);
    expect(read).toBeNull();
  });

  test("returns null for invalid JSON sidecar", () => {
    const wpPath = resolve(TEMP_DIR, "wp-invalid-json.json");
    const sidecar = retrySidecarPath(wpPath);
    require("fs").writeFileSync(sidecar, "not valid json {{{");
    const read = readRetryState(wpPath);
    expect(read).toBeNull();
  });
});

describe("clearRetryState", () => {
  test("removes existing sidecar", () => {
    const wpPath = resolve(TEMP_DIR, "wp-clear-test.json");
    writeRetryState(wpPath, {
      retry_count: 1,
      max_retries: 2,
      in_backoff: false,
      exhausted: false,
    });
    expect(existsSync(retrySidecarPath(wpPath))).toBe(true);

    clearRetryState(wpPath);
    expect(existsSync(retrySidecarPath(wpPath))).toBe(false);
  });

  test("does not throw when sidecar does not exist", () => {
    const wpPath = resolve(TEMP_DIR, "wp-clear-nonexistent.json");
    expect(() => clearRetryState(wpPath)).not.toThrow();
  });
});

describe("exhausted state", () => {
  test("reads exhausted state correctly", () => {
    const wpPath = resolve(TEMP_DIR, "wp-exhausted-test.json");
    writeRetryState(wpPath, {
      retry_count: 3,
      max_retries: 3,
      failure_class: "crash",
      in_backoff: false,
      exhausted: true,
    });

    const read = readRetryState(wpPath);
    expect(read!.exhausted).toBe(true);
    expect(read!.retry_count).toBe(3);
    expect(read!.max_retries).toBe(3);
  });
});

describe("cleanupOrphanedRetryStates", () => {
  test("removes sidecar when companion workpiece is missing", () => {
    const dir = resolve(TEMP_DIR, "sweep-orphan");
    mkdirSync(dir, { recursive: true });
    const wpPath = resolve(dir, "wp-gone.json");
    writeRetryState(wpPath, {
      retry_count: 1,
      max_retries: 3,
      in_backoff: true,
      backoff_until: "2026-04-20T18:00:00Z",
      exhausted: false,
    });
    expect(existsSync(retrySidecarPath(wpPath))).toBe(true);

    const removed = cleanupOrphanedRetryStates(dir);
    expect(removed).toBe(1);
    expect(existsSync(retrySidecarPath(wpPath))).toBe(false);
  });

  test("keeps sidecar when companion workpiece exists", () => {
    const dir = resolve(TEMP_DIR, "sweep-keep");
    mkdirSync(dir, { recursive: true });
    const wpPath = resolve(dir, "wp-present.json");
    writeFileSync(wpPath, "{}");
    writeRetryState(wpPath, {
      retry_count: 1,
      max_retries: 3,
      in_backoff: false,
      exhausted: false,
    });

    const removed = cleanupOrphanedRetryStates(dir);
    expect(removed).toBe(0);
    expect(existsSync(retrySidecarPath(wpPath))).toBe(true);
  });

  test("returns 0 for non-existent directory", () => {
    const removed = cleanupOrphanedRetryStates(resolve(TEMP_DIR, "no-such-dir"));
    expect(removed).toBe(0);
  });

  test("ignores non-sidecar files", () => {
    const dir = resolve(TEMP_DIR, "sweep-mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "random.json"), "{}");
    writeFileSync(resolve(dir, "note.txt"), "hello");
    const removed = cleanupOrphanedRetryStates(dir);
    expect(removed).toBe(0);
  });
});
