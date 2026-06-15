/**
 * Tests for the producer-tracked inbox allowlist (src/emit-manifest.ts).
 *
 * Background: a Bash-armed agent was observed writing fake fanout JSON
 * files into a downstream station's inbox after its real fetch failed.
 * The orchestrator would have processed them as legitimate workpieces.
 * The manifest module is the detection layer that quarantines unverified
 * inbox files.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, appendFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  recordEmit,
  isEmitted,
  quarantineUnverified,
  bootstrapManifest,
  isManifestSidecar,
  _resetCacheForTests,
} from "../emit-manifest";

let workDir: string;

beforeEach(() => {
  workDir = resolve(tmpdir(), `emit-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  _resetCacheForTests();
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
  _resetCacheForTests();
});

describe("recordEmit + isEmitted", () => {
  it("records and recognizes a fanout filename", () => {
    expect(isEmitted(workDir, "task-123-from-test-dispatcher.json")).toBe(false);
    recordEmit(workDir, "task-123-from-test-dispatcher.json", "fanout");
    expect(isEmitted(workDir, "task-123-from-test-dispatcher.json")).toBe(true);
  });

  it("normalizes absolute paths to basenames", () => {
    const fullPath = resolve(workDir, "task-456.json");
    recordEmit(workDir, fullPath, "cli");
    expect(isEmitted(workDir, "task-456.json")).toBe(true);
    expect(isEmitted(workDir, fullPath)).toBe(true);
  });

  it("does not authorize files in a different queue dir", () => {
    const otherDir = resolve(workDir, "other");
    mkdirSync(otherDir, { recursive: true });
    recordEmit(workDir, "task-789.json", "fanout");
    expect(isEmitted(otherDir, "task-789.json")).toBe(false);
  });

  it("creates the queue dir on first record if missing", () => {
    const newDir = resolve(workDir, "deep", "nested", "queue");
    expect(existsSync(newDir)).toBe(false);
    recordEmit(newDir, "task-1.json", "trigger");
    expect(existsSync(newDir)).toBe(true);
    expect(isEmitted(newDir, "task-1.json")).toBe(true);
  });
});

describe("manifest persistence", () => {
  it("survives a cache reset (simulates daemon restart)", () => {
    recordEmit(workDir, "task-survives.json", "fanout");
    expect(isEmitted(workDir, "task-survives.json")).toBe(true);

    _resetCacheForTests();

    // After reset, loadManifest must repopulate from disk.
    expect(isEmitted(workDir, "task-survives.json")).toBe(true);
  });

  it("writes one JSONL line per emit with source + ts", () => {
    recordEmit(workDir, "a.json", "fanout");
    recordEmit(workDir, "b.json", "cli");
    const text = readFileSync(resolve(workDir, ".emitted.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.filename).toBe("a.json");
    expect(a.source).toBe("fanout");
    expect(typeof a.ts).toBe("string");
    expect(b.source).toBe("cli");
  });

  it("isEmitted re-reads the manifest on cache miss so sibling-process appends are visible", () => {
    // Simulates the running-daemon vs `assembly enqueue` CLI scenario:
    // the daemon warms its in-memory cache once at startup, then the CLI
    // (a separate process) appends a new entry to .emitted.jsonl. Without
    // a cache-miss fallback the daemon would quarantine the matching
    // inbox file even though the manifest on disk authorizes it.
    recordEmit(workDir, "old.json", "fanout");
    expect(isEmitted(workDir, "old.json")).toBe(true);

    // Append from "another process" — bypasses this process's cache.
    appendFileSync(
      resolve(workDir, ".emitted.jsonl"),
      JSON.stringify({
        filename: "new-from-cli.json",
        source: "cli",
        ts: new Date().toISOString(),
      }) + "\n"
    );

    expect(isEmitted(workDir, "new-from-cli.json")).toBe(true);
    // Old entry still hits the cache fast-path.
    expect(isEmitted(workDir, "old.json")).toBe(true);
    // Truly unknown entries still return false (no false positives).
    expect(isEmitted(workDir, "actually-rogue.json")).toBe(false);
  });

  it("tolerates a torn trailing line in the manifest", () => {
    // Simulate a partial append from a previous crashed write.
    writeFileSync(
      resolve(workDir, ".emitted.jsonl"),
      `{"filename":"good.json","source":"fanout","ts":"2026-01-01T00:00:00Z"}\n{"filename":"bad","sourc`
    );
    expect(isEmitted(workDir, "good.json")).toBe(true);
    // Bad line should be silently dropped, not crash.
    expect(isEmitted(workDir, "bad")).toBe(false);
  });

  it("skips schema-invalid manifest lines", () => {
    writeFileSync(
      resolve(workDir, ".emitted.jsonl"),
      `{"filename":"good.json","source":"fanout","ts":"2026-01-01T00:00:00Z"}\n{"filename":"bad.json","source":"bogus","ts":"2026-01-01T00:00:00Z"}\n`
    );
    expect(isEmitted(workDir, "good.json")).toBe(true);
    expect(isEmitted(workDir, "bad.json")).toBe(false);
  });
});

describe("quarantineUnverified", () => {
  it("moves the file to .unverified/ with a timestamped name", () => {
    const filePath = resolve(workDir, "rogue.json");
    writeFileSync(filePath, '{"injected":true}');
    const dest = quarantineUnverified(workDir, filePath);
    expect(dest).not.toBeNull();
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dest!)).toBe(true);
    expect(dest!).toContain(".unverified");
    expect(dest!).toMatch(/-rogue\.json$/);
    // Content preserved for forensics.
    expect(readFileSync(dest!, "utf8")).toBe('{"injected":true}');
  });

  it("also moves the .session.jsonl sidecar if present", () => {
    const filePath = resolve(workDir, "rogue2.json");
    writeFileSync(filePath, "{}");
    writeFileSync(filePath + ".session.jsonl", "session-content");
    const dest = quarantineUnverified(workDir, filePath);
    expect(existsSync(dest! + ".session.jsonl")).toBe(true);
    expect(existsSync(filePath + ".session.jsonl")).toBe(false);
  });

  it("returns null if the file already vanished", () => {
    expect(quarantineUnverified(workDir, resolve(workDir, "ghost.json"))).toBeNull();
  });
});

describe("bootstrapManifest", () => {
  it("auto-records existing inbox files at first start (lenient migration)", () => {
    // Simulate an inbox that has files but no manifest yet — exactly the
    // shape we hit when shipping this feature with a populated queue.
    writeFileSync(resolve(workDir, "task-existing-1.json"), "{}");
    writeFileSync(resolve(workDir, "task-existing-2.json"), "{}");

    const added = bootstrapManifest(workDir);
    expect(added).toBe(2);
    expect(isEmitted(workDir, "task-existing-1.json")).toBe(true);
    expect(isEmitted(workDir, "task-existing-2.json")).toBe(true);
  });

  it("is idempotent — second call adds nothing", () => {
    writeFileSync(resolve(workDir, "task-A.json"), "{}");
    expect(bootstrapManifest(workDir)).toBe(1);
    expect(bootstrapManifest(workDir)).toBe(0);
  });

  it("does not record sidecar files (.retry.json, .tmp.X)", () => {
    writeFileSync(resolve(workDir, "task-A.json"), "{}");
    writeFileSync(resolve(workDir, "task-A.retry.json"), "{}");
    writeFileSync(resolve(workDir, "task-A.tmp.99999"), "{}");
    expect(bootstrapManifest(workDir)).toBe(1);
    expect(isEmitted(workDir, "task-A.json")).toBe(true);
    expect(isEmitted(workDir, "task-A.retry.json")).toBe(false);
    expect(isEmitted(workDir, "task-A.tmp.99999")).toBe(false);
  });

  it("does not re-record files already on the manifest", () => {
    writeFileSync(resolve(workDir, "task-known.json"), "{}");
    recordEmit(workDir, "task-known.json", "fanout");
    expect(bootstrapManifest(workDir)).toBe(0);
  });
});

describe("isManifestSidecar", () => {
  it("identifies the manifest and quarantine dir names", () => {
    expect(isManifestSidecar(".emitted.jsonl")).toBe(true);
    expect(isManifestSidecar(".unverified")).toBe(true);
    expect(isManifestSidecar("task-1.json")).toBe(false);
    expect(isManifestSidecar(".retry.json")).toBe(false);
  });
});

describe("end-to-end: rogue inbox file is detected", () => {
  it("a file written without recordEmit is not on the allowlist", () => {
    // This is the rogue-agent scenario: a JSON file written directly
    // into the inbox dir without going through any of the orchestrator
    // emit paths.
    const roguePath = resolve(workDir, "task-rogue-fanout-001-from-test-dispatcher.json");
    writeFileSync(roguePath, JSON.stringify({ task: "rogue", input: {} }));

    expect(isEmitted(workDir, "task-rogue-fanout-001-from-test-dispatcher.json")).toBe(false);

    const dest = quarantineUnverified(workDir, roguePath);
    expect(dest).not.toBeNull();
    expect(existsSync(roguePath)).toBe(false);
    // Quarantine sweep landed in .unverified/
    const unverifiedDir = resolve(workDir, ".unverified");
    expect(existsSync(unverifiedDir)).toBe(true);
    const contents = readdirSync(unverifiedDir);
    expect(contents.length).toBe(1);
    expect(contents[0]).toMatch(/-task-rogue-fanout-001-from-test-dispatcher\.json$/);
  });
});
