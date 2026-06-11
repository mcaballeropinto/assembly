import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import {
  readUsageSnapshot,
  writeUsageSnapshot,
  getUsageSnapshotFile,
  type UsageSnapshot,
} from "../usage-snapshot";

const TMP_DIR = resolve("/tmp", `assembly-usage-snap-${Date.now()}-${process.pid}`);
const SNAP_PATH = resolve(TMP_DIR, "usage-status.json");
const originalEnv = process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;

function healthy(): UsageSnapshot {
  return {
    checkedAt: "2026-04-20T10:00:00Z",
    threshold: 75,
    paused: false,
    providers: {
      "claude-code": {
        buckets: [
          { label: "5h session", utilization: 17, resets_at: "2026-04-20T15:00:00Z" },
          { label: "7d combined", utilization: 28, resets_at: "2026-04-24T16:00:00Z" },
        ],
        raw: { five_hour: { utilization: 17, resets_at: "2026-04-20T15:00:00Z" } },
      },
    },
  };
}

function paused(): UsageSnapshot {
  return {
    checkedAt: "2026-04-20T10:00:00Z",
    threshold: 75,
    paused: true,
    pauseReason: "codex: 5h session at 81.2% (>= 75%), resets 2026-04-20T15:00:00Z",
    providers: {
      codex: {
        buckets: [
          { label: "5h session", utilization: 81.2, resets_at: "2026-04-20T15:00:00Z" },
        ],
      },
    },
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = SNAP_PATH;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE;
  else process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE = originalEnv;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("writeUsageSnapshot / readUsageSnapshot", () => {
  test("roundtrip — healthy snapshot", () => {
    const snap = healthy();
    writeUsageSnapshot(snap);
    const back = readUsageSnapshot();
    expect(back).not.toBeNull();
    expect(back?.paused).toBe(false);
    expect(back?.threshold).toBe(75);
    expect(back?.providers["claude-code"]?.buckets.length).toBe(2);
    expect(back?.providers["claude-code"]?.buckets[0].label).toBe("5h session");
  });

  test("roundtrip — paused snapshot preserves pauseReason", () => {
    const snap = paused();
    writeUsageSnapshot(snap);
    const back = readUsageSnapshot();
    expect(back?.paused).toBe(true);
    expect(back?.pauseReason).toMatch(/5h session at 81\.2%/);
    expect(back?.providers.codex?.buckets[0].label).toBe("5h session");
  });

  test("returns null when file missing", () => {
    expect(readUsageSnapshot()).toBeNull();
  });

  test("returns null (no throw) on malformed JSON", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(SNAP_PATH, "{ not json ]]]");
    const back = readUsageSnapshot();
    expect(back).toBeNull();
  });

  test("concurrent writes — file always parses as valid JSON", async () => {
    const snaps = [healthy(), paused(), healthy(), paused(), healthy()];
    await Promise.all(snaps.map((s) => Promise.resolve().then(() => writeUsageSnapshot(s))));
    const back = readUsageSnapshot();
    expect(back).not.toBeNull();
    // No stray tmp files left behind
    const leftover = readdirSync(TMP_DIR).filter((f) => f.includes(".tmp."));
    expect(leftover.length).toBe(0);
    expect(existsSync(SNAP_PATH)).toBe(true);
  });

  test("getUsageSnapshotFile honors env override", () => {
    expect(getUsageSnapshotFile()).toBe(SNAP_PATH);
  });
});
