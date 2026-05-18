import { resolve } from "path";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  statSync,
} from "fs";

export type DismissedMap = Record<string, { dismissed_at: string; auto?: boolean }>;

const DISMISSED_FILE = ".dismissed";

/**
 * Read the dismissed-error sidecar for a line.
 * Returns {} if the file is missing, malformed, or not an object.
 */
export function readDismissed(linePath: string): DismissedMap {
  const filePath = resolve(linePath, "queues", "error", DISMISSED_FILE);
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    return parsed as DismissedMap;
  } catch {
    return {};
  }
}

/**
 * Atomically write the dismissed map via temp-file-then-rename.
 */
function writeDismissed(linePath: string, map: DismissedMap): void {
  const dir = resolve(linePath, "queues", "error");
  const filePath = resolve(dir, DISMISSED_FILE);
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(map, null, 2));
  renameSync(tmpPath, filePath);
}

/**
 * Remove entries whose .json file no longer exists on disk in queues/error/.
 */
function pruneStale(linePath: string, map: DismissedMap): DismissedMap {
  const errorDir = resolve(linePath, "queues", "error");
  let onDisk: Set<string>;
  try {
    onDisk = new Set(readdirSync(errorDir).filter((f) => f.endsWith(".json")));
  } catch {
    onDisk = new Set();
  }
  const pruned: DismissedMap = {};
  for (const [fileName, meta] of Object.entries(map)) {
    if (onDisk.has(fileName)) {
      pruned[fileName] = meta;
    }
  }
  return pruned;
}

/**
 * Dismiss the given error filenames for a line.
 * Merges into the existing map, prunes stale entries, writes atomically.
 * Returns the updated map.
 */
export function dismissFilenames(
  linePath: string,
  fileNames: string[]
): DismissedMap {
  let map = readDismissed(linePath);
  const now = new Date().toISOString();
  for (const fn of fileNames) {
    map[fn] = { dismissed_at: now };
  }
  map = pruneStale(linePath, map);
  writeDismissed(linePath, map);
  return map;
}

/**
 * Undismiss the given error filenames for a line.
 * Removes them from the dismissed map, prunes stale entries, writes atomically.
 * Returns the updated map.
 */
export function undismissFilenames(
  linePath: string,
  fileNames: string[]
): DismissedMap {
  let map = readDismissed(linePath);
  for (const fn of fileNames) {
    delete map[fn];
  }
  map = pruneStale(linePath, map);
  writeDismissed(linePath, map);
  return map;
}

/**
 * Auto-archive error files older than maxAgeMs.
 * Reads each .json in queues/error/, checks finished_at (or file mtime fallback),
 * and dismisses old ones with auto: true marker.
 */
export function autoArchiveOld(
  linePath: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): { archived: number } {
  const errorDir = resolve(linePath, "queues", "error");
  if (!existsSync(errorDir)) return { archived: 0 };

  let map = readDismissed(linePath);
  const now = Date.now();
  const nowIso = new Date().toISOString();
  let archived = 0;

  try {
    const files = readdirSync(errorDir).filter((f) => f.endsWith(".json"));
    for (const fileName of files) {
      if (map[fileName]) continue; // already dismissed
      const filePath = resolve(errorDir, fileName);
      let finishedAtMs: number | null = null;

      try {
        const wp = JSON.parse(readFileSync(filePath, "utf-8"));
        if (wp.stations && typeof wp.stations === "object") {
          const finishedAts = Object.values(wp.stations)
            .map((s: any) => s.finished_at)
            .filter(Boolean)
            .sort() as string[];
          if (finishedAts.length > 0) {
            finishedAtMs = new Date(finishedAts[finishedAts.length - 1]).getTime();
          }
        }
      } catch {}

      // Fallback to file mtime
      if (finishedAtMs == null) {
        try {
          finishedAtMs = statSync(filePath).mtimeMs;
        } catch {
          continue;
        }
      }

      if (now - finishedAtMs > maxAgeMs) {
        map[fileName] = { dismissed_at: nowIso, auto: true };
        archived++;
      }
    }
  } catch {
    return { archived: 0 };
  }

  if (archived > 0) {
    map = pruneStale(linePath, map);
    writeDismissed(linePath, map);
  }

  return { archived };
}
