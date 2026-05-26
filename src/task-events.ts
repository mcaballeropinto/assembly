import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import type { WorkpieceId, StationName } from "./ids";

// ─── Types ─────────────────────────────────────────────────────────

export type TaskEventKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "heartbeat"
  | "lifecycle";

export interface TaskEvent {
  ts: string;
  station: string;
  kind: TaskEventKind;
  summary: string;
  detail?: unknown;
  seq: number;
}

export interface StationMeta {
  name: string;
  status: "running" | "ok" | "error" | "aborted" | "timeout" | "escalated";
  started_at: string;
  finished_at?: string;
  event_count: number;
  last_ts: string;
}

export interface TaskEventsPage {
  events: TaskEvent[];
  next_cursor: number;
  total: number;
  has_more: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────

const DETAIL_MAX_BYTES = 8 * 1024;
const SUMMARY_MAX_CHARS = 300;

// ─── Per-process sequence counters (one writer per file guaranteed) ──

const seqCounters = new Map<string, number>();

// ─── Path helpers ───────────────────────────────────────────────────

function eventsDir(linePath: string, wpId: WorkpieceId): string {
  return resolve(linePath, "queues", "task-events", wpId);
}

function eventsFile(linePath: string, wpId: WorkpieceId, stationName: StationName): string {
  return resolve(eventsDir(linePath, wpId), `${stationName}.events.jsonl`);
}

function indexFile(linePath: string, wpId: WorkpieceId): string {
  return resolve(eventsDir(linePath, wpId), "index.json");
}

// ─── Helpers ────────────────────────────────────────────────────────

function nextSeq(linePath: string, wpId: WorkpieceId, stationName: StationName): number {
  const key = `${linePath}|${wpId}|${stationName}`;
  const n = (seqCounters.get(key) ?? 0) + 1;
  seqCounters.set(key, n);
  return n;
}

function capDetail(detail: unknown): unknown {
  if (detail === undefined || detail === null) return detail;
  const json = JSON.stringify(detail);
  if (json.length <= DETAIL_MAX_BYTES) return detail;
  return { truncated: true, original_bytes: json.length };
}

function capSummary(s: string): string {
  return s.length <= SUMMARY_MAX_CHARS ? s : s.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

// ─── Public API ─────────────────────────────────────────────────────

/** Create the task-events directory for a workpiece. Best-effort; never throws. */
export function initTaskEventDir(linePath: string, wpId: WorkpieceId): void {
  try {
    mkdirSync(eventsDir(linePath, wpId), { recursive: true });
  } catch {
    // best-effort
  }
}

/** Append a single event to the station's .events.jsonl file. Best-effort; never throws. */
export function appendTaskEvent(
  linePath: string,
  wpId: WorkpieceId,
  stationName: StationName,
  partial: Omit<TaskEvent, "ts" | "seq" | "station">
): void {
  try {
    const seq = nextSeq(linePath, wpId, stationName);
    const event: TaskEvent = {
      ts: new Date().toISOString(),
      station: stationName,
      seq,
      kind: partial.kind,
      summary: capSummary(partial.summary),
      ...(partial.detail !== undefined
        ? { detail: capDetail(partial.detail) }
        : {}),
    };
    appendFileSync(eventsFile(linePath, wpId, stationName), JSON.stringify(event) + "\n");
  } catch {
    // best-effort — never throw
  }
}

/**
 * Rewrite index.json with current station metadata.
 * Called on station start (status=running) and on every exit path.
 * Best-effort; never throws.
 */
export function updateTaskEventIndex(
  linePath: string,
  wpId: WorkpieceId,
  stationName: StationName,
  status: StationMeta["status"],
  startedAt: string,
  finishedAt?: string
): void {
  try {
    const idxPath = indexFile(linePath, wpId);

    // Read existing index (may have entries for other stations)
    let stations: StationMeta[] = [];
    if (existsSync(idxPath)) {
      try {
        const raw = JSON.parse(readFileSync(idxPath, "utf-8"));
        stations = raw.stations ?? [];
      } catch {}
    }

    // Count events and find last timestamp
    let eventCount = 0;
    let lastTs = startedAt;
    const ef = eventsFile(linePath, wpId, stationName);
    if (existsSync(ef)) {
      try {
        const lines = readFileSync(ef, "utf-8").trim().split("\n").filter(Boolean);
        eventCount = lines.length;
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]);
          if (last.ts) lastTs = last.ts;
        }
      } catch {}
    }

    const entry: StationMeta = {
      name: stationName,
      status,
      started_at: startedAt,
      ...(finishedAt ? { finished_at: finishedAt } : {}),
      event_count: eventCount,
      last_ts: lastTs,
    };

    const idx = stations.findIndex((s) => s.name === stationName);
    if (idx >= 0) {
      stations[idx] = entry;
    } else {
      stations.push(entry);
    }

    // Atomic write via tmp file
    const tmp = idxPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ stations, updated_at: new Date().toISOString() }, null, 2));
    renameSync(tmp, idxPath);
  } catch {
    // best-effort
  }
}

/** Read events from a station file, with optional cursor-based pagination. */
export function readTaskEvents(
  linePath: string,
  wpId: WorkpieceId,
  stationName: StationName,
  opts: { after?: number; before?: number; limit?: number } = {}
): TaskEventsPage {
  const limit = opts.limit ?? 100;
  const ef = eventsFile(linePath, wpId, stationName);

  if (!existsSync(ef)) {
    return { events: [], next_cursor: 0, total: 0, has_more: false };
  }

  try {
    const lines = readFileSync(ef, "utf-8").trim().split("\n").filter(Boolean);
    const total = lines.length;

    const parsed: TaskEvent[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {}
    }

    let filtered = parsed;
    if (opts.after !== undefined) {
      filtered = filtered.filter((e) => e.seq > opts.after!);
    }
    if (opts.before !== undefined) {
      filtered = filtered.filter((e) => e.seq < opts.before!);
    }

    const has_more = filtered.length > limit;
    // For backward pagination (before=), take the last <limit> of matching events
    const page =
      opts.before !== undefined
        ? filtered.slice(Math.max(0, filtered.length - limit))
        : filtered.slice(0, limit);

    const next_cursor =
      page.length > 0 ? page[page.length - 1].seq : (opts.after ?? 0);

    return { events: page, next_cursor, total, has_more };
  } catch {
    return { events: [], next_cursor: 0, total: 0, has_more: false };
  }
}

/** Read per-station metadata from index.json. Returns [] if file missing or corrupt. */
export function listTaskEventStations(
  linePath: string,
  wpId: WorkpieceId
): StationMeta[] {
  try {
    const idxPath = indexFile(linePath, wpId);
    if (!existsSync(idxPath)) return [];
    const data = JSON.parse(readFileSync(idxPath, "utf-8"));
    return data.stations ?? [];
  } catch {
    return [];
  }
}
