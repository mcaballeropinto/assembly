export type StationStatusState =
  | "running"
  | "blocked"
  | "errored"
  | "idle"
  | "muted"

export interface ActivityEntry {
  ts: string
  event: string
  station?: string
  workpiece?: string
  summary?: string
  task?: string
  error?: string
  source?: string
  target?: string
  reason?: string
  child_live?: boolean
  silent_s?: number
  last_activity_ts?: string
  tick?: number
  elapsed_s?: number
  attempt?: number
  delay_s?: number
  from?: string
  to?: string
  line?: string
  stations?: string[]
  effective_env?: Record<string, unknown>
  _line?: string
  [key: string]: unknown
}

export interface StationRounds {
  turns: number
  tools: Record<string, number>
}

export interface StationResult {
  summary: string
  content?: string
  data?: Record<string, unknown>
  status: "done" | "failed" | "skipped" | "escalated"
  started_at: string
  finished_at: string
  model: string
  tokens: {
    in: number
    out: number
    cache_read?: number
    cache_creation?: number
  }
  cost_usd: number
  eval?: {
    pass: boolean
    feedback: string
    score?: number
    action?: "retry" | "escalate"
    tokens?: StationResult["tokens"]
    cost_usd?: number
  }
  failure_class?:
    | "envelope"
    | "crash"
    | "timeout"
    | "guardrail"
    | "provider"
    | "aborted"
    | "unknown"
  rounds?: StationRounds
  previous_attempts?: Omit<StationResult, "previous_attempts">[]
}

export interface Workpiece {
  id: string
  schema_version?: number
  line: string
  task: string
  input: Record<string, unknown>
  taskKey?: string
  dependsOn?: string[]
  stations: Record<string, StationResult>
  totals?: {
    tokens: StationResult["tokens"]
    cost_usd: number
  }
}

export interface StationMeta {
  name: string
  status?: string
  started_at?: string
  finished_at?: string
  duration_ms?: number
  latestProgress?: {
    detail?: string
    tool?: string
    elapsed_s?: number
    turns?: number
  }
}

export interface TaskEvent {
  seq: number
  ts: string
  kind: string
  summary?: string
  detail?: unknown
}

export interface TaskEventsPage {
  events: TaskEvent[]
  total: number
}

export interface ApiStateLineEntry {
  name: string
  path: string
  status: "running" | "error"
  error?: string
  startedAt: string
  state: {
    line: string
    description?: string
    sequence: string[]
    lineQueue: {
      inbox: number
      done: number
      error: number
      errorActive: number
      review: number
    }
    held: Array<{ fileName: string; task: string; enqueued_at?: string }>
    sections: Record<
      string,
      { inbox: number; processing: number; output: number; done_total: number }
    >
    stationTimings?: Record<
      string,
      {
        started_at: string
        finished_at?: string
        duration_ms?: number
        running?: boolean
        latestProgress?: {
          detail?: string
          tool?: string
          elapsed_s?: number
          turns?: number
        }
      }
    >
    activity: ActivityEntry[]
    completed: unknown[]
    errors: unknown[]
    banner_errors?: unknown[]
    errorsDismissed: unknown[]
    timestamp: string
  } | null
}

export interface ApiStateTotals {
  lines: number
  linesRunning: number
  linesErrored: number
  totalInbox: number
  totalDone: number
  totalErrors: number
  totalReview: number
  totalCostUsd: number
  totalThroughput1h: number
  totalThroughput24h: number
}

export interface ApiStateResponse {
  lines: ApiStateLineEntry[]
  totals: ApiStateTotals
  timestamp: string
  version: string
}

export interface ApiErrorResponse {
  error: string
}

export interface ApiTaskEventStationsResponse {
  stations: StationMeta[]
}

export type ApiTaskEventsResponse = TaskEventsPage

export interface ApiSidecarTail {
  content: string
  exists: boolean
  truncated: boolean
  bytes: number
}

export interface ApiWorkpieceSidecarsResponse {
  stdout: ApiSidecarTail
  stderr: ApiSidecarTail
  retry: ApiSidecarTail
}

export type ApiWorkpieceResponse =
  | (Workpiece & {
      _source?: string
      _activity?: unknown[]
      _taskEventStations?: StationMeta[]
    })
  | ApiErrorResponse
