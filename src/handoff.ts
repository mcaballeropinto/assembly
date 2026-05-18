/**
 * Cross-process handoff state for `assembly daemon reload`.
 *
 * Old daemon serializes its in-flight worker registry to a file in
 * ~/.assembly/, then spawns the new daemon process. New daemon reads the
 * file, adopts the still-alive workers (registers them in its own
 * activeWorkerHandles, re-arms watchdogs, re-tails the stderr sidecar),
 * and only then deletes the file.
 *
 * The file path includes the old daemon's pid so concurrent reloads can't
 * trample each other. New daemon picks the freshest file at startup.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  statSync,
  renameSync,
} from "fs";
import { resolve } from "path";
import { ASSEMBLY_HOME } from "./paths";

export const HANDOFF_FILE_PREFIX = "handoff-";
export const HANDOFF_FILE_SUFFIX = ".json";
export const HANDOFF_VERSION = 1;

export interface HandoffWorker {
  pid: number;
  pgid: number;
  line_path: string;
  line_name: string;
  section_name: string;
  section_dir: string;
  processing_path: string;
  workpiece_id: string;
  started_at: string;
  flush_grace_s: number;
  /** Idle-timeout override that was in force when the worker was spawned (s). */
  timeout_s?: number;
  /** Max wall-clock override that was in force when the worker was spawned (s). */
  max_wall_clock_s?: number;
  stderr_sidecar: string;
}

export interface HandoffLineSnapshot {
  line_path: string;
  line_name: string;
  /** Snapshot of the in-memory retry counter map at handoff time. */
  retry_counts: Record<string, number>;
  /** Whether the line's usage gate was paused at handoff. */
  usage_paused: boolean;
  usage_pause_reason?: string;
}

export interface HandoffState {
  version: typeof HANDOFF_VERSION;
  old_pid: number;
  handoff_started_at: string;
  workers: HandoffWorker[];
  lines: HandoffLineSnapshot[];
}

export function handoffPathForPid(pid: number): string {
  return resolve(ASSEMBLY_HOME, `${HANDOFF_FILE_PREFIX}${pid}${HANDOFF_FILE_SUFFIX}`);
}

/**
 * Write a handoff state file atomically (tmp + rename). Path is derived from
 * the writer's pid. Caller is responsible for ASSEMBLY_HOME existing.
 */
export function writeHandoffState(state: HandoffState): string {
  const path = handoffPathForPid(state.old_pid);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
  return path;
}

/**
 * Find the freshest handoff file in ASSEMBLY_HOME, or null if none exist.
 * Used by the new daemon at startup to locate the predecessor's state.
 */
export function findLatestHandoff(): { path: string; state: HandoffState } | null {
  if (!existsSync(ASSEMBLY_HOME)) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(ASSEMBLY_HOME);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.startsWith(HANDOFF_FILE_PREFIX)) continue;
    if (!entry.endsWith(HANDOFF_FILE_SUFFIX)) continue;
    // Skip atomic-write temps.
    if (entry.includes(".tmp.")) continue;
    const full = resolve(ASSEMBLY_HOME, entry);
    try {
      const stat = statSync(full);
      if (best === null || stat.mtimeMs > best.mtimeMs) {
        best = { path: full, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // skip
    }
  }
  if (!best) return null;
  try {
    const raw = readFileSync(best.path, "utf-8");
    const parsed = JSON.parse(raw) as HandoffState;
    if (parsed.version !== HANDOFF_VERSION) {
      // Unknown version — leave the file alone for the operator to inspect,
      // act as if no handoff existed.
      return null;
    }
    return { path: best.path, state: parsed };
  } catch {
    return null;
  }
}

/**
 * Delete a consumed handoff file. Best-effort.
 */
export function consumeHandoffState(path: string): void {
  try { unlinkSync(path); } catch {}
}

/**
 * Cheap liveness check — does a process with this pid exist?
 * Returns false on ESRCH (no such process) or EPERM (no permission, which
 * also signals "process exists but isn't ours" — for our use only our own
 * children are relevant, so we treat EPERM as "not adoptable").
 */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
