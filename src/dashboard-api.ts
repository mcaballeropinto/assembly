// Wire-contract types for the Assembly dashboard API. Re-exports public shapes
// from dashboard-data.ts and defines typed interfaces for each HTTP endpoint
// response. See web/PORT-NOTES.md for panel-level documentation.

import type { Workpiece } from "./types";
import type { StationMeta, TaskEventsPage } from "./dashboard-data";

// ─── Type re-exports from dashboard-data.ts ────────────────────────────────

export type {
  Workpiece,
  StationResult,
  StationRounds,
  RetryState,
} from "./types";

export type {
  HealthState,
  HistoryStationCell,
  HistoryRun,
  HistoryStationStats,
  LineHistory,
  GetHistoryOptions,
  ConnectionState,
  StationFreshnessState,
  StationFreshness,
  ThroughputCounts,
  KanbanLane,
  KanbanCardState,
  KanbanCard,
  KanbanColumn,
  StationStatusState,
  StationStatus,
  StationTooltipMeta,
  KanbanState,
  KanbanMove,
  FlowMetricsTile,
  FlowMetrics,
  StationMeta,
  TaskEventsPage,
  TaskEvent,
} from "./dashboard-data";

// ─── Constant re-exports ───────────────────────────────────────────────────

export {
  BANNER_ERROR_MAX_AGE_MS,
  CONNECTION_LIVE_THRESHOLD_MS,
  CONNECTION_STALE_THRESHOLD_MS,
  FRESHNESS_POLL_INTERVAL_MS,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  STATION_BLOCKED_THRESHOLD_MS,
} from "./dashboard-data";

// ─── API Response Interfaces ───────────────────────────────────────────────

/**
 * A single activity entry in the activity log. Each entry represents a discrete
 * event (station_done, error, trigger_fired, etc.). Fields vary by event type.
 */
export interface ActivityEntry {
  ts: string;
  event: string;
  station?: string;
  workpiece?: string;
  summary?: string;
  task?: string;
  error?: string;
  source?: string;
  target?: string;
  reason?: string;
  child_live?: boolean;
  silent_s?: number;
  last_activity_ts?: string;
  tick?: number;
  elapsed_s?: number;
  attempt?: number;
  delay_s?: number;
  from?: string;
  to?: string;
  line?: string;
  stations?: string[];
  effective_env?: Record<string, unknown>;
  _line?: string; // client-side tag for multi-line merge
  [key: string]: unknown; // future-proof for new event fields
}

/**
 * Response from GET /api/state — the global overview of all lines.
 */
export interface ApiStateLineEntry {
  name: string;
  path: string;
  status: "running" | "error";
  error?: string;
  startedAt: string;
  state: {
    line: string;
    description?: string;
    sequence: string[];
    lineQueue: {
      inbox: number;
      done: number;
      error: number;
      errorActive: number;
      review: number;
    };
    held: Array<{ fileName: string; task: string; enqueued_at?: string }>;
    sections: Record<
      string,
      { inbox: number; processing: number; output: number; done_total: number }
    >;
    stationTimings?: Record<
      string,
      {
        started_at: string;
        finished_at?: string;
        duration_ms?: number;
        running?: boolean;
        latestProgress?: {
          detail?: string;
          tool?: string;
          elapsed_s?: number;
          turns?: number;
        };
      }
    >;
    stationFreshness?: Record<
      string,
      {
        state: "fresh" | "stale" | "disconnected" | "completed";
        last_updated_at: string | null;
        silent_s: number;
        icon: string;
        label: string;
      }
    >;
    pipelineTotalMs?: number | null;
    activity: ActivityEntry[];
    completed: unknown[];
    errors: unknown[];
    banner_errors?: unknown[];
    errors_meta?: {
      total_active: number;
      in_banner: number;
      oldest_in_banner_age_ms: number;
      max_banner_age_ms: number;
    };
    errorsDismissed: unknown[];
    reviews?: unknown[];
    triggers?: unknown[];
    health?: { state: string; count: number; detail: string };
    sessionTotals?: {
      tokens_in: number;
      tokens_out: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost_usd: number;
      workpieces: number;
      byStation: Record<
        string,
        {
          tokens_in: number;
          tokens_out: number;
          cost_usd: number;
          count: number;
          cache_read: number;
          cache_creation: number;
        }
      >;
    };
    throughput?: { last_1h: number; last_24h: number };
    timestamp: string;
  } | null;
}

export interface ApiStateTotals {
  lines: number;
  linesRunning: number;
  linesErrored: number;
  totalInbox: number;
  totalDone: number;
  totalErrors: number;
  totalReview: number;
  totalCostUsd: number;
  totalThroughput1h: number;
  totalThroughput24h: number;
}

export interface ApiStateResponse {
  lines: ApiStateLineEntry[];
  totals: ApiStateTotals;
  timestamp: string;
  version: string;
}

/**
 * Response from GET /api/usage — token quota status.
 */
export interface ApiUsageBucket {
  label: string;
  utilization: number;
  resets_at: string | null;
}

export interface ApiUsageResponse {
  checkedAt?: string;
  threshold?: number;
  paused?: boolean;
  pauseReason?: string;
  providers?: {
    "claude-code"?: {
      buckets: ApiUsageBucket[];
      raw?: Record<string, unknown>;
      error?: string;
    };
    codex?: {
      buckets: ApiUsageBucket[];
      raw?: Record<string, unknown>;
      error?: string;
    };
  };
  ageMs?: number | null;
  state?: string;
  reason?: string;
}

export interface ApiErrorResponse {
  error: string;
}

export interface ApiTaskEventStationsResponse {
  stations: StationMeta[];
}

export type ApiTaskEventsResponse = TaskEventsPage;

export interface ApiSidecarTail {
  content: string;
  exists: boolean;
  truncated: boolean;
  bytes: number;
}

export interface ApiWorkpieceSidecarsResponse {
  stdout: ApiSidecarTail;
  stderr: ApiSidecarTail;
  retry: ApiSidecarTail;
}

/**
 * Response from GET /api/line/:name — full state for a single line.
 * On error, returns { error: string }. On success, returns the full state object.
 */
export type ApiLineStateResponse =
  | {
      line: string;
      description?: string;
      sequence: string[];
      lineQueue: {
        inbox: number;
        done: number;
        error: number;
        errorActive: number;
        review: number;
      };
      held: Array<{ fileName: string; task: string; enqueued_at?: string }>;
      sections: Record<
        string,
        { inbox: number; processing: number; output: number; done_total: number }
      >;
      stationTimings: Record<
        string,
        {
          started_at: string;
          finished_at?: string;
          duration_ms?: number;
          running?: boolean;
          latestProgress?: {
            detail?: string;
            tool?: string;
            elapsed_s?: number;
            turns?: number;
          };
        }
      >;
      stationFreshness: Record<
        string,
        {
          state: "fresh" | "stale" | "disconnected" | "completed";
          last_updated_at: string | null;
          silent_s: number;
          icon: string;
          label: string;
        }
      >;
      pipelineTotalMs: number | null;
      activity: ActivityEntry[];
      completed: unknown[];
      errors: unknown[];
      banner_errors: unknown[];
      errors_meta: {
        total_active: number;
        in_banner: number;
        oldest_in_banner_age_ms: number;
        max_banner_age_ms: number;
      };
      errorsDismissed: unknown[];
      reviews: unknown[];
      triggers: unknown[];
      health: { state: string; count: number; detail: string };
      sessionTotals: {
        tokens_in: number;
        tokens_out: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        cost_usd: number;
        workpieces: number;
        byStation: Record<
          string,
          {
            tokens_in: number;
            tokens_out: number;
            cost_usd: number;
            count: number;
            cache_read: number;
            cache_creation: number;
          }
        >;
      };
      throughput: { last_1h: number; last_24h: number };
      timestamp: string;
  }
  | { error: string };

export type ApiWorkpieceResponse =
  | (Workpiece & {
      _source?: string;
      _activity?: unknown[];
      _activityMeta?: { bounded: true; maxBytes: number; note: string };
      _taskEventStations?: StationMeta[];
    })
  | ApiErrorResponse;

/**
 * Response from GET /api/line/:name/kanban.
 */
export type ApiKanbanResponse = import("./dashboard-data").KanbanState | { error: string };

/**
 * Response from GET /api/line/:name/kanban/done.
 */
export interface ApiKanbanDoneResponse {
  cards: import("./dashboard-data").KanbanCard[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Response from POST /api/line/:name/release.
 */
export type ApiReleaseHeldRequest = { all: true } | { taskFile: string } | { next: number };

export interface ApiReleaseHeldResponse {
  released: string[];
  skipped: string[];
  errors: Array<{ file?: string; error: string } | string>;
}
