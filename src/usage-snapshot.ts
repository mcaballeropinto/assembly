import { writeFileSync, renameSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { USAGE_SNAPSHOT_FILE } from "./paths";

// ─── Persistent Usage Snapshot ───────────────────────────────────────
//
// Single global file at ~/.assembly/usage-status.json that captures the
// orchestrator's most recent view of provider usage. The dashboard reads
// this out of band from its main 3s refresh loop.

export interface BucketSnapshot {
  label: string;              // "5h session" | "7d combined" | "7d opus" | "7d sonnet"
  utilization: number;        // 0–100, from the OAuth endpoint verbatim
  resets_at: string | null;   // ISO; mirrors the endpoint
}

export interface UsageSnapshot {
  checkedAt: string;          // ISO, set at write time
  threshold: number;          // 0–100, effective threshold
  paused: boolean;            // the orchestrator's current decision
  pauseReason?: string;       // human-readable, only when paused
  providers: {
    "claude-code"?: {
      buckets: BucketSnapshot[];
      raw?: Record<string, unknown>;
      error?: string;
    };
    codex?: {
      buckets: BucketSnapshot[];
      raw?: Record<string, unknown>;
      error?: string;
    };
  };
}

/**
 * Resolve the snapshot file path. Honors ASSEMBLY_USAGE_SNAPSHOT_FILE so
 * tests can redirect reads/writes to a tmp file without touching ~/.assembly.
 */
export function getUsageSnapshotFile(): string {
  return process.env.ASSEMBLY_USAGE_SNAPSHOT_FILE || USAGE_SNAPSHOT_FILE;
}

/**
 * Write the snapshot atomically. Temp file then rename — same FS guarantees
 * concurrent readers never see a half-written file.
 */
export function writeUsageSnapshot(snapshot: UsageSnapshot): void {
  const target = getUsageSnapshotFile();
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, target);
}

/**
 * Read the snapshot. Returns null on missing file or malformed JSON —
 * callers treat "no data" as a display state, not an error.
 */
export function readUsageSnapshot(): UsageSnapshot | null {
  const target = getUsageSnapshotFile();
  try {
    const raw = readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as UsageSnapshot;
  } catch {
    return null;
  }
}
