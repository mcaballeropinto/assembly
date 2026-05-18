import { appendFileSync, unlinkSync, renameSync, existsSync } from "fs";

/**
 * Per-station diagnostic capture of the raw claude-code stream-json session.
 *
 * Purpose: when a claude-code session goes silent and hits idle-timeout (the
 * primary failure mode observed in production), the `.progress.jsonl` sidecar
 * only records summarized tool-use events. We lose the raw event stream and
 * any stderr — making it impossible to explain WHY the session went silent.
 *
 * This module tees the raw claude-code stdout (newline-delimited JSON) plus
 * our own start/end meta entries into `<workpiecePath>.session.jsonl`.
 *
 * Retention:
 *   success  → unlinkSessionLog()           (dropped alongside progress.jsonl)
 *   failure  → moveSessionLogAlongside()    (travels with workpiece through
 *                                            output/ → error/)
 *
 * Format: newline-delimited JSON. Assembly-emitted entries carry
 * `type: "assembly_meta"`; raw claude-code events keep their own `type`
 * (assistant | user | result | ...) unchanged. Readers discriminate on `type`.
 */

export const SESSION_LOG_SUFFIX = ".session.jsonl";

export function sessionLogPathFor(workpiecePath: string): string {
  return workpiecePath + SESSION_LOG_SUFFIX;
}

export function openSessionLog(
  path: string,
  meta: Record<string, unknown>
): void {
  // Append a start-of-session marker. Multiple openSessionLog calls within
  // a single station's lifecycle (e.g. main LLM call + repair call) are
  // expected — they share the same log so the operator can see both
  // attempts when triaging failures. Prior log files from earlier runs
  // of the SAME station are wiped by the orchestrator via
  // `unlinkSessionLog` between runs, so we never need to truncate here.
  try {
    appendFileSync(
      path,
      JSON.stringify({ type: "assembly_meta", phase: "start", ts: new Date().toISOString(), ...meta }) + "\n"
    );
  } catch {
    // Logging is best-effort; never let IO errors derail the session.
  }
}

export function appendSessionLogRaw(path: string, rawLine: string): void {
  if (!rawLine) return;
  try {
    appendFileSync(path, rawLine + "\n");
  } catch {}
}

export function closeSessionLog(
  path: string,
  meta: Record<string, unknown>
): void {
  try {
    appendFileSync(
      path,
      JSON.stringify({ type: "assembly_meta", phase: "end", ts: new Date().toISOString(), ...meta }) + "\n"
    );
  } catch {}
}

/**
 * Unlink the session log. Safe to call if the file doesn't exist.
 *
 * When `ASSEMBLY_KEEP_SESSION_LOGS=1`, retention is forced on even for
 * successful runs so operators can inspect what a working station actually
 * emitted (tool-call patterns, timing, near-miss repairs). Default keeps the
 * original behaviour: success → drop, failure → preserve via
 * `moveSessionLogAlongside`.
 */
export function unlinkSessionLog(workpiecePath: string): void {
  if (process.env.ASSEMBLY_KEEP_SESSION_LOGS === "1") return;
  const p = sessionLogPathFor(workpiecePath);
  try {
    unlinkSync(p);
  } catch {}
}

/**
 * Rename the session log to follow a workpiece that's been moved
 * (e.g. processing/ → output/, output/ → error/). No-op if absent.
 */
export function moveSessionLogAlongside(
  oldWorkpiecePath: string,
  newWorkpiecePath: string
): void {
  const src = sessionLogPathFor(oldWorkpiecePath);
  const dst = sessionLogPathFor(newWorkpiecePath);
  if (!existsSync(src)) return;
  try {
    renameSync(src, dst);
  } catch {}
}
