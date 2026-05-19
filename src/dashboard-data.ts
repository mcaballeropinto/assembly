import { resolve, basename } from "path";
import { readdirSync, existsSync, readFileSync } from "fs";
import { loadLine } from "./line";
import {
  listQueue,
  getLineQueueState,
  getSectionQueueState,
} from "./queue";
import type { Workpiece, RetryState } from "./types";
import { listTaskEventStations, readTaskEvents } from "./task-events";
export type { StationMeta, TaskEventsPage, TaskEvent } from "./task-events";
import { readDismissed } from "./error-dismiss";
import { readRetryState } from "./retry-state";
import { listHeld } from "./held";

// ─── Health State ──────────────────────────────────────────────────

export interface HealthState {
  state: "idle" | "processing" | "queued" | "errors";
  count: number;
  detail: string;
}

export function computeHealth(
  sections: Record<string, { inbox: number; processing: number; output: number }>,
  errors: unknown[],
  lineQueueInbox: number
): HealthState {
  // Priority 1: Errors
  const errorCount = errors.length;
  if (errorCount > 0) {
    const err = errors[0] as { task?: string; failed?: { station: string }[] };
    const failedStation = err.failed && err.failed.length > 0 ? err.failed[0].station : "unknown";
    const taskExcerpt = (err.task || "unknown").slice(0, 60);
    const plural = errorCount !== 1 ? "s" : "";
    return {
      state: "errors",
      count: errorCount,
      detail: `${errorCount} error${plural} — last: ${failedStation} failed for ${taskExcerpt}`,
    };
  }

  // Priority 2: Processing
  let processingCount = 0;
  const activeStations: string[] = [];
  for (const [name, sec] of Object.entries(sections)) {
    if (sec.processing > 0) {
      processingCount += sec.processing;
      activeStations.push(name);
    }
  }
  if (processingCount > 0) {
    let detail = `Processing ${processingCount}`;
    if (activeStations.length <= 2) {
      detail += ` — ${activeStations.join(", ")}`;
    }
    return { state: "processing", count: processingCount, detail };
  }

  // Priority 3: Queued
  let queuedCount = lineQueueInbox;
  for (const sec of Object.values(sections)) {
    queuedCount += sec.inbox;
  }
  if (queuedCount > 0) {
    return { state: "queued", count: queuedCount, detail: `Queued ${queuedCount}` };
  }

  // Priority 4: Idle
  return { state: "idle", count: 0, detail: "Idle" };
}

// ─── Historical Run Comparison (Tier 4 #17) ───────────────────────

export interface HistoryStationCell {
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  status: "done" | "failed" | "skipped" | "escalated" | null;
}

export interface HistoryRun {
  id: string;
  fileName: string;
  task: string;
  source: "done" | "error";
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  stations: Record<string, HistoryStationCell>;
}

export interface HistoryStationStats {
  count: number;
  avg_duration_ms: number | null;
  min_duration_ms: number | null;
  max_duration_ms: number | null;
}

export interface LineHistory {
  line: string;
  limit: number;
  include: ("done" | "error")[];
  sequence: string[];
  runs: HistoryRun[];
  perStationStats: Record<string, HistoryStationStats>;
  timestamp: string;
}

export interface GetHistoryOptions {
  limit?: number;
  include?: ("done" | "error")[];
}

export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 50;

// ─── Banner Error Age & Severity ─────────────────────────────────

export const BANNER_ERROR_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
const CRITICAL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export function computeErrorSeverity(
  finishedAt: string | null
): "critical" | "warning" | "suppressed" {
  if (!finishedAt) return "warning";
  const ageMs = Date.now() - new Date(finishedAt).getTime();
  if (ageMs <= CRITICAL_THRESHOLD_MS) return "critical";
  if (ageMs <= BANNER_ERROR_MAX_AGE_MS) return "warning";
  return "suppressed";
}

// ─── Connection Health (dashboard freshness) ─────────────────────────

export const CONNECTION_LIVE_THRESHOLD_MS = 5000;
export const CONNECTION_STALE_THRESHOLD_MS = 30000;

export type ConnectionState = "live" | "stale" | "disconnected";

/**
 * Classify dashboard freshness by age of the last successful client-observed
 * data fetch. Age below 5s = live, 5–30s = stale, >30s = disconnected.
 * Negative ageMs (clock skew, never-fetched sentinel of -1) is treated as
 * disconnected to avoid a false-green indicator.
 */
export function connectionHealth(ageMs: number): ConnectionState {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "disconnected";
  if (ageMs < CONNECTION_LIVE_THRESHOLD_MS) return "live";
  if (ageMs <= CONNECTION_STALE_THRESHOLD_MS) return "stale";
  return "disconnected";
}

// ─── Throughput (rolling completion rate) ─────────────────────────

export interface ThroughputCounts {
  last_1h: number;
  last_24h: number;
}

/**
 * Count workpiece completions in the rolling 1h and 24h windows ending at `now`,
 * using the mtime of each *.json file in `doneDir` as the completion timestamp.
 * The raw window counts are the displayed rates (items/hr and items/day).
 */
export function computeThroughput(
  doneDir: string,
  now: number = Date.now()
): ThroughputCounts {
  if (!existsSync(doneDir)) return { last_1h: 0, last_24h: 0 };
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  let last_1h = 0;
  let last_24h = 0;
  try {
    const entries = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
    for (const name of entries) {
      const mtime = Bun.file(resolve(doneDir, name)).lastModified ?? 0;
      if (mtime >= oneDayAgo && mtime <= now) last_24h++;
      if (mtime >= oneHourAgo && mtime <= now) last_1h++;
    }
  } catch {}
  return { last_1h, last_24h };
}

/**
 * Get full state for the dashboard API.
 */
export async function getFullState(linePath: string) {
  let config;
  try {
    const loaded = await loadLine(linePath);
    config = loaded.config;
  } catch {
    return { error: "Failed to load line" };
  }

  // Line-level queues
  const lineState = getLineQueueState(linePath);

  // Held tasks list
  const held = listHeld(linePath);

  // Section states
  const sections: Record<
    string,
    {
      inbox: number;
      processing: number;
      output: number;
      done_total: number;
    }
  > = {};

  const sequence: string[] = [];
  for (const step of config.sequence) {
    if (typeof step === "string") sequence.push(step);
    else if ("parallel" in step) sequence.push(...step.parallel);
    else if ("station" in step) sequence.push((step as { station: { name: string } }).station.name);
  }

  for (const name of sequence) {
    const stationDir = resolve(linePath, "stations", name);
    const queueState = getSectionQueueState(stationDir);
    sections[name] = {
      ...queueState,
      done_total: 0, // could track this if needed
    };
  }

  // Activity log (last 50 entries)
  const logPath = resolve(linePath, "queues", "activity.jsonl");
  let activity: unknown[] = [];
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
      activity = lines
        .slice(-50)
        .reverse()
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {}
  }

  // Session cost/token totals (accumulated across done, error, review workpieces)
  let sessionTokensIn = 0;
  let sessionTokensOut = 0;
  let sessionCacheRead = 0;
  let sessionCacheCreation = 0;
  let sessionCostUsd = 0;
  let sessionWorkpieces = 0;
  const sessionByStation: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number; count: number; cache_read: number; cache_creation: number }> = {};

  function accumulateWorkpieceCost(wp: Workpiece) {
    sessionCostUsd += wp.totals?.cost_usd ?? 0;
    sessionTokensIn += wp.totals?.tokens?.in ?? 0;
    sessionTokensOut += wp.totals?.tokens?.out ?? 0;
    sessionCacheRead += wp.totals?.tokens?.cache_read ?? 0;
    sessionCacheCreation += wp.totals?.tokens?.cache_creation ?? 0;
    sessionWorkpieces++;
    if (wp.stations) {
      for (const [stationName, sr] of Object.entries(wp.stations)) {
        if (!sessionByStation[stationName]) {
          sessionByStation[stationName] = { tokens_in: 0, tokens_out: 0, cost_usd: 0, count: 0, cache_read: 0, cache_creation: 0 };
        }
        sessionByStation[stationName].tokens_in += sr.tokens?.in ?? 0;
        sessionByStation[stationName].tokens_out += sr.tokens?.out ?? 0;
        sessionByStation[stationName].cost_usd += sr.cost_usd ?? 0;
        sessionByStation[stationName].cache_read += sr.tokens?.cache_read ?? 0;
        sessionByStation[stationName].cache_creation += sr.tokens?.cache_creation ?? 0;
        sessionByStation[stationName].count++;
      }
    }
  }

  // Recent completed workpieces (last 10 from done/)
  const doneDir = resolve(linePath, "queues", "done");
  const throughput = computeThroughput(doneDir);
  const completed: unknown[] = [];
  if (existsSync(doneDir)) {
    const files = listQueue(doneDir).slice(-10).reverse();
    for (const f of files) {
      try {
        const wp = JSON.parse(readFileSync(f, "utf-8")) as Workpiece;
        accumulateWorkpieceCost(wp);
        const stationVals = Object.values(wp.stations);
        const allStarted = stationVals.map(s => s.started_at).filter(Boolean).sort();
        const allFinished = stationVals.map(s => s.finished_at).filter(Boolean).sort();
        const wpFinishedAt = allFinished.length > 0 ? allFinished[allFinished.length - 1] : null;
        const wpStartedAt = allStarted.length > 0 ? allStarted[0] : null;
        const wpDurationMs = (wpFinishedAt && wpStartedAt) ? new Date(wpFinishedAt).getTime() - new Date(wpStartedAt).getTime() : null;
        completed.push({
          id: wp.id,
          fileName: basename(f),
          task: wp.task.slice(0, 100),
          finished_at: wpFinishedAt,
          duration_ms: wpDurationMs,
          stations: Object.fromEntries(
            Object.entries(wp.stations).map(([k, v]) => [
              k,
              { status: v.status, summary: v.summary },
            ])
          ),
        });
      } catch {}
    }
  }

  // Recent errors (last 10) — split into active vs. dismissed
  const errorDir = resolve(linePath, "queues", "error");
  const activeErrors: unknown[] = [];
  const dismissedErrors: unknown[] = [];
  if (existsSync(errorDir)) {
    const dismissedMap = readDismissed(linePath);
    const files = listQueue(errorDir).slice(-20).reverse(); // load extra to have enough after splitting
    for (const f of files) {
      try {
        const wp = JSON.parse(readFileSync(f, "utf-8")) as Workpiece;
        accumulateWorkpieceCost(wp);
        const failedStations = Object.entries(wp.stations)
          .filter(([, v]) => v.status === "failed")
          .map(([k, v]) => ({ station: k, error: v.summary }));
        const errStationVals = Object.values(wp.stations);
        const errAllStarted = errStationVals.map(s => s.started_at).filter(Boolean).sort();
        const errAllFinished = errStationVals.map(s => s.finished_at).filter(Boolean).sort();
        const errFinishedAt = errAllFinished.length > 0 ? errAllFinished[errAllFinished.length - 1] : null;
        const errStartedAt = errAllStarted.length > 0 ? errAllStarted[0] : null;
        const errDurationMs = (errFinishedAt && errStartedAt) ? new Date(errFinishedAt).getTime() - new Date(errStartedAt).getTime() : null;
        const fName = basename(f);
        const errItem = {
          id: wp.id,
          fileName: fName,
          task: wp.task.slice(0, 100),
          failed: failedStations,
          finished_at: errFinishedAt,
          duration_ms: errDurationMs,
        };
        if (dismissedMap[fName]) {
          dismissedErrors.push({
            ...errItem,
            dismissed_at: dismissedMap[fName].dismissed_at,
          });
        } else {
          activeErrors.push(errItem);
        }
      } catch {}
    }
  }

  // Banner errors: age-filtered + severity-tagged subset of activeErrors
  const bannerErrors = (activeErrors as any[]).map((e) => {
    const severity = computeErrorSeverity(e.finished_at);
    return { ...e, severity };
  }).filter((e) => e.severity !== "suppressed");

  const bannerAges = bannerErrors
    .map((e) => e.finished_at ? Date.now() - new Date(e.finished_at).getTime() : null)
    .filter((a): a is number => a !== null);
  const errorsMeta = {
    total_active: (activeErrors as any[]).length,
    in_banner: bannerErrors.length,
    oldest_in_banner_age_ms: bannerAges.length > 0 ? Math.max(...bannerAges) : 0,
    max_banner_age_ms: BANNER_ERROR_MAX_AGE_MS,
  };

  // Recent review items (last 10)
  const reviewDir = resolve(linePath, "queues", "review");
  const reviews: unknown[] = [];
  if (existsSync(reviewDir)) {
    const files = listQueue(reviewDir).slice(-10).reverse();
    for (const f of files) {
      try {
        const wp = JSON.parse(readFileSync(f, "utf-8")) as Workpiece;
        accumulateWorkpieceCost(wp);
        const escalatedStations = Object.entries(wp.stations)
          .filter(([, v]) => v.status === "escalated")
          .map(([k, v]) => ({
            station: k,
            feedback: v.eval?.feedback ?? v.summary,
            score: v.eval?.score,
          }));
        reviews.push({
          id: wp.id,
          task: wp.task.slice(0, 100),
          escalated: escalatedStations,
          fileName: basename(f),
        });
      } catch {}
    }
  }

  // Recent triggers (from activity log)
  const triggers = (activity as any[]).filter(
    (a: any) => a?.event === "trigger_fired" || a?.event === "trigger_skipped"
  ).slice(0, 20);

  // Station timings — find the most recent/active workpiece per station
  const stationTimings = getStationTimings(linePath, sequence);

  // Total pipeline time
  let pipelineTotalMs: number | null = null;
  const allTimings = Object.values(stationTimings);
  if (allTimings.length > 0) {
    const starts = allTimings.map(t => t.started_at).filter(Boolean).sort();
    const ends = allTimings
      .filter(t => "finished_at" in t && t.finished_at)
      .map(t => (t as { finished_at: string }).finished_at)
      .sort();
    if (starts.length > 0 && ends.length > 0 && !allTimings.some(t => "running" in t && t.running)) {
      const pipelineStarted = starts[0];
      const pipelineFinished = ends[ends.length - 1];
      pipelineTotalMs = new Date(pipelineFinished).getTime() - new Date(pipelineStarted).getTime();
    }
  }

  const health = computeHealth(sections, activeErrors, lineState.inbox);

  return {
    line: config.name,
    description: config.description,
    sequence,
    lineQueue: lineState,
    held,
    sections,
    stationTimings,
    pipelineTotalMs,
    activity,
    completed,
    errors: activeErrors.slice(0, 10),
    banner_errors: bannerErrors.slice(0, 10),
    errors_meta: errorsMeta,
    errorsDismissed: dismissedErrors.slice(0, 10),
    reviews,
    triggers,
    health,
    sessionTotals: {
      tokens_in: sessionTokensIn,
      tokens_out: sessionTokensOut,
      cache_read_tokens: sessionCacheRead,
      cache_creation_tokens: sessionCacheCreation,
      cost_usd: Math.round(sessionCostUsd * 1_000_000) / 1_000_000,
      workpieces: sessionWorkpieces,
      byStation: sessionByStation,
    },
    throughput,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get timing data for each station from the most relevant workpiece.
 * Priority: processing/ (running) > output/ (just completed) > done/ (recent completed)
 */
function getStationTimings(
  linePath: string,
  sequence: string[]
): Record<string, { started_at: string; finished_at?: string; duration_ms?: number; running?: boolean; latestProgress?: { detail?: string; tool?: string; elapsed_s?: number; turns?: number } }> {
  const timings: Record<string, { started_at: string; finished_at?: string; duration_ms?: number; running?: boolean; latestProgress?: { detail?: string; tool?: string; elapsed_s?: number; turns?: number } }> = {};

  for (const name of sequence) {
    const stationDir = resolve(linePath, "stations", name);

    // Priority 1: Check processing/ queue for active workpiece
    const processingDir = resolve(stationDir, "queue", "processing");
    const processingFiles = listQueue(processingDir);
    if (processingFiles.length > 0) {
      try {
        const latestProcessingFile = processingFiles[processingFiles.length - 1];
        const wp = JSON.parse(readFileSync(latestProcessingFile, "utf-8")) as Workpiece;
        const sr = wp.stations[name];
        if (sr?.started_at) {
          const timing: typeof timings[string] = { started_at: sr.started_at, running: true };
          // Check for progress file
          try {
            const progressFile = latestProcessingFile + ".progress.jsonl";
            if (existsSync(progressFile)) {
              const progressContent = readFileSync(progressFile, "utf-8").trim();
              const progressLines = progressContent.split("\n").filter(Boolean);
              if (progressLines.length > 0) {
                const lastEvent = JSON.parse(progressLines[progressLines.length - 1]);
                timing.latestProgress = {
                  detail: lastEvent.detail,
                  tool: lastEvent.tool,
                  elapsed_s: lastEvent.elapsed_s,
                  turns: lastEvent.turns,
                };
              }
            }
          } catch {}
          timings[name] = timing;
          continue;
        }
      } catch {}
    }

    // Priority 2: Check output/ queue (just completed, not yet routed)
    const outputDir = resolve(stationDir, "queue", "output");
    const outputFiles = listQueue(outputDir);
    if (outputFiles.length > 0) {
      try {
        const wp = JSON.parse(readFileSync(outputFiles[outputFiles.length - 1], "utf-8")) as Workpiece;
        const sr = wp.stations[name];
        if (sr?.started_at && sr?.finished_at) {
          const durationMs = new Date(sr.finished_at).getTime() - new Date(sr.started_at).getTime();
          timings[name] = { started_at: sr.started_at, finished_at: sr.finished_at, duration_ms: durationMs };
          continue;
        }
      } catch {}
    }

    // Priority 3: Check recent completed workpieces from done/
    const doneDir = resolve(linePath, "queues", "done");
    if (existsSync(doneDir)) {
      const doneFiles = listQueue(doneDir).slice(-5).reverse();
      for (const f of doneFiles) {
        try {
          const wp = JSON.parse(readFileSync(f, "utf-8")) as Workpiece;
          const sr = wp.stations[name];
          if (sr?.started_at && sr?.finished_at) {
            const durationMs = new Date(sr.finished_at).getTime() - new Date(sr.started_at).getTime();
            timings[name] = { started_at: sr.started_at, finished_at: sr.finished_at, duration_ms: durationMs };
            break;
          }
        } catch {}
      }
    }
  }

  return timings;
}

/**
 * Get activity log entries related to a specific workpiece.
 */
export function getWorkpieceActivity(
  linePath: string,
  workpieceId: string
): unknown[] {
  const logPath = resolve(linePath, "queues", "activity.jsonl");
  if (!existsSync(logPath)) return [];

  try {
    const lines = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    return lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(
        (entry) =>
          entry &&
          (entry.workpiece === workpieceId ||
            (entry.workpiece &&
              String(entry.workpiece).includes(workpieceId)))
      )
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Get per-station timing history across the last N completed workpieces.
 */
export async function getHistory(
  linePath: string,
  opts: GetHistoryOptions = {}
): Promise<LineHistory | { error: string }> {
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, opts.limit ?? HISTORY_DEFAULT_LIMIT));
  const include: ("done" | "error")[] =
    opts.include && opts.include.length > 0 ? opts.include : ["done"];

  let config;
  try {
    const loaded = await loadLine(linePath);
    config = loaded.config;
  } catch {
    return { error: "Failed to load line" };
  }

  // Flatten sequence (same logic as getFullState)
  const sequence: string[] = [];
  for (const step of config.sequence) {
    if (typeof step === "string") sequence.push(step);
    else if ("parallel" in step) sequence.push(...step.parallel);
    else if ("station" in step) sequence.push((step as { station: { name: string } }).station.name);
  }

  // Gather candidate files from each included queue
  const candidates: { path: string; mtime: number; source: "done" | "error" }[] = [];
  if (include.includes("done")) {
    const doneDir = resolve(linePath, "queues", "done");
    if (existsSync(doneDir)) {
      for (const f of listQueue(doneDir)) {
        candidates.push({ path: f, mtime: Bun.file(f).lastModified ?? 0, source: "done" });
      }
    }
  }
  if (include.includes("error")) {
    const errorDir = resolve(linePath, "queues", "error");
    if (existsSync(errorDir)) {
      for (const f of listQueue(errorDir)) {
        candidates.push({ path: f, mtime: Bun.file(f).lastModified ?? 0, source: "error" });
      }
    }
  }
  // Sort newest first, then take the top `limit`
  candidates.sort((a, b) => b.mtime - a.mtime);
  const selected = candidates.slice(0, limit);

  const runs: HistoryRun[] = [];
  for (const c of selected) {
    try {
      const wp = JSON.parse(readFileSync(c.path, "utf-8")) as Workpiece;
      const stationsOut: Record<string, HistoryStationCell> = {};
      for (const name of sequence) {
        const sr = wp.stations?.[name];
        if (!sr) {
          stationsOut[name] = { started_at: null, finished_at: null, duration_ms: null, status: null };
          continue;
        }
        const started = sr.started_at || null;
        const finished = sr.finished_at || null;
        const duration =
          started && finished
            ? new Date(finished).getTime() - new Date(started).getTime()
            : null;
        stationsOut[name] = {
          started_at: started,
          finished_at: finished,
          duration_ms: duration,
          status: (sr.status as HistoryStationCell["status"]) ?? null,
        };
      }
      const allStarts = Object.values(wp.stations ?? {})
        .map((s) => s.started_at)
        .filter(Boolean)
        .sort();
      const allEnds = Object.values(wp.stations ?? {})
        .map((s) => s.finished_at)
        .filter(Boolean)
        .sort();
      const runStarted = allStarts.length > 0 ? allStarts[0] : null;
      const runFinished = allEnds.length > 0 ? allEnds[allEnds.length - 1] : null;
      const runDuration =
        runStarted && runFinished
          ? new Date(runFinished).getTime() - new Date(runStarted).getTime()
          : null;
      runs.push({
        id: wp.id,
        fileName: basename(c.path),
        task: (wp.task ?? "").slice(0, 100),
        source: c.source,
        started_at: runStarted,
        finished_at: runFinished,
        duration_ms: runDuration,
        stations: stationsOut,
      });
    } catch {
      // skip unparseable workpieces
    }
  }

  // Per-station stats (only cells with non-null duration_ms count)
  const perStationStats: Record<string, HistoryStationStats> = {};
  for (const name of sequence) {
    const durations: number[] = [];
    for (const r of runs) {
      const cell = r.stations[name];
      if (cell && cell.duration_ms != null) durations.push(cell.duration_ms);
    }
    if (durations.length === 0) {
      perStationStats[name] = {
        count: 0,
        avg_duration_ms: null,
        min_duration_ms: null,
        max_duration_ms: null,
      };
    } else {
      const sum = durations.reduce((a, b) => a + b, 0);
      perStationStats[name] = {
        count: durations.length,
        avg_duration_ms: Math.round(sum / durations.length),
        min_duration_ms: Math.min(...durations),
        max_duration_ms: Math.max(...durations),
      };
    }
  }

  return {
    line: config.name,
    limit,
    include,
    sequence,
    runs,
    perStationStats,
    timestamp: new Date().toISOString(),
  };
}

// ─── Kanban State ─────────────────────────────────────────────────

/**
 * Parse a task's raw content into a clean title and optional preview.
 * - If the task starts with an H1 (# ...), that becomes the title.
 * - Otherwise, the first non-empty, non-heading line becomes the title.
 * - The first non-heading, non-empty line after the title becomes the preview.
 * - Titles are capped at 80 chars, previews at 120 chars, both with ellipsis on overflow.
 * - No literal # or ## characters appear in the output.
 */
export function parseTaskTitle(raw: string): { title: string; preview?: string } {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return { title: '' };

  let title = '';
  let titleIndex = -1;

  // Look for H1 as the title
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      title = line.replace(/^#+\s*/, '').trim();
      titleIndex = i;
      break;
    }
  }

  // If no H1 found, use the first non-heading line as title
  if (!title) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('#')) {
        title = line;
        titleIndex = i;
        break;
      }
      // If it's a heading, strip the # syntax and use it as fallback
      if (line.match(/^#+\s+/)) {
        title = line.replace(/^#+\s*/, '').trim();
        titleIndex = i;
        break;
      }
    }
  }

  // Cap title at 80 chars
  if (title.length > 80) {
    title = title.slice(0, 80) + '…';
  }

  // Look for preview: first non-heading line after the title
  let preview: string | undefined;
  for (let i = titleIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#')) {
      preview = line;
      break;
    }
  }

  // Cap preview at 120 chars
  if (preview && preview.length > 120) {
    preview = preview.slice(0, 120) + '…';
  }

  return { title, preview };
}

export type KanbanLane = "inbox" | "processing" | "output";

export type KanbanCardState =
  | "held"
  | "waiting"
  | "running"
  | "evaluating"
  | "retrying"
  | "routed"
  | "done"
  | "failed"
  | "escalated";

export interface KanbanCard {
  id: string;
  fileName: string;
  title: string;
  preview?: string;
  state: KanbanCardState;
  column: string;
  station?: string;
  lane?: KanbanLane;
  enteredColumnAt: string | null;
  retries?: number;
  costUsd?: number;
  evalScore?: number;
  retry?: RetryState;
}

export interface KanbanColumn {
  key: string;
  title: string;
  station?: string;
  lane?: KanbanLane;
  count: number;
  wipLimit?: number;
  cards: KanbanCard[];
  retrying_count?: number;
  exhausted_count?: number;
}

export interface KanbanState {
  line: string;
  sequence: string[];
  columns: KanbanColumn[];
  concurrency?: number;
  lastUpdated: string;
}

function readWorkpieceSafe(path: string): Workpiece | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Workpiece;
  } catch {
    return null;
  }
}

function fileMtimeIso(path: string): string | null {
  const mtime = Bun.file(path).lastModified;
  return mtime ? new Date(mtime).toISOString() : null;
}

function sumStationCost(wp: Workpiece): number {
  let total = 0;
  for (const sr of Object.values(wp.stations ?? {})) {
    total += sr.cost_usd ?? 0;
  }
  return total;
}

function loadRetryCounts(linePath: string): Map<string, number> {
  const counts = new Map<string, number>();
  const logPath = resolve(linePath, "queues", "activity.jsonl");
  if (!existsSync(logPath)) return counts;
  try {
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    // Cap scan at last 500 entries for speed
    const scan = lines.slice(-500);
    for (const line of scan) {
      try {
        const entry = JSON.parse(line) as { event?: string; workpiece?: string };
        if (entry.event === "retry" && entry.workpiece) {
          counts.set(entry.workpiece, (counts.get(entry.workpiece) ?? 0) + 1);
        }
      } catch {}
    }
  } catch {}
  return counts;
}

function deriveCardState(
  column: string,
  lane: KanbanLane | undefined,
  stationName: string | undefined,
  wp: Workpiece | null,
  retries: number,
): KanbanCardState {
  if (column === "held") return "held";
  if (column === "inbox") return "waiting";
  if (column === "done") return "done";
  if (column === "error") return "failed";
  if (column === "review") return "escalated";
  if (lane === "inbox") return "waiting";
  if (lane === "output") return "routed";
  if (lane === "processing") {
    if (stationName && wp) {
      const sr = wp.stations?.[stationName];
      if (sr?.eval && !sr.finished_at) return "evaluating";
    }
    if (retries > 0) return "retrying";
    return "running";
  }
  return "waiting";
}

function buildKanbanCard(
  filePath: string,
  columnKey: string,
  station: string | undefined,
  lane: KanbanLane | undefined,
  retriesByWp: Map<string, number>,
): KanbanCard | null {
  const wp = readWorkpieceSafe(filePath);
  const fileName = basename(filePath);
  const id = wp?.id ?? fileName.replace(/\.json$/, "");
  const { title, preview } = parseTaskTitle(wp?.task ?? "");
  const enteredColumnAt = fileMtimeIso(filePath);
  const retries = retriesByWp.get(id) ?? 0;
  const state = deriveCardState(columnKey, lane, station, wp, retries);

  const card: KanbanCard = {
    id,
    fileName,
    title,
    state,
    column: columnKey,
    enteredColumnAt,
  };
  if (preview) card.preview = preview;
  if (station) card.station = station;
  if (lane) card.lane = lane;
  if (retries > 0) card.retries = retries;

  if (wp) {
    const cost = sumStationCost(wp);
    if (cost > 0) card.costUsd = Math.round(cost * 1_000_000) / 1_000_000;
    if (station) {
      const sr = wp.stations?.[station];
      if (sr?.eval?.score != null) card.evalScore = sr.eval.score;
    }
    // Read retry sidecar if present
    const retryState = readRetryState(filePath);
    if (retryState && retryState.retry_count > 0) {
      card.retry = retryState;
    }
  }
  return card;
}

function collectCards(
  dir: string,
  columnKey: string,
  station: string | undefined,
  lane: KanbanLane | undefined,
  retriesByWp: Map<string, number>,
): KanbanCard[] {
  const files = listQueue(dir);
  const cards: KanbanCard[] = [];
  for (const f of files) {
    const card = buildKanbanCard(f, columnKey, station, lane, retriesByWp);
    if (card) cards.push(card);
  }
  return cards;
}

function applyRetryAggregates(col: KanbanColumn): void {
  let retrying = 0;
  let exhausted = 0;
  for (const card of col.cards) {
    if (card.retry) {
      if (card.retry.exhausted) exhausted++;
      else if (card.retry.in_backoff || card.retry.retry_count > 0) retrying++;
    }
  }
  if (retrying > 0) col.retrying_count = retrying;
  if (exhausted > 0) col.exhausted_count = exhausted;
}

/**
 * Build the kanban board state for a line.
 * The filesystem is the state machine — each card is placed based on which folder its file lives in.
 */
export async function getKanbanState(
  linePath: string,
): Promise<KanbanState | { error: string }> {
  let config;
  try {
    const loaded = await loadLine(linePath);
    config = loaded.config;
  } catch {
    return { error: "Failed to load line" };
  }

  const sequence: string[] = [];
  for (const step of config.sequence) {
    if (typeof step === "string") sequence.push(step);
    else if ("parallel" in step) sequence.push(...step.parallel);
    else if ("station" in step) sequence.push((step as { station: { name: string } }).station.name);
    else if ("loop" in step) sequence.push(...(step as { loop: { stations: string[] } }).loop.stations);
    else if ("gate" in step) sequence.push((step as { gate: { if_true: string } }).gate.if_true);
  }

  const retriesByWp = loadRetryCounts(linePath);
  const concurrency = config.concurrency;
  const columns: KanbanColumn[] = [];

  // Held (always visible)
  const heldCards = collectCards(
    resolve(linePath, "queues", "held"),
    "held",
    undefined,
    undefined,
    retriesByWp,
  );
  columns.push({
    key: "held",
    title: "Held",
    count: heldCards.length,
    cards: heldCards,
  });

  // Line-level inbox (always visible)
  const inboxCards = collectCards(
    resolve(linePath, "queues", "inbox"),
    "inbox",
    undefined,
    undefined,
    retriesByWp,
  );
  columns.push({
    key: "inbox",
    title: "Inbox",
    count: inboxCards.length,
    cards: inboxCards,
  });

  // Station column-groups (three lanes each)
  for (const name of sequence) {
    const stationDir = resolve(linePath, "stations", name);
    const inbox = collectCards(
      resolve(stationDir, "queue", "inbox"),
      `${name}:inbox`,
      name,
      "inbox",
      retriesByWp,
    );
    const processing = collectCards(
      resolve(stationDir, "queue", "processing"),
      `${name}:processing`,
      name,
      "processing",
      retriesByWp,
    );
    const output = collectCards(
      resolve(stationDir, "queue", "output"),
      `${name}:output`,
      name,
      "output",
      retriesByWp,
    );
    columns.push({
      key: `${name}:inbox`,
      title: "inbox",
      station: name,
      lane: "inbox",
      count: inbox.length,
      wipLimit: concurrency,
      cards: inbox,
    });
    columns.push({
      key: `${name}:processing`,
      title: "processing",
      station: name,
      lane: "processing",
      count: processing.length,
      wipLimit: concurrency,
      cards: processing,
    });
    columns.push({
      key: `${name}:output`,
      title: "output",
      station: name,
      lane: "output",
      count: output.length,
      wipLimit: concurrency,
      cards: output,
    });
  }

  // Done (always visible)
  const doneCards = collectCards(
    resolve(linePath, "queues", "done"),
    "done",
    undefined,
    undefined,
    retriesByWp,
  );
  // Keep newest first — show last 10; full count still reported in header badge
  doneCards.reverse();
  columns.push({
    key: "done",
    title: "Done",
    count: doneCards.length,
    cards: doneCards.slice(0, 10),
  });

  // Review (only visible if non-empty)
  const reviewCards = collectCards(
    resolve(linePath, "queues", "review"),
    "review",
    undefined,
    undefined,
    retriesByWp,
  );
  if (reviewCards.length > 0) {
    columns.push({
      key: "review",
      title: "Review",
      count: reviewCards.length,
      cards: reviewCards,
    });
  }

  // Error (only visible if non-empty, active only)
  const errorDir = resolve(linePath, "queues", "error");
  const errorCards = collectCards(errorDir, "error", undefined, undefined, retriesByWp);
  const dismissedMap = readDismissed(linePath);
  const activeErrorCards = errorCards.filter((c) => !dismissedMap[c.fileName]);
  if (activeErrorCards.length > 0) {
    columns.push({
      key: "error",
      title: "Error",
      count: activeErrorCards.length,
      cards: activeErrorCards,
    });
  }


  // Compute retry aggregates for each column
  for (const col of columns) applyRetryAggregates(col);
  return {
    line: config.name,
    sequence,
    columns,
    concurrency,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Kanban Diff (card move-list) ───────────────────────────────────

export interface KanbanMove {
  id: string;
  from: string | null;
  to: string | null;
}

/**
 * Compute the list of card moves between two kanban snapshots.
 * Pure over card id + column: added cards get from=null, removed cards get to=null,
 * moved cards get both, unchanged cards are omitted.
 */
export function diffKanban(
  prev: KanbanState | null | undefined,
  next: KanbanState,
): KanbanMove[] {
  const prevMap = new Map<string, string>();
  if (prev) {
    for (const col of prev.columns) {
      for (const c of col.cards) prevMap.set(c.id, c.column);
    }
  }
  const nextMap = new Map<string, string>();
  for (const col of next.columns) {
    for (const c of col.cards) nextMap.set(c.id, c.column);
  }

  const moves: KanbanMove[] = [];
  for (const [id, to] of nextMap) {
    const from = prevMap.get(id) ?? null;
    if (from !== to) moves.push({ id, from, to });
  }
  for (const [id, from] of prevMap) {
    if (!nextMap.has(id)) moves.push({ id, from, to: null });
  }
  return moves;
}

/**
 * Find a workpiece by filename across all queue folders.
 * The returned object is annotated with a `_source` field identifying which
 * queue it came from so the drawer UI can conditionally render actions
 * (e.g. Retry / Dismiss-forever only for errored workpieces).
 */
export async function findWorkpiece(
  linePath: string,
  fileName: string
): Promise<(Workpiece & { _source?: string }) | null> {
  const candidates: { dir: string; source: string }[] = [
    { dir: resolve(linePath, "queues", "done"), source: "done" },
    { dir: resolve(linePath, "queues", "error"), source: "error" },
    { dir: resolve(linePath, "queues", "review"), source: "review" },
    { dir: resolve(linePath, "queues", "inbox"), source: "inbox" },
  ];

  // Also search section queues
  const stationsDir = resolve(linePath, "stations");
  if (existsSync(stationsDir)) {
    for (const station of readdirSync(stationsDir)) {
      for (const sub of ["inbox", "processing", "output"]) {
        candidates.push({
          dir: resolve(stationsDir, station, "queue", sub),
          source: `station:${station}:${sub}`,
        });
      }
    }
  }

  for (const { dir, source } of candidates) {
    const path = resolve(dir, fileName);
    if (existsSync(path)) {
      try {
        const wp = JSON.parse(readFileSync(path, "utf-8")) as Workpiece;
        return { ...wp, _source: source };
      } catch {}
    }
  }

  return null;
}

// ─── Task Events ────────────────────────────────────────────────────

export function getTaskEventStations(linePath: string, wpId: string) {
  return listTaskEventStations(linePath, wpId);
}

export function getTaskEvents(
  linePath: string,
  wpId: string,
  stationName: string,
  opts: { after?: number; before?: number; limit?: number } = {}
) {
  return readTaskEvents(linePath, wpId, stationName, opts);
}
