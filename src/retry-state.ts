/**
 * Retry-state sidecar file management.
 *
 * The orchestrator writes a `<workpiece>.retry.json` sidecar file alongside
 * each workpiece when retry state changes. The dashboard reads these to surface
 * retry visualization without reaching into orchestrator memory.
 *
 * Sidecar lifecycle:
 *   - Written (atomic rename) when a retry is scheduled (backoff timer starts)
 *   - Cleared (unlinked) when the workpiece advances to the next station,
 *     enters error/, or the retry succeeds.
 */

import { writeFileSync, unlinkSync, readFileSync, existsSync, renameSync, readdirSync } from "fs";
import { resolve } from "path";
import type { FailureClass } from "./types";
import { RetryStateSchema } from "./schemas/retry-state";

export interface RetryState {
  retry_count: number;          // 0 when not retrying; 1+ for attempt N+1
  max_retries: number;          // from the retry policy matching the last failure class
  failure_class?: FailureClass;
  in_backoff: boolean;          // true if a setTimeout is scheduled
  backoff_until?: string;       // ISO timestamp, present iff in_backoff
  exhausted: boolean;           // retry_count >= max_retries AND last attempt failed
}

/**
 * Compute the sidecar path for a workpiece file.
 * e.g., /path/to/wp-1234.json -> /path/to/wp-1234.retry.json
 */
export function retrySidecarPath(workpiecePath: string): string {
  return workpiecePath.replace(/\.json$/, ".retry.json");
}

/**
 * Write retry state to the sidecar file (atomic: write tmp then rename).
 */
export function writeRetryState(workpiecePath: string, state: RetryState): void {
  const sidecar = retrySidecarPath(workpiecePath);
  const tmp = sidecar + ".tmp." + process.pid;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, sidecar);
  } catch {
    // Best-effort cleanup of temp file on failure
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Read retry state from the sidecar file. Returns null if missing or unparseable.
 */
export function readRetryState(workpiecePath: string): RetryState | null {
  const sidecar = retrySidecarPath(workpiecePath);
  try {
    if (!existsSync(sidecar)) return null;
    const raw = readFileSync(sidecar, "utf-8");
    const parsed = RetryStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn(`retry_state_schema_violation: ${sidecar}: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn(`retry_state_read_error: ${sidecar}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Remove the retry sidecar file (workpiece advanced or retries exhausted).
 */
export function clearRetryState(workpiecePath: string): void {
  const sidecar = retrySidecarPath(workpiecePath);
  try { unlinkSync(sidecar); } catch {}
}

/**
 * Remove any retry sidecars in `dir` whose companion workpiece file no longer exists.
 * Called on orchestrator startup so stale sidecars from a crashed daemon (or a
 * workpiece that was moved while the sidecar was left behind) don't show up on
 * the dashboard with stale `in_backoff: true` / bogus countdowns. Returns the
 * number of sidecars removed.
 */
export function cleanupOrphanedRetryStates(dir: string): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".retry.json")) continue;
      const sidecar = resolve(dir, name);
      const workpiece = resolve(dir, name.replace(/\.retry\.json$/, ".json"));
      if (!existsSync(workpiece)) {
        try { unlinkSync(sidecar); removed++; } catch {}
      }
    }
  } catch {}
  return removed;
}
