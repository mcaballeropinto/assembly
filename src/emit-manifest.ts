/**
 * Producer-tracked inbox allowlist.
 *
 * Background: a claude-code agent (which had Bash) was observed writing
 * fake fanout JSON files directly into a downstream station's queue/inbox/
 * after its real fetch path failed. The files matched the fanout filename
 * pattern exactly and would have been processed by the orchestrator as
 * legitimate workpieces. The disallowedTools restriction blocks structured
 * tools like Read/Edit but Bash + `echo > path` bypasses it.
 *
 * This module adds a per-queue manifest of filenames the orchestrator (or
 * other authorized writers — CLI, held-release, bootstrap) deliberately
 * placed in the queue. Watchers/drains check membership before processing;
 * unverified files are quarantined to a sibling .unverified/ directory and
 * logged.
 *
 * This is detection, not prevention — a Bash-armed agent could in principle
 * also write to the manifest. The defense raises the bar (two operations
 * with different shapes) and gives forensic visibility (orphan files in
 * .unverified/ are an alarm signal).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync } from "fs";
import { resolve, basename } from "path";

export type EmitSource =
  | "fanout"            // cross-line fanout from on_complete
  | "trigger"           // cross-line single-task on_complete trigger
  | "cli"               // assembly enqueue
  | "release"           // held → inbox release
  | "transition"        // internal section transition (claimFile/moveFile to inbox)
  | "bootstrap"         // pre-existing file at first daemon start with this code
  | "recovery"          // stale recovery picked up
  | "improver";         // improver watcher (dev-line proposals + requeues)

export interface EmitRecord {
  filename: string;
  source: EmitSource;
  ts: string;
}

// In-memory cache: queue dir → Set of trusted filenames.
// Populated lazily via loadManifest() and updated synchronously via
// recordEmit(). Reset on process restart; `isEmitted` falls back to a
// disk re-read on cache miss so a sibling process (e.g. the
// `assembly enqueue` CLI) that appends to the manifest is observable
// to a long-running daemon without a restart.
const cache = new Map<string, Set<string>>();

const MANIFEST_BASENAME = ".emitted.jsonl";
const UNVERIFIED_DIR = ".unverified";

function manifestPath(queueDir: string): string {
  return resolve(queueDir, MANIFEST_BASENAME);
}

// Read the on-disk manifest and merge entries into `set`. Idempotent —
// duplicate entries (already present in the set) are no-ops. Tolerates a
// torn trailing line (partial write from a crashed appender) and an
// unreadable file (treated as empty).
function mergeManifestFromDisk(queueDir: string, set: Set<string>): void {
  const path = manifestPath(queueDir);
  if (!existsSync(path)) return;
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as EmitRecord;
        if (entry.filename) set.add(entry.filename);
      } catch {
        // skip malformed line; the manifest is append-only and partial
        // writes can leave a torn trailing line.
      }
    }
  } catch {
    // Unreadable manifest — caller proceeds with whatever is already in
    // the set. Bootstrap will repopulate from current inbox contents.
  }
}

/**
 * Load (or initialize) the manifest for a queue dir into the in-memory cache.
 * Idempotent: subsequent calls return the cached Set without re-reading.
 *
 * Returns the live Set so callers can mutate it (used by recordEmit's atomic
 * append + Set.add pair to stay in sync).
 */
export function loadManifest(queueDir: string): Set<string> {
  const cached = cache.get(queueDir);
  if (cached) return cached;

  const set = new Set<string>();
  mergeManifestFromDisk(queueDir, set);
  cache.set(queueDir, set);
  return set;
}

/**
 * Record that `filename` has been authorized to enter `queueDir`. Updates
 * both the on-disk manifest (append) and the in-memory cache (insert).
 *
 * Safe to call multiple times for the same filename — the cache uses a Set
 * and the watcher's "is this a known emit?" check is idempotent. Duplicate
 * lines in the manifest file are tolerated by loadManifest.
 */
export function recordEmit(
  queueDir: string,
  filename: string,
  source: EmitSource
): void {
  // Defensive: callers may pass an absolute path; we only want the basename.
  const name = basename(filename);
  const set = loadManifest(queueDir);
  set.add(name);

  mkdirSync(queueDir, { recursive: true });
  const entry: EmitRecord = {
    filename: name,
    source,
    ts: new Date().toISOString(),
  };
  try {
    appendFileSync(manifestPath(queueDir), JSON.stringify(entry) + "\n");
  } catch {
    // Disk write failure should not block the emit — the in-memory cache
    // is the authoritative source within this daemon process. The next
    // restart's bootstrap will reconcile.
  }
}

/**
 * Check if `filename` is on the manifest for `queueDir`. Use this in the
 * inbox watchers / drainInbox before processing a file.
 *
 * On cache miss we re-read the manifest from disk before returning false.
 * This catches entries appended by a sibling process (notably the
 * `assembly enqueue` CLI) after this process warmed its cache. Without
 * the fallback, a long-running daemon would silently quarantine valid
 * CLI enqueues until the next restart.
 *
 * Bounded cost: the disk re-read only fires on what would otherwise be
 * a quarantine. In steady state that's rare; a busy line still pays
 * O(1) cache hits for legitimate fanout/transition emits.
 */
export function isEmitted(queueDir: string, filename: string): boolean {
  const name = basename(filename);
  const set = loadManifest(queueDir);
  if (set.has(name)) return true;
  mergeManifestFromDisk(queueDir, set);
  return set.has(name);
}

/**
 * Move an unverified inbox file to `<queueDir>/.unverified/` with a
 * timestamped name so concurrent unverified writes don't collide.
 *
 * Returns the destination path so callers can include it in log output.
 * Returns null if the source file vanished (race with the rogue writer
 * cleaning up after itself).
 */
export function quarantineUnverified(
  queueDir: string,
  filePath: string
): string | null {
  if (!existsSync(filePath)) return null;
  const dir = resolve(queueDir, UNVERIFIED_DIR);
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const dest = resolve(dir, `${ts}-${basename(filePath)}`);
  try {
    renameSync(filePath, dest);
    // Sweep the session-log sidecar too if one exists alongside.
    const sessionSrc = `${filePath}.session.jsonl`;
    if (existsSync(sessionSrc)) {
      try {
        renameSync(sessionSrc, `${dest}.session.jsonl`);
      } catch {}
    }
    return dest;
  } catch {
    return null;
  }
}

/**
 * Bootstrap: when the daemon starts, scan the queue dir for any pre-existing
 * `.json` workpiece files that AREN'T on the manifest. If the manifest is
 * empty (= first run with this code on a populated queue), auto-record them
 * as `bootstrap` so the migration is non-disruptive. Returns the count of
 * files added.
 *
 * Always run for inbox dirs at orchestrator startup. Idempotent: a second
 * call adds nothing new.
 */
export function bootstrapManifest(queueDir: string): number {
  if (!existsSync(queueDir)) return 0;
  const set = loadManifest(queueDir);
  let added = 0;
  let entries: string[] = [];
  try {
    const { readdirSync } = require("fs");
    entries = readdirSync(queueDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".retry.json")) continue;
    if (name.includes(".tmp.")) continue;
    if (set.has(name)) continue;
    recordEmit(queueDir, name, "bootstrap");
    added++;
  }
  return added;
}

/**
 * Reset the in-memory cache. Tests use this to simulate a fresh daemon
 * start; not exported for production callers.
 */
export function _resetCacheForTests(): void {
  cache.clear();
}

/**
 * Sidecar filenames produced by this module. Callers that scan queue dirs
 * (e.g. listQueue) should skip these.
 */
export function isManifestSidecar(filename: string): boolean {
  return filename === MANIFEST_BASENAME || filename === UNVERIFIED_DIR;
}
