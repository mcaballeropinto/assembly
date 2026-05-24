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

// ─── Per-Station Freshness (station-level liveness) ──────────────────

export const FRESHNESS_POLL_INTERVAL_MS = 30_000; // matches HEARTBEAT_MS from section-worker.ts

export type StationFreshnessState = "fresh" | "stale" | "disconnected" | "completed";

export interface StationFreshness {
  state: StationFreshnessState;
  last_updated_at: string | null;
  silent_s: number;
  icon: string;
  label: string;
}

/**
 * Compute per-station freshness based on heartbeats and station lifecycle.
 *
 * Thresholds (default poll interval = 30s):
 * - fresh: age < 2 × 30s = 60s
 * - stale: 60s ≤ age < 5 × 30s = 150s
 * - disconnected: age ≥ 150s
 * - completed: station has finished_at and is not running
 *
 * Scans activity.jsonl for the latest station_heartbeat or station_done event per station.
 */
export function computeStationFreshness(
  linePath: string,
  sequence: string[],
  sections: Record<string, { inbox: number; processing: number; output: number }>,
  stationTimings: Record<string, { started_at: string; finished_at?: string; running?: boolean }>
): Record<string, StationFreshness> {
  const freshness: Record<string, StationFreshness> = {};
  const now = Date.now();
  const threshold2x = 2 * FRESHNESS_POLL_INTERVAL_MS;
  const threshold5x = 5 * FRESHNESS_POLL_INTERVAL_MS;

  // Read activity log in reverse to find latest heartbeat per station
  const logPath = resolve(linePath, "queues", "activity.jsonl");
  const lastHeartbeatByStation: Record<string, { ts: string; event: string }> = {};

  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);

      // Scan last 200 lines in reverse
      const recent = lines.slice(-200).reverse();
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          const stationName = entry.station;
          if (!stationName || lastHeartbeatByStation[stationName]) continue;

          if (entry.event === "station_heartbeat" || entry.event === "station_done") {
            lastHeartbeatByStation[stationName] = { ts: entry.ts, event: entry.event };
          }
        } catch {}
      }
    } catch {}
  }

  for (const name of sequence) {
    const timing = stationTimings[name];
    const section = sections[name];
    const lastHeartbeat = lastHeartbeatByStation[name];

    // Check if station is completed (finished and not running, no active processing/inbox)
    const isCompleted =
      timing?.finished_at &&
      !timing?.running &&
      section?.processing === 0 &&
      section?.inbox === 0;

    if (isCompleted) {
      const finishedAt = timing.finished_at!;
      const ageMs = now - new Date(finishedAt).getTime();
      const ageSec = Math.floor(ageMs / 1000);
      const ageMin = Math.floor(ageSec / 60);
      const label = ageMin > 0 ? `Completed ${ageMin}m ago` : `Completed ${ageSec}s ago`;

      freshness[name] = {
        state: "completed",
        last_updated_at: finishedAt,
        silent_s: ageSec,
        icon: "—",
        label,
      };
      continue;
    }

    // Station is not completed — check heartbeat freshness
    if (!lastHeartbeat) {
      // No heartbeat data — check if station is idle (never ran) or just starting
      if (!timing && section?.processing === 0 && section?.inbox === 0) {
        // Idle station, never ran
        freshness[name] = {
          state: "completed",
          last_updated_at: null,
          silent_s: 0,
          icon: "—",
          label: "Idle",
        };
      } else {
        // Station is starting or has active work — give benefit of the doubt
        freshness[name] = {
          state: "fresh",
          last_updated_at: timing?.started_at || null,
          silent_s: 0,
          icon: "✓",
          label: "Starting",
        };
      }
      continue;
    }

    // Have heartbeat data — classify by age
    const lastUpdateMs = new Date(lastHeartbeat.ts).getTime();
    const ageMs = now - lastUpdateMs;
    const ageSec = Math.floor(ageMs / 1000);

    let state: StationFreshnessState;
    let icon: string;
    let label: string;

    if (ageMs < threshold2x) {
      state = "fresh";
      icon = "✓";
      label = `Updated ${ageSec}s ago`;
    } else if (ageMs < threshold5x) {
      state = "stale";
      icon = "⏱";
      label = `Stale — ${ageSec}s ago`;
    } else {
      state = "disconnected";
      icon = "✕";
      label = `Disconnected — ${ageSec}s ago`;
    }

    freshness[name] = {
      state,
      last_updated_at: lastHeartbeat.ts,
      silent_s: ageSec,
      icon,
      label,
    };
  }

  return freshness;
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
          outcome: "success",
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
          outcome: "failed",
          errorSummary: failedStations.length > 0 ? (failedStations[0].error || '').slice(0, 80) : '',
          stations: Object.fromEntries(
            Object.entries(wp.stations).map(([k, v]) => [
              k,
              { status: v.status, summary: v.summary },
            ])
          ),
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

  // Station freshness — per-station liveness indicators
  const stationFreshness = computeStationFreshness(linePath, sequence, sections, stationTimings);

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
    stationFreshness,
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
  stationStartedAt?: string | null;      // wp.stations[station].started_at
  firstStationStartedAt?: string | null;  // earliest started_at across all stations
  totalElapsedMs?: number | null;         // Date.now() - firstStationStartedAt
  retries?: number;
  costUsd?: number;
  evalScore?: number;
  retry?: RetryState;
  finished_at?: string | null;
  duration_ms?: number | null;
  failedStation?: string;
  outcome?: "success" | "failed" | "escalated";
  errorSummary?: string;
}

export interface KanbanColumn {
  key: string;
  title: string;
  tooltip?: string;
  station?: string;
  lane?: KanbanLane;
  count: number;
  wipLimit?: number;
  cards: KanbanCard[];
  retrying_count?: number;
  exhausted_count?: number;
  pinnedFailures?: number;
}

export type StationStatusState = "running" | "idle" | "blocked" | "errored" | "muted";

export interface StationStatus {
  state: StationStatusState;
  label: string;        // plain-language tooltip text, e.g. "Running · 1 item · started 4m ago"
  icon: string;         // unicode icon: ▶ (running), ◯ (idle), ! (blocked), ✕ (errored)
  itemCount: number;    // total items in this station's lanes
  startedAt?: string;   // ISO timestamp of when processing began (for running state)
  lastErrorStation?: string; // station name that last errored (for errored state)
}

export const STATION_BLOCKED_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — same as card-level stuck

export interface StationTooltipMeta {
  description?: string;
  provider?: string;
  model?: string;
  timeout?: number;
}

export interface KanbanState {
  line: string;
  sequence: string[];
  columns: KanbanColumn[];
  concurrency?: number;
  lastUpdated: string;
  stationFreshness?: Record<string, StationFreshness>;
  stationStatuses?: Record<string, StationStatus>;
  stationMeta?: Record<string, StationTooltipMeta>;
}

function readWorkpieceSafe(path: string): Workpiece | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Workpiece;
  } catch {
    return null;
  }
}

function formatRelativeShort(ms: number): string {
  if (ms < 0) return 'just now';
  if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
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
    // For error cards, record which station failed
    if (columnKey === 'error') {
      const failedEntry = Object.entries(wp.stations ?? {}).find(
        ([, sr]) => sr.status === 'failed'
      );
      if (failedEntry) {
        card.failedStation = failedEntry[0];
        card.outcome = "failed";
        card.errorSummary = (failedEntry[1].summary || '').slice(0, 80);
      }
    }
    // For done cards, set outcome to success (or escalated if any station was escalated)
    if (columnKey === 'done') {
      const hasEscalated = Object.values(wp.stations ?? {}).some(sr => sr.status === 'escalated');
      card.outcome = hasEscalated ? "escalated" : "success";
    }
    // For review cards, set outcome to escalated
    if (columnKey === 'review') {
      card.outcome = "escalated";
    }
    // Lifecycle timestamps for duration labels
    if (station) {
      const sr = wp.stations?.[station];
      if (sr?.started_at) {
        card.stationStartedAt = sr.started_at;
      }
    }
    // Compute earliest station start (proxy for pipeline entry)
    const allStationStarts = Object.values(wp.stations ?? {})
      .map(s => s.started_at)
      .filter(Boolean)
      .sort();
    if (allStationStarts.length > 0) {
      card.firstStationStartedAt = allStationStarts[0];
      card.totalElapsedMs = Date.now() - new Date(allStationStarts[0]).getTime();
    }
    // Read retry sidecar if present
    const retryState = readRetryState(filePath);
    if (retryState && retryState.retry_count > 0) {
      card.retry = retryState;
    }
    // Compute finish time and total duration for done cards
    if (columnKey === "done") {
      const stationVals = Object.values(wp.stations ?? {});
      const allStarted = stationVals.map(s => s.started_at).filter(Boolean).sort();
      const allFinished = stationVals.map(s => s.finished_at).filter(Boolean).sort();
      const wpFinishedAt = allFinished.length > 0 ? allFinished[allFinished.length - 1] : null;
      const wpStartedAt = allStarted.length > 0 ? allStarted[0] : null;
      if (wpFinishedAt) card.finished_at = wpFinishedAt;
      if (wpFinishedAt && wpStartedAt) {
        card.duration_ms = new Date(wpFinishedAt).getTime() - new Date(wpStartedAt).getTime();
      }
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

export function computeStationStatuses(
  columns: KanbanColumn[],
  sequence: string[],
  errorColumns: KanbanColumn[],
  linePath: string,
): Record<string, StationStatus> {
  const statuses: Record<string, StationStatus> = {};
  const now = Date.now();

  // Build a set of station names that have errored workpieces
  const errorsByStation = new Map<string, { count: number; newestFinishedAt: string | null }>();
  for (const errCol of errorColumns) {
    for (const card of errCol.cards) {
      const fs = (card as KanbanCard).failedStation;
      if (fs) {
        const existing = errorsByStation.get(fs) || { count: 0, newestFinishedAt: null };
        existing.count++;
        // Use enteredColumnAt as a proxy for when the error occurred
        if (card.enteredColumnAt && (!existing.newestFinishedAt || card.enteredColumnAt > existing.newestFinishedAt)) {
          existing.newestFinishedAt = card.enteredColumnAt;
        }
        errorsByStation.set(fs, existing);
      }
    }
  }

  // Build per-station lane data from columns
  const stationLanes = new Map<string, { inbox: KanbanCard[]; processing: KanbanCard[]; output: KanbanCard[] }>();
  for (const col of columns) {
    if (!col.station) continue;
    if (!stationLanes.has(col.station)) {
      stationLanes.set(col.station, { inbox: [], processing: [], output: [] });
    }
    const lanes = stationLanes.get(col.station)!;
    if (col.lane === 'inbox') lanes.inbox = col.cards;
    else if (col.lane === 'processing') lanes.processing = col.cards;
    else if (col.lane === 'output') lanes.output = col.cards;
  }

  for (const stationName of sequence) {
    const lanes = stationLanes.get(stationName);
    const errInfo = errorsByStation.get(stationName);
    const totalItems = lanes
      ? lanes.inbox.length + lanes.processing.length + lanes.output.length
      : 0;

    // Priority 1: Errored
    if (errInfo && errInfo.count > 0) {
      const ageStr = errInfo.newestFinishedAt
        ? formatRelativeShort(now - new Date(errInfo.newestFinishedAt).getTime())
        : 'unknown';
      statuses[stationName] = {
        state: 'errored',
        label: `Errored · ${errInfo.count} error${errInfo.count !== 1 ? 's' : ''} · last ${ageStr}`,
        icon: '✕',
        itemCount: totalItems,
      };
      continue;
    }

    // Priority 2: Running
    if (lanes && lanes.processing.length > 0) {
      const oldestProcessing = lanes.processing.reduce((oldest, card) => {
        if (!oldest.enteredColumnAt) return card;
        if (!card.enteredColumnAt) return oldest;
        return card.enteredColumnAt < oldest.enteredColumnAt ? card : oldest;
      }, lanes.processing[0]);
      const startedAgo = oldestProcessing.enteredColumnAt
        ? formatRelativeShort(now - new Date(oldestProcessing.enteredColumnAt).getTime())
        : '';
      statuses[stationName] = {
        state: 'running',
        label: `Running · ${lanes.processing.length} item${lanes.processing.length !== 1 ? 's' : ''}${startedAgo ? ' · started ' + startedAgo : ''}`,
        icon: '▶',
        itemCount: totalItems,
        startedAt: oldestProcessing.enteredColumnAt ?? undefined,
      };
      continue;
    }

    // Priority 3: Blocked
    if (lanes && lanes.inbox.length > 0) {
      const oldestInbox = lanes.inbox.reduce((oldest, card) => {
        if (!oldest.enteredColumnAt) return card;
        if (!card.enteredColumnAt) return oldest;
        return card.enteredColumnAt < oldest.enteredColumnAt ? card : oldest;
      }, lanes.inbox[0]);
      const oldestAge = oldestInbox.enteredColumnAt
        ? now - new Date(oldestInbox.enteredColumnAt).getTime()
        : 0;
      if (oldestAge > STATION_BLOCKED_THRESHOLD_MS) {
        statuses[stationName] = {
          state: 'blocked',
          label: `Blocked · ${lanes.inbox.length} item${lanes.inbox.length !== 1 ? 's' : ''} waiting · oldest ${formatRelativeShort(oldestAge)}`,
          icon: '!',
          itemCount: totalItems,
        };
        continue;
      }
    }

    // Priority 4: Idle (has had activity before or has items in output)
    if (lanes && (lanes.output.length > 0 || totalItems > 0)) {
      statuses[stationName] = {
        state: 'idle',
        label: `Idle · ${totalItems} item${totalItems !== 1 ? 's' : ''}`,
        icon: '◯',
        itemCount: totalItems,
      };
      continue;
    }

    // Priority 5: Idle (no work, healthy)
    statuses[stationName] = {
      state: 'idle',
      label: 'Idle · no work',
      icon: '◯',
      itemCount: 0,
    };
  }

  return statuses;
}

/**
 * Build the kanban board state for a line.
 * The filesystem is the state machine — each card is placed based on which folder its file lives in.
 */
/**
 * Get a paginated slice of done cards.
 * @param linePath Path to the assembly line
 * @param offset Index to start from (0-based)
 * @param limit Maximum number of cards to return
 * @param retriesByWp Optional pre-computed retry counts map
 * @returns Object with cards array and total count
 */
export async function getDoneCards(
  linePath: string,
  offset: number,
  limit: number,
  retriesByWp?: Map<string, number>,
): Promise<{ cards: KanbanCard[]; total: number }> {
  // Load retry counts if not provided
  const retries = retriesByWp ?? loadRetryCounts(linePath);

  // List all done files (oldest first by default from listQueue)
  const doneDir = resolve(linePath, "queues", "done");
  const allFiles = listQueue(doneDir);

  // Reverse to get newest first
  allFiles.reverse();

  const total = allFiles.length;

  // Slice to requested window
  const pageFiles = allFiles.slice(offset, offset + limit);

  // Build cards only for the requested slice
  const cards: KanbanCard[] = [];
  for (const f of pageFiles) {
    const card = buildKanbanCard(f, "done", undefined, undefined, retries);
    if (card) cards.push(card);
  }

  return { cards, total };
}

export async function getKanbanState(
  linePath: string,
): Promise<KanbanState | { error: string }> {
  let config;
  let stations: Map<string, import('./types').StationConfig> | undefined;
  try {
    const loaded = await loadLine(linePath);
    config = loaded.config;
    stations = loaded.stations;
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
    tooltip: "Tasks paused by the operator — release to move to Incoming",
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
    title: "Incoming",
    tooltip: "Tasks enqueued to this line, not yet assigned to any station",
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
      title: "waiting",
      tooltip: "Tasks assigned to this station, waiting for a worker slot",
      station: name,
      lane: "inbox",
      count: inbox.length,
      wipLimit: concurrency,
      cards: inbox,
    });
    columns.push({
      key: `${name}:processing`,
      title: "processing",
      tooltip: "Tasks currently being processed by a worker",
      station: name,
      lane: "processing",
      count: processing.length,
      wipLimit: concurrency,
      cards: processing,
    });
    columns.push({
      key: `${name}:output`,
      title: "output",
      tooltip: "Completed station work, waiting to be routed forward",
      station: name,
      lane: "output",
      count: output.length,
      wipLimit: concurrency,
      cards: output,
    });
  }

  // Error (collect early so we can pin failures in Done)
  const errorDir = resolve(linePath, "queues", "error");
  const errorCards = collectCards(errorDir, "error", undefined, undefined, retriesByWp);
  const dismissedMap = readDismissed(linePath);
  const activeErrorCards = errorCards.filter((c) => !dismissedMap[c.fileName]);

  // Done (always visible) - use paginated getDoneCards with pinned failures
  const doneResult = await getDoneCards(linePath, 0, 10, retriesByWp);

  // Include active error cards in Done column, pinned at top (max 5)
  const pinnedFailures = activeErrorCards.slice(0, 5).map(c => ({ ...c, column: 'done' }));
  const combinedDoneCards = [...pinnedFailures, ...doneResult.cards];

  columns.push({
    key: "done",
    title: "Done",
    tooltip: "Tasks that completed all stations successfully",
    count: doneResult.total + activeErrorCards.length,
    cards: combinedDoneCards,
    pinnedFailures: pinnedFailures.length,
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
      tooltip: "Tasks escalated for human review",
      count: reviewCards.length,
      cards: reviewCards,
    });
  }

  // Error (only visible if non-empty, active only)
  if (activeErrorCards.length > 0) {
    columns.push({
      key: "error",
      title: "Error",
      tooltip: "Tasks that failed after exhausting retries",
      count: activeErrorCards.length,
      cards: activeErrorCards,
    });
  }


  // Compute retry aggregates for each column
  for (const col of columns) applyRetryAggregates(col);

  // Build sections map from columns for station freshness
  const sections: Record<string, { inbox: number; processing: number; output: number }> = {};
  for (const col of columns) {
    if (col.station && col.lane) {
      if (!sections[col.station]) {
        sections[col.station] = { inbox: 0, processing: 0, output: 0 };
      }
      sections[col.station][col.lane] = col.count;
    }
  }

  // Compute station timings and freshness
  const stationTimings = getStationTimings(linePath, sequence);
  const stationFreshness = computeStationFreshness(linePath, sequence, sections, stationTimings);

  // Compute per-station health status indicators
  const errorCols = columns.filter(c => c.key === 'error');
  const stationStatuses = computeStationStatuses(columns, sequence, errorCols, linePath);

  // Build per-station metadata for tooltips
  const stationMeta: Record<string, StationTooltipMeta> = {};
  if (stations) {
    // Build a map of per-station timeout overrides from sequence steps
    const stationTimeouts: Record<string, number> = {};
    for (const step of config.sequence) {
      if (typeof step === 'object' && 'station' in step) {
        const s = (step as { station: { name: string; timeout?: number } }).station;
        if (s.timeout !== undefined) stationTimeouts[s.name] = s.timeout;
      }
    }
    for (const name of sequence) {
      const sc = stations.get(name);
      if (!sc) continue;
      const meta: StationTooltipMeta = {};
      if (sc.description) meta.description = sc.description;
      const provider = sc.provider || config.defaults?.provider;
      if (provider) meta.provider = provider;
      const model = sc.model || config.defaults?.model;
      if (model) meta.model = model;
      const timeout = stationTimeouts[name] ?? config.timeout;
      if (timeout !== undefined) meta.timeout = timeout;
      // Only include if there's at least a description
      if (Object.keys(meta).length > 0) stationMeta[name] = meta;
    }
  }

  return {
    line: config.name,
    sequence,
    columns,
    concurrency,
    lastUpdated: new Date().toISOString(),
    stationFreshness,
    stationStatuses,
    stationMeta,
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

// ─── Flow Metrics (Tier 4 #29) ──────────────────────────────────────

export interface FlowMetricsTile {
  label: string;
  value: string;           // formatted primary number
  rawValue: number;        // raw number for client-side formatting
  unit: string;            // "items", "items/day", "ms", "%"
  delta?: number | null;   // percentage change vs prior period, null if no prior data
  sparkline?: number[];    // 7 data points (one per day) for sparkline tiles
  explanation: string;     // plain-language hover tooltip
}

export interface FlowMetrics {
  tiles: FlowMetricsTile[];
  periodDays: number;
  timestamp: string;
}

function formatDurationCompact(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

/**
 * Compute flow metrics for the line detail metrics row.
 * Returns 5 tiles: Items in Flight, Throughput 7d, Avg Cycle Time, Avg Wait Time, Success Rate 7d.
 */
export function computeFlowMetrics(linePath: string, sequence: string[]): FlowMetrics {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const currentWindowStart = now - sevenDaysMs;
  const priorWindowStart = now - 2 * sevenDaysMs;

  const tiles: FlowMetricsTile[] = [];

  // Tile 1: Items in Flight
  let inFlightCount = 0;
  try {
    const lineState = getLineQueueState(linePath);
    inFlightCount += lineState.inbox;
    for (const name of sequence) {
      const stationDir = resolve(linePath, "stations", name);
      const queueState = getSectionQueueState(stationDir);
      inFlightCount += queueState.inbox + queueState.processing;
    }
  } catch {}

  tiles.push({
    label: "Items in Flight",
    value: String(inFlightCount),
    rawValue: inFlightCount,
    unit: "items",
    explanation: "Total workpieces currently in inbox or processing queues across all stations",
  });

  // Read done and error files from the last 14 days
  const doneDir = resolve(linePath, "queues", "done");
  const errorDir = resolve(linePath, "queues", "error");

  interface FileEntry {
    path: string;
    mtime: number;
    source: "done" | "error";
  }

  const allFiles: FileEntry[] = [];

  if (existsSync(doneDir)) {
    try {
      const files = readdirSync(doneDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const path = resolve(doneDir, f);
        const mtime = Bun.file(path).lastModified ?? 0;
        if (mtime >= priorWindowStart && mtime <= now) {
          allFiles.push({ path, mtime, source: "done" });
        }
      }
    } catch {}
  }

  if (existsSync(errorDir)) {
    try {
      const files = readdirSync(errorDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const path = resolve(errorDir, f);
        const mtime = Bun.file(path).lastModified ?? 0;
        if (mtime >= priorWindowStart && mtime <= now) {
          allFiles.push({ path, mtime, source: "error" });
        }
      }
    } catch {}
  }

  // Cap at 200 files to bound I/O
  allFiles.sort((a, b) => b.mtime - a.mtime);
  const selectedFiles = allFiles.slice(0, 200);

  // Partition into current and prior periods
  const currentDone: FileEntry[] = [];
  const priorDone: FileEntry[] = [];
  const currentError: FileEntry[] = [];
  const priorError: FileEntry[] = [];

  for (const f of selectedFiles) {
    if (f.mtime >= currentWindowStart) {
      if (f.source === "done") currentDone.push(f);
      else currentError.push(f);
    } else {
      if (f.source === "done") priorDone.push(f);
      else priorError.push(f);
    }
  }

  // Tile 2: Throughput 7d
  const dailyBuckets: number[] = [0, 0, 0, 0, 0, 0, 0];
  for (const f of currentDone) {
    const dayOffset = Math.floor((now - f.mtime) / (24 * 60 * 60 * 1000));
    const bucketIdx = 6 - Math.min(dayOffset, 6);
    if (bucketIdx >= 0 && bucketIdx < 7) dailyBuckets[bucketIdx]++;
  }

  const currentThroughput = currentDone.length / 7; // items per day
  const priorThroughput = priorDone.length / 7;
  const throughputDelta = priorThroughput > 0
    ? ((currentThroughput - priorThroughput) / priorThroughput) * 100
    : null;

  tiles.push({
    label: "Throughput 7d",
    value: currentThroughput.toFixed(1),
    rawValue: currentThroughput,
    unit: "items/day",
    delta: throughputDelta,
    sparkline: dailyBuckets,
    explanation: "Average completed workpieces per day over the last 7 days, with daily sparkline",
  });

  // Tile 3 & 4: Avg Cycle Time and Wait Time
  const currentCycleTimes: number[] = [];
  const currentWaitTimes: number[] = [];
  const priorCycleTimes: number[] = [];
  const priorWaitTimes: number[] = [];

  function computeTimings(files: FileEntry[], cycleTimes: number[], waitTimes: number[]) {
    for (const f of files) {
      try {
        const wp = JSON.parse(readFileSync(f.path, "utf-8")) as Workpiece;
        if (!wp.stations) continue;

        const stationVals = Object.values(wp.stations);
        const allStarted = stationVals.map(s => s.started_at).filter(Boolean).sort();
        const allFinished = stationVals.map(s => s.finished_at).filter(Boolean).sort();

        if (allStarted.length === 0 || allFinished.length === 0) continue;

        const cycleStart = new Date(allStarted[0]).getTime();
        const cycleEnd = new Date(allFinished[allFinished.length - 1]).getTime();
        const cycleTime = cycleEnd - cycleStart;

        if (cycleTime >= 0) {
          cycleTimes.push(cycleTime);

          // Compute wait time = cycle time - sum of station durations
          let totalProcessing = 0;
          for (const sr of stationVals) {
            if (sr.started_at && sr.finished_at) {
              const dur = new Date(sr.finished_at).getTime() - new Date(sr.started_at).getTime();
              if (dur >= 0) totalProcessing += dur;
            }
          }
          const waitTime = Math.max(0, cycleTime - totalProcessing);
          waitTimes.push(waitTime);
        }
      } catch {}
    }
  }

  computeTimings([...currentDone, ...currentError], currentCycleTimes, currentWaitTimes);
  computeTimings([...priorDone, ...priorError], priorCycleTimes, priorWaitTimes);

  const avgCycleCurrent = currentCycleTimes.length > 0
    ? currentCycleTimes.reduce((a, b) => a + b, 0) / currentCycleTimes.length
    : 0;
  const avgCyclePrior = priorCycleTimes.length > 0
    ? priorCycleTimes.reduce((a, b) => a + b, 0) / priorCycleTimes.length
    : 0;
  const cycleDelta = avgCyclePrior > 0
    ? ((avgCycleCurrent - avgCyclePrior) / avgCyclePrior) * 100
    : null;

  tiles.push({
    label: "Avg Cycle Time",
    value: avgCycleCurrent > 0 ? formatDurationCompact(avgCycleCurrent) : "0s",
    rawValue: avgCycleCurrent,
    unit: "ms",
    delta: cycleDelta,
    explanation: "Average end-to-end time from first station start to last station finish",
  });

  const avgWaitCurrent = currentWaitTimes.length > 0
    ? currentWaitTimes.reduce((a, b) => a + b, 0) / currentWaitTimes.length
    : 0;
  const avgWaitPrior = priorWaitTimes.length > 0
    ? priorWaitTimes.reduce((a, b) => a + b, 0) / priorWaitTimes.length
    : 0;
  const waitDelta = avgWaitPrior > 0
    ? ((avgWaitCurrent - avgWaitPrior) / avgWaitPrior) * 100
    : null;

  tiles.push({
    label: "Avg Wait Time",
    value: avgWaitCurrent > 0 ? formatDurationCompact(avgWaitCurrent) : "0s",
    rawValue: avgWaitCurrent,
    unit: "ms",
    delta: waitDelta,
    explanation: "Average time workpieces spend queued between stations (cycle time minus processing time)",
  });

  // Tile 5: Success Rate 7d
  const currentTotal = currentDone.length + currentError.length;
  const priorTotal = priorDone.length + priorError.length;
  const currentRate = currentTotal > 0 ? (currentDone.length / currentTotal) * 100 : 0;
  const priorRate = priorTotal > 0 ? (priorDone.length / priorTotal) * 100 : 0;
  const rateDelta = priorTotal > 0
    ? currentRate - priorRate  // percentage point difference
    : null;

  tiles.push({
    label: "Success Rate 7d",
    value: currentRate.toFixed(1) + "%",
    rawValue: currentRate,
    unit: "%",
    delta: rateDelta,
    explanation: "Percentage of workpieces that completed successfully (done vs error)",
  });

  return {
    tiles,
    periodDays: 7,
    timestamp: new Date().toISOString(),
  };
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
