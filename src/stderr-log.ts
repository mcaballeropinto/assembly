import {
  appendFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  watch as fsWatch,
} from "fs";

/**
 * Per-worker stderr sidecar.
 *
 * Today the orchestrator captures worker stderr through `Bun.spawn`'s pipe
 * (orchestrator.ts `proc.stderr` reader) for activity logging and as a
 * liveness signal for the idle watchdog. That works for owned children, but
 * the pipe dies when the parent daemon dies. To support the reload/handoff
 * flow — where a new daemon adopts an in-flight worker — we redirect the
 * worker's stderr to a file at spawn time so a successor process can tail it
 * from disk.
 *
 * Retention parallels session-log.ts:
 *   success  → unlinkStderrLog()       (drop alongside progress.jsonl)
 *   failure  → moveStderrLogAlongside  (travel with workpiece through queues)
 *
 * The file is opened in `'a'` mode and the fd is passed to Bun.spawn as the
 * worker's stderr. The orchestrator never writes to the file directly — only
 * the worker does (or the kernel on its behalf). The orchestrator reads it
 * with a tailing fd + fs.watch for activity-log fan-out.
 */

export const STDERR_LOG_SUFFIX = ".stderr.log";

export function stderrLogPathFor(workpiecePath: string): string {
  return workpiecePath + STDERR_LOG_SUFFIX;
}

/**
 * Open the stderr sidecar for writing. Returns a numeric fd that the caller
 * should pass to Bun.spawn as the worker's stderr argument, then close (after
 * spawn — Bun dup's it). Truncates any pre-existing file so each invocation
 * starts clean.
 */
export function openStderrSink(workpiecePath: string): number {
  const path = stderrLogPathFor(workpiecePath);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort truncate. If unlink races against a tailer we still open
    // 'a' below — worst case the file has some prior bytes prepended.
  }
  // 'a' creates the file if missing and opens for append. We do not write
  // anything from the orchestrator side — only the spawned worker writes
  // (via its inherited stderr fd).
  return openSync(path, "a");
}

/**
 * Tail a stderr sidecar. Calls `onChunk(text)` whenever new bytes are written.
 * Returns a stop function.
 *
 * Implementation: fs.watch on the parent directory (so we still get events
 * after the file is renamed alongside the workpiece into output/) is overkill
 * here — we watch the file itself, and on every rename or write event we
 * advance our offset. Periodic polling at 1 Hz is a backstop for inotify
 * gaps. Caller is responsible for handling final drain after worker exit.
 */
export function tailStderrSink(
  path: string,
  onChunk: (text: string) => void,
  opts: { pollIntervalMs?: number } = {}
): () => void {
  let fd: number | null = null;
  let offset = 0;
  let stopped = false;

  const open = () => {
    if (fd !== null) return;
    try {
      fd = openSync(path, "r");
    } catch {
      fd = null;
    }
  };

  const drain = () => {
    if (stopped) return;
    if (fd === null) open();
    if (fd === null) return;
    try {
      const stat = statSync(path);
      if (stat.size <= offset) return;
      const buf = Buffer.alloc(stat.size - offset);
      const bytes = readSync(fd, buf, 0, buf.length, offset);
      if (bytes > 0) {
        offset += bytes;
        const text = buf.slice(0, bytes).toString("utf-8");
        if (text.length > 0) onChunk(text);
      }
    } catch {
      // File may have been removed (success path unlinks). Stop trying.
      try { if (fd !== null) closeSync(fd); } catch {}
      fd = null;
    }
  };

  // Initial drain — pick up anything already written before tail started.
  drain();

  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(path, () => drain());
  } catch {
    // File may not exist yet — polling alone will catch it.
  }

  const pollMs = opts.pollIntervalMs ?? 1000;
  const timer = setInterval(drain, pollMs);
  if (timer.unref) timer.unref();

  return () => {
    stopped = true;
    if (watcher) {
      try { watcher.close(); } catch {}
    }
    clearInterval(timer);
    drain(); // final pass
    try { if (fd !== null) closeSync(fd); } catch {}
    fd = null;
  };
}

/**
 * Unlink the stderr sidecar. Safe to call if the file doesn't exist.
 *
 * `ASSEMBLY_KEEP_STDERR_LOGS=1` forces retention on even for successful runs
 * (mirrors ASSEMBLY_KEEP_SESSION_LOGS).
 */
export function unlinkStderrLog(workpiecePath: string): void {
  if (process.env.ASSEMBLY_KEEP_STDERR_LOGS === "1") return;
  const p = stderrLogPathFor(workpiecePath);
  try {
    unlinkSync(p);
  } catch {}
}

/**
 * Rename the stderr sidecar to follow a workpiece that's been moved
 * (processing/ → output/, output/ → error/). No-op if absent.
 */
export function moveStderrLogAlongside(
  oldWorkpiecePath: string,
  newWorkpiecePath: string
): void {
  const src = stderrLogPathFor(oldWorkpiecePath);
  const dst = stderrLogPathFor(newWorkpiecePath);
  if (!existsSync(src)) return;
  try {
    renameSync(src, dst);
  } catch {}
}

/**
 * Append a synthetic line to the stderr sidecar from the orchestrator side.
 * Used at adoption time so post-mortem reading shows the handoff in the log.
 * Best-effort.
 */
export function appendStderrMarker(workpiecePath: string, line: string): void {
  const p = stderrLogPathFor(workpiecePath);
  try {
    appendFileSync(p, line.endsWith("\n") ? line : line + "\n");
  } catch {}
}
