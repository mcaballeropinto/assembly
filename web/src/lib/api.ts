import type {
  ApiStateResponse,
  ApiTaskEventsResponse,
  ApiTaskEventStationsResponse,
  ApiWorkpieceResponse,
  ApiWorkpieceSidecarsResponse,
} from "../../../src/dashboard-api"

export type KanbanLane = "inbox" | "processing" | "output"

export type KanbanCardState =
  | "held"
  | "waiting"
  | "running"
  | "evaluating"
  | "retrying"
  | "routed"
  | "done"
  | "failed"
  | "escalated"

export type StationStatusState = "running" | "idle" | "blocked" | "errored"

export type StationFreshnessState = "fresh" | "stale" | "disconnected" | "completed"

export interface RetryState {
  retry_count: number
  max_retries: number
  failure_class?: string
  in_backoff: boolean
  backoff_until?: string
  exhausted: boolean
}

export interface KanbanCard {
  id: string
  fileName: string
  title: string
  preview?: string
  state: KanbanCardState
  column: string
  station?: string
  lane?: KanbanLane
  enteredColumnAt: string | null
  stationStartedAt?: string | null
  firstStationStartedAt?: string | null
  totalElapsedMs?: number | null
  retries?: number
  costUsd?: number
  evalScore?: number
  retry?: RetryState
  finished_at?: string | null
  duration_ms?: number | null
  failedStation?: string
  outcome?: "success" | "failed" | "escalated"
  errorSummary?: string
}

export interface StationTooltipMeta {
  description?: string
  provider?: string
  model?: string
  timeout?: number
}

export interface StationFreshness {
  state: StationFreshnessState
  last_updated_at: string | null
  silent_s: number
  icon: string
  label: string
}

export interface StationStatus {
  state: StationStatusState
  icon: string
  label: string
}

export interface KanbanColumn {
  key: string
  title: string
  tooltip?: string
  station?: string
  lane?: KanbanLane
  count: number
  wipLimit?: number
  cards: KanbanCard[]
  retrying_count?: number
  exhausted_count?: number
  pinnedFailures?: KanbanCard[]
}

export interface KanbanState {
  columns: KanbanColumn[]
  stationFreshness?: Record<string, StationFreshness>
  stationStatuses?: Record<string, StationStatus>
  stationMeta?: Record<string, StationTooltipMeta>
  timestamp: string
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let detail = ""
    try {
      const body = (await res.json()) as { error?: string }
      detail = body.error ? `: ${body.error}` : ""
    } catch {}
    throw new Error(`Request failed (${res.status})${detail}`)
  }
  return res.json() as Promise<T>
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

export function fetchWorkpiece(lineName: string, fileName: string): Promise<ApiWorkpieceResponse> {
  return fetchJson<ApiWorkpieceResponse>(`/api/workpiece/${enc(lineName)}/${enc(fileName)}`)
}

export function fetchTaskEventStations(
  lineName: string,
  workpieceId: string
): Promise<ApiTaskEventStationsResponse> {
  return fetchJson<ApiTaskEventStationsResponse>(`/api/task-events/${enc(lineName)}/${enc(workpieceId)}`)
}

export function fetchTaskEvents(
  lineName: string,
  workpieceId: string,
  stationName: string,
  options: { after?: number; before?: number; limit?: number } = {}
): Promise<ApiTaskEventsResponse> {
  const params = new URLSearchParams()
  if (options.after !== undefined) params.set("after", String(options.after))
  if (options.before !== undefined) params.set("before", String(options.before))
  if (options.limit !== undefined) params.set("limit", String(options.limit))
  const qs = params.toString()
  return fetchJson<ApiTaskEventsResponse>(
    `/api/task-events/${enc(lineName)}/${enc(workpieceId)}/${enc(stationName)}${qs ? `?${qs}` : ""}`
  )
}

export function fetchWorkpieceSidecars(
  lineName: string,
  fileName: string
): Promise<ApiWorkpieceSidecarsResponse> {
  return fetchJson<ApiWorkpieceSidecarsResponse>(
    `/api/workpiece/${enc(lineName)}/${enc(fileName)}/sidecars`
  )
}

type FetchApiStateInput = AbortSignal | { signal?: AbortSignal }

export function fetchApiState(input?: FetchApiStateInput): Promise<ApiStateResponse> {
  const signal = input && "aborted" in input ? input : input?.signal
  return fetchJson<ApiStateResponse>("/api/state", { signal })
}

export function fetchKanbanState(lineName: string): Promise<KanbanState> {
  return fetchJson<KanbanState>(`/api/line/${enc(lineName)}/kanban`)
}

export function fetchDoneCards(
  lineName: string,
  offset: number,
  limit: number
): Promise<{
  cards: KanbanCard[]
  total: number
  offset: number
  limit: number
}> {
  return fetchJson(
    `/api/line/${enc(lineName)}/kanban/done?offset=${offset}&limit=${limit}`
  )
}

export function releaseAllHeld(lineName: string): Promise<unknown> {
  return fetchJson(`/api/line/${enc(lineName)}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all: true }),
  })
}

export function releaseHeldTask(lineName: string, taskFile: string): Promise<unknown> {
  return fetchJson(`/api/line/${enc(lineName)}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskFile }),
  })
}
