import { resolve, basename } from "path";
import { mkdirSync, renameSync, readdirSync, readFileSync, watch, existsSync } from "fs";
import type { Workpiece } from "./types";
import { readDismissed } from "./error-dismiss";
import { validateWorkpieceVersion } from './schemas/workpiece';

/**
 * Queue folder structure for a section or line.
 */
export interface QueuePaths {
  inbox: string;
  processing: string;
  output: string;
}

/**
 * Line-level queue paths (inbox, done, error).
 */
export interface LineQueuePaths {
  inbox: string;
  held: string;
  done: string;
  error: string;
  review: string;
}

/**
 * Initialize queue folders for a section.
 */
export function initSectionQueue(stationDir: string): QueuePaths {
  const paths: QueuePaths = {
    inbox: resolve(stationDir, "queue", "inbox"),
    processing: resolve(stationDir, "queue", "processing"),
    output: resolve(stationDir, "queue", "output"),
  };

  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true });
  }

  return paths;
}

/**
 * Initialize queue folders for a line.
 */
export function initLineQueue(linePath: string): LineQueuePaths {
  const paths: LineQueuePaths = {
    inbox: resolve(linePath, "queues", "inbox"),
    held: resolve(linePath, "queues", "held"),
    done: resolve(linePath, "queues", "done"),
    error: resolve(linePath, "queues", "error"),
    review: resolve(linePath, "queues", "review"),
  };

  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true });
  }

  return paths;
}

/**
 * Claim a file from a queue folder by atomically moving it to another folder.
 * Returns the new path if successful, null if the file was already claimed.
 */
export function claimFile(
  sourcePath: string,
  destDir: string
): string | null {
  const fileName = basename(sourcePath);
  const destPath = resolve(destDir, fileName);

  try {
    renameSync(sourcePath, destPath);
    return destPath;
  } catch {
    // File was already moved (claimed by someone else) or doesn't exist
    return null;
  }
}

/**
 * Move a file from one queue folder to another. Companion sidecars (the
 * `.session.jsonl` raw claude-code stream and the `.stderr.log` worker
 * stderr capture) follow the workpiece so post-mortem stays possible from
 * wherever it lands.
 */
export function moveFile(sourcePath: string, destDir: string): string {
  const fileName = basename(sourcePath);
  const destPath = resolve(destDir, fileName);
  renameSync(sourcePath, destPath);
  for (const suffix of [".session.jsonl", ".stderr.log"]) {
    const src = sourcePath + suffix;
    if (existsSync(src)) {
      try { renameSync(src, destPath + suffix); } catch {}
    }
  }
  return destPath;
}

/**
 * Sidecars share the `.json` extension with workpieces but aren't workpieces.
 * Treating them as workpieces makes the output watcher crash
 * (`workpiece.stations[...]` on a RetryState sidecar) and makes drainInbox
 * spawn workers on temp files. Filter them out at the listing/watching layer.
 *
 * Currently:
 *   - `*.retry.json`     — retry-state sidecar (retry-state.ts)
 *   - `*.envelope.json`  — invocation-scoped LLM envelope (section-worker.ts).
 *                          Lives next to the workpiece during a run; can be
 *                          left behind in a queue dir after the workpiece is
 *                          renamed onward, and the 10s rescan was reading
 *                          each orphan as a workpiece every tick.
 *   - `*.tmp.<pid>`      — atomic-write temps (suffix matches `<pid>` so the
 *                          trailing `.json` of the destination isn't part of
 *                          the temp name; we still defensively skip anything
 *                          containing `.tmp.`)
 */
export function isQueueSidecarFile(filename: string): boolean {
  if (filename.endsWith(".retry.json")) return true;
  if (filename.endsWith(".envelope.json")) return true;
  if (filename.includes(".tmp.")) return true;
  // emit-manifest.ts artifacts — `.emitted.jsonl` is per-queue producer
  // tracking, `.unverified` is its quarantine subdir. Neither should ever
  // be treated as a workpiece.
  if (filename === ".emitted.jsonl") return true;
  if (filename === ".unverified") return true;
  return false;
}

/**
 * List all JSON workpiece files in a queue folder, sorted by modification time
 * (oldest first). Sidecar files (see `isQueueSidecarFile`) are excluded.
 */
export function listQueue(dir: string): string[] {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !isQueueSidecarFile(f))
      .map((f) => resolve(dir, f))
      .sort((a, b) => {
        const aStat = Bun.file(a);
        const bStat = Bun.file(b);
        return (aStat.lastModified ?? 0) - (bStat.lastModified ?? 0);
      });
  } catch {
    return [];
  }
}

/**
 * Count JSON files in a queue folder.
 */
export function countQueue(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Set of task keys currently sitting in a line's `queues/done/`. A task's key
 * is its filename without `.json` — stable across queue moves, so a workpiece
 * enqueued as `alpha.json` is referenced as `"alpha"` in another workpiece's
 * `dependsOn` regardless of which section it's parked in.
 */
export function listCompletedTaskKeys(doneDir: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(doneDir)) return keys;
  try {
    for (const f of readdirSync(doneDir)) {
      if (f.endsWith(".json") && !isQueueSidecarFile(f)) {
        keys.add(f.replace(/\.json$/, ""));
      }
    }
  } catch {
    // unreadable → treat as empty; drain will retry on the next tick
  }
  return keys;
}

/**
 * Filter inbox candidates down to those whose `dependsOn` keys are all
 * present in `doneKeys`. Workpieces with no `dependsOn` always pass. Files
 * that fail to parse pass through so the normal worker pipeline produces
 * the error envelope (rather than silently stalling here).
 */
export function filterReadyByDeps(
  inboxFiles: string[],
  doneKeys: Set<string>
): string[] {
  if (inboxFiles.length === 0) return inboxFiles;
  return inboxFiles.filter((path) => {
    let deps: string[] | undefined;
    try {
      const wp = JSON.parse(readFileSync(path, "utf-8")) as { dependsOn?: unknown };
      const raw = wp.dependsOn;
      if (Array.isArray(raw)) deps = raw.filter((x): x is string => typeof x === "string");
    } catch {
      return true;
    }
    if (!deps || deps.length === 0) return true;
    return deps.every((k) => doneKeys.has(k));
  });
}

/**
 * Write a workpiece JSON to a queue folder.
 */
export async function writeToQueue(
  workpiece: Workpiece,
  destDir: string,
  fileName?: string
): Promise<string> {
  const name = fileName ?? `${workpiece.id}.json`;
  const destPath = resolve(destDir, name);
  await Bun.write(destPath, JSON.stringify(workpiece, null, 2));
  return destPath;
}

/**
 * Read a workpiece from a queue file.
 */
export async function readFromQueue(filePath: string): Promise<Workpiece> {
  const file = Bun.file(filePath);
  const raw = JSON.parse(await file.text()) as Record<string, unknown>;
  validateWorkpieceVersion(raw);
  return raw as unknown as Workpiece;
}

/**
 * Watch a folder for new files. Calls the callback when a .json file appears.
 * Returns an abort function to stop watching.
 *
 * Linux inotify can coalesce or drop `rename` events under rapid bursts, which
 * leaves files orphaned in the watched dir. The optional periodic rescan
 * re-invokes `onFile` for whatever is currently present so handlers — which
 * must be idempotent via atomic claimFile/moveFile — recover dropped events
 * within ~rescanIntervalMs. Pass 0 to disable.
 */
export type WatchFolderStop = (() => void) & {
  /** Underlying fs.watch handle — exposed for tests that need to simulate inotify failures. */
  _watcher: ReturnType<typeof watch>;
};

export function watchFolder(
  dir: string,
  onFile: (filePath: string) => void,
  options: { rescanIntervalMs?: number } = {}
): WatchFolderStop {
  mkdirSync(dir, { recursive: true });

  // Process any existing files first
  const existing = listQueue(dir);
  for (const file of existing) {
    onFile(file);
  }

  // Watch for new files
  const watcher = watch(dir, (event, filename) => {
    if (
      event === "rename" &&
      filename &&
      filename.endsWith(".json") &&
      !isQueueSidecarFile(filename)
    ) {
      const filePath = resolve(dir, filename);
      // Only trigger if the file exists (rename fires on both create and delete)
      if (existsSync(filePath)) {
        onFile(filePath);
      }
    }
  });

  const intervalMs = options.rescanIntervalMs ?? 10_000;
  const rescanTimer =
    intervalMs > 0
      ? setInterval(() => {
          for (const file of listQueue(dir)) {
            onFile(file);
          }
        }, intervalMs)
      : null;

  const stop = (() => {
    watcher.close();
    if (rescanTimer) clearInterval(rescanTimer);
  }) as WatchFolderStop;
  stop._watcher = watcher;
  return stop;
}

/**
 * Get the current state of all queues for a section.
 */
export function getSectionQueueState(stationDir: string): {
  inbox: number;
  processing: number;
  output: number;
} {
  return {
    inbox: countQueue(resolve(stationDir, "queue", "inbox")),
    processing: countQueue(resolve(stationDir, "queue", "processing")),
    output: countQueue(resolve(stationDir, "queue", "output")),
  };
}

/**
 * Get the current state of all queues for a line.
 */
export function getLineQueueState(linePath: string): {
  inbox: number;
  held: number;
  done: number;
  error: number;
  errorActive: number;
  review: number;
} {
  const errorCount = countQueue(resolve(linePath, "queues", "error"));
  const dismissedMap = readDismissed(linePath);
  const dismissedCount = Object.keys(dismissedMap).length;
  const errorActive = Math.max(0, errorCount - dismissedCount);
  return {
    inbox: countQueue(resolve(linePath, "queues", "inbox")),
    held: countQueue(resolve(linePath, "queues", "held")),
    done: countQueue(resolve(linePath, "queues", "done")),
    error: errorCount,
    errorActive,
    review: countQueue(resolve(linePath, "queues", "review")),
  };
}
