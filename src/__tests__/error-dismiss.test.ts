import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
import {
  readDismissed,
  dismissFilenames,
  undismissFilenames,
  autoArchiveOld,
} from "../error-dismiss";

const TEMP_DIR = resolve("/tmp", `assembly-test-error-dismiss-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "test-line");
const ERROR_DIR = resolve(LINE_DIR, "queues", "error");
const DISMISSED_FILE = resolve(ERROR_DIR, ".dismissed");

/** Create a minimal error workpiece JSON file */
function createErrorFile(fileName: string) {
  writeFileSync(
    resolve(ERROR_DIR, fileName),
    JSON.stringify({
      id: fileName.replace(".json", ""),
      line: "test-line",
      task: "test task",
      input: {},
      stations: {
        "station-a": {
          summary: "error",
          status: "failed",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          model: "test",
          tokens: { in: 100, out: 50 },
          cost_usd: 0.01,
        },
      },
    })
  );
}

beforeAll(() => {
  mkdirSync(ERROR_DIR, { recursive: true });
  createErrorFile("wp-err-1.json");
  createErrorFile("wp-err-2.json");
  createErrorFile("wp-err-3.json");
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("readDismissed", () => {
  test("returns {} when no .dismissed file exists", () => {
    try { rmSync(DISMISSED_FILE); } catch {}
    const map = readDismissed(LINE_DIR);
    expect(map).toEqual({});
  });

  test("returns {} for malformed JSON content", () => {
    writeFileSync(DISMISSED_FILE, "not valid json {{{");
    const map = readDismissed(LINE_DIR);
    expect(map).toEqual({});
    try { rmSync(DISMISSED_FILE); } catch {}
  });

  test("returns {} for non-object JSON (array)", () => {
    writeFileSync(DISMISSED_FILE, '["a", "b"]');
    const map = readDismissed(LINE_DIR);
    expect(map).toEqual({});
    try { rmSync(DISMISSED_FILE); } catch {}
  });

  test("returns {} for null JSON", () => {
    writeFileSync(DISMISSED_FILE, "null");
    const map = readDismissed(LINE_DIR);
    expect(map).toEqual({});
    try { rmSync(DISMISSED_FILE); } catch {}
  });

  test("returns parsed map for valid .dismissed file", () => {
    const data = {
      "wp-err-1.json": { dismissed_at: "2026-04-01T10:00:00Z" },
    };
    writeFileSync(DISMISSED_FILE, JSON.stringify(data));
    const map = readDismissed(LINE_DIR);
    expect(map).toEqual(data);
    try { rmSync(DISMISSED_FILE); } catch {}
  });
});

describe("dismissFilenames", () => {
  test("creates .dismissed and writes entries with dismissed_at timestamps", () => {
    try { rmSync(DISMISSED_FILE); } catch {}

    const result = dismissFilenames(LINE_DIR, ["wp-err-1.json"]);

    // Use bracket notation — toHaveProperty treats dots as nested paths
    expect("wp-err-1.json" in result).toBe(true);
    expect(result["wp-err-1.json"]).toBeDefined();
    expect(result["wp-err-1.json"].dismissed_at).toBeDefined();
    expect(new Date(result["wp-err-1.json"].dismissed_at).toISOString()).toBe(
      result["wp-err-1.json"].dismissed_at
    );

    // Verify file was written
    expect(existsSync(DISMISSED_FILE)).toBe(true);

    try { rmSync(DISMISSED_FILE); } catch {}
  });

  test("merges with existing dismissed entries", () => {
    writeFileSync(
      DISMISSED_FILE,
      JSON.stringify({ "wp-err-1.json": { dismissed_at: "2026-04-01T10:00:00Z" } })
    );

    const result = dismissFilenames(LINE_DIR, ["wp-err-2.json"]);

    // Both should be present
    expect("wp-err-1.json" in result).toBe(true);
    expect("wp-err-2.json" in result).toBe(true);
    expect(result["wp-err-1.json"].dismissed_at).toBe("2026-04-01T10:00:00Z");
    expect(result["wp-err-2.json"].dismissed_at).toBeDefined();

    try { rmSync(DISMISSED_FILE); } catch {}
  });

  test("prunes entries for files no longer on disk", () => {
    writeFileSync(
      DISMISSED_FILE,
      JSON.stringify({
        "wp-err-1.json": { dismissed_at: "2026-04-01T10:00:00Z" },
        "wp-gone.json": { dismissed_at: "2026-04-01T09:00:00Z" },
      })
    );

    const result = dismissFilenames(LINE_DIR, ["wp-err-2.json"]);

    // wp-gone.json should be pruned
    expect("wp-gone.json" in result).toBe(false);
    // The remaining entries should exist
    expect("wp-err-1.json" in result).toBe(true);
    expect("wp-err-2.json" in result).toBe(true);

    try { rmSync(DISMISSED_FILE); } catch {}
  });
});

describe("undismissFilenames", () => {
  test("removes specified entries from map", () => {
    writeFileSync(
      DISMISSED_FILE,
      JSON.stringify({
        "wp-err-1.json": { dismissed_at: "2026-04-01T10:00:00Z" },
        "wp-err-2.json": { dismissed_at: "2026-04-01T10:01:00Z" },
      })
    );

    const result = undismissFilenames(LINE_DIR, ["wp-err-1.json"]);

    expect("wp-err-1.json" in result).toBe(false);
    expect("wp-err-2.json" in result).toBe(true);

    try { rmSync(DISMISSED_FILE); } catch {}
  });

  test("is a no-op for nonexistent entries", () => {
    writeFileSync(
      DISMISSED_FILE,
      JSON.stringify({
        "wp-err-1.json": { dismissed_at: "2026-04-01T10:00:00Z" },
      })
    );

    const result = undismissFilenames(LINE_DIR, ["wp-nonexistent.json"]);

    expect("wp-err-1.json" in result).toBe(true);
    expect(Object.keys(result)).toHaveLength(1);

    try { rmSync(DISMISSED_FILE); } catch {}
  });
});

describe("atomic write", () => {
  test("no .dismissed.tmp residue after dismissFilenames", () => {
    try { rmSync(DISMISSED_FILE); } catch {}
    try { rmSync(DISMISSED_FILE + ".tmp"); } catch {}

    dismissFilenames(LINE_DIR, ["wp-err-1.json"]);

    // Only .dismissed should exist, not .dismissed.tmp
    expect(existsSync(DISMISSED_FILE)).toBe(true);
    expect(existsSync(DISMISSED_FILE + ".tmp")).toBe(false);

    // Double-check no .tmp files in the error directory
    const files = readdirSync(ERROR_DIR);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    try { rmSync(DISMISSED_FILE); } catch {}
  });
});

describe("autoArchiveOld", () => {
  const ARCHIVE_DIR = resolve(TEMP_DIR, "archive-line");
  const ARCHIVE_ERROR_DIR = resolve(ARCHIVE_DIR, "queues", "error");
  const ARCHIVE_DISMISSED = resolve(ARCHIVE_ERROR_DIR, ".dismissed");

  function createArchiveErrorFile(fileName: string, finishedAt: string) {
    writeFileSync(
      resolve(ARCHIVE_ERROR_DIR, fileName),
      JSON.stringify({
        id: fileName.replace(".json", ""),
        line: "archive-line",
        task: "test task",
        input: {},
        stations: {
          "station-a": {
            summary: "error",
            status: "failed",
            started_at: finishedAt,
            finished_at: finishedAt,
            model: "test",
            tokens: { in: 100, out: 50 },
            cost_usd: 0.01,
          },
        },
      })
    );
  }

  test("archives errors older than maxAgeMs", () => {
    mkdirSync(ARCHIVE_ERROR_DIR, { recursive: true });
    try { rmSync(ARCHIVE_DISMISSED); } catch {}

    const oldTime = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(); // 10 days ago
    createArchiveErrorFile("wp-old-1.json", oldTime);
    createArchiveErrorFile("wp-old-2.json", oldTime);

    const result = autoArchiveOld(ARCHIVE_DIR, 7 * 24 * 3_600_000);

    expect(result.archived).toBe(2);
    expect(existsSync(ARCHIVE_DISMISSED)).toBe(true);

    const map = JSON.parse(readFileSync(ARCHIVE_DISMISSED, "utf-8"));
    expect(map["wp-old-1.json"]).toBeDefined();
    expect(map["wp-old-1.json"].auto).toBe(true);
    expect(map["wp-old-1.json"].dismissed_at).toBeDefined();
    expect(map["wp-old-2.json"]).toBeDefined();
    expect(map["wp-old-2.json"].auto).toBe(true);

    // cleanup
    try { rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch {}
  });

  test("leaves fresh errors untouched", () => {
    mkdirSync(ARCHIVE_ERROR_DIR, { recursive: true });
    try { rmSync(ARCHIVE_DISMISSED); } catch {}

    const freshTime = new Date().toISOString();
    createArchiveErrorFile("wp-fresh.json", freshTime);

    const result = autoArchiveOld(ARCHIVE_DIR, 7 * 24 * 3_600_000);

    expect(result.archived).toBe(0);
    // No .dismissed should be created (nothing archived)
    expect(existsSync(ARCHIVE_DISMISSED)).toBe(false);

    try { rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch {}
  });

  test("preserves existing manual dismissals", () => {
    mkdirSync(ARCHIVE_ERROR_DIR, { recursive: true });

    // Create a manual entry and a corresponding file
    const manualEntry = { "wp-manual.json": { dismissed_at: "2026-04-01T10:00:00Z" } };
    writeFileSync(ARCHIVE_DISMISSED, JSON.stringify(manualEntry));
    createArchiveErrorFile("wp-manual.json", new Date().toISOString());

    // Also add an old error
    const oldTime = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    createArchiveErrorFile("wp-old-manual.json", oldTime);

    const result = autoArchiveOld(ARCHIVE_DIR, 7 * 24 * 3_600_000);

    expect(result.archived).toBe(1);
    const map = JSON.parse(readFileSync(ARCHIVE_DISMISSED, "utf-8"));
    // Manual entry should still be present
    expect(map["wp-manual.json"]).toBeDefined();
    expect(map["wp-manual.json"].dismissed_at).toBe("2026-04-01T10:00:00Z");
    // New auto entry
    expect(map["wp-old-manual.json"].auto).toBe(true);

    try { rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch {}
  });

  test("returns { archived: 0 } when no error dir exists", () => {
    const result = autoArchiveOld("/tmp/nonexistent-line-" + Date.now());
    expect(result).toEqual({ archived: 0 });
  });

  test("returns correct archived count with mix of old and fresh", () => {
    mkdirSync(ARCHIVE_ERROR_DIR, { recursive: true });
    try { rmSync(ARCHIVE_DISMISSED); } catch {}

    const oldTime = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const freshTime = new Date().toISOString();
    createArchiveErrorFile("wp-mix-old-1.json", oldTime);
    createArchiveErrorFile("wp-mix-old-2.json", oldTime);
    createArchiveErrorFile("wp-mix-old-3.json", oldTime);
    createArchiveErrorFile("wp-mix-fresh-1.json", freshTime);
    createArchiveErrorFile("wp-mix-fresh-2.json", freshTime);

    const result = autoArchiveOld(ARCHIVE_DIR, 7 * 24 * 3_600_000);
    expect(result.archived).toBe(3);

    try { rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch {}
  });
});
