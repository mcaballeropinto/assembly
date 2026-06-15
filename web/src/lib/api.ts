import type {
  ApiStateResponse,
  ApiTaskEventsResponse,
  ApiTaskEventStationsResponse,
  ApiWorkpieceResponse,
  ApiWorkpieceSidecarsResponse,
} from "../../../src/dashboard-api"

export type {
  ActivityEntry,
  ApiStateLineEntry,
  ApiStateResponse,
  ApiStateTotals,
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

export interface KanbanCard {
  id: string
  fileName: string
  title: string
  preview?: string
  state: KanbanCardState
  column: string
  station?: string
  lane?: KanbanLane
  enteredColumnAt?: string | null
  stationStartedAt?: string | null
  duration_ms?: number | null
  outcome?: string
  failedStation?: string
  retries?: number
  retry?: {
    retry_count: number
    max_retries?: number
    in_backoff?: boolean
    exhausted?: boolean
    backoff_until?: string
  }
}

export interface KanbanColumn {
  key: string
  title: string
  tooltip?: string
  count: number
  cards: KanbanCard[]
  station?: string
  lane?: KanbanLane
  wipLimit?: number
  retrying_count?: number
  exhausted_count?: number
}

export type StationFreshnessState =
  | "fresh"
  | "stale"
  | "disconnected"
  | "completed"

export interface StationFreshness {
  state: StationFreshnessState
  last_updated_at: string | null
  silent_s: number
  icon: string
  label: string
}

export type StationStatusState =
  | "running"
  | "blocked"
  | "errored"
  | "idle"
  | "muted"

export interface StationStatus {
  state: StationStatusState
  label: string
  icon: string
  itemCount: number
}

export interface StationTooltipMeta {
  description?: string
  provider?: string
  model?: string
  timeout?: number
}

export interface KanbanState {
  line: string
  sequence: string[]
  lastUpdated: string
  columns: KanbanColumn[]
  stationStatuses?: Record<string, StationStatus>
  stationFreshness?: Record<string, StationFreshness>
  stationMeta?: Record<string, StationTooltipMeta>
}

export interface ApiLocalErrorResponse {
  error: string
}

export type ApiKanbanResponse = KanbanState | ApiLocalErrorResponse

export interface ApiKanbanDoneResponse {
  cards: KanbanCard[]
  total: number
  offset: number
  limit: number
}

export interface ApiReleaseHeldResponse {
  released: string[]
  skipped: string[]
  errors: Array<{ file?: string; error: string } | string>
}

type JsonError = {
  error?: unknown
  message?: unknown
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init)

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`

    try {
      const body = (await response.json()) as JsonError
      if (typeof body.error === "string" && body.error.trim()) {
        message = body.error
      } else if (typeof body.message === "string" && body.message.trim()) {
        message = body.message
      }
    } catch {
      try {
        const text = await response.text()
        if (text.trim()) message = text.trim()
      } catch {}
    }

    throw new Error(message)
  }

  return (await response.json()) as T
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

export function fetchWorkpiece(
  lineName: string,
  fileName: string
): Promise<ApiWorkpieceResponse> {
  return fetchJson<ApiWorkpieceResponse>(
    `/api/workpiece/${enc(lineName)}/${enc(fileName)}`
  )
}

export function isApiError(
  value: ApiWorkpieceResponse
): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  )
}

export function fetchTaskEventStations(
  lineName: string,
  workpieceId: string
): Promise<ApiTaskEventStationsResponse> {
  return fetchJson<ApiTaskEventStationsResponse>(
    `/api/task-events/${enc(lineName)}/${enc(workpieceId)}`
  )
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
    `/api/task-events/${enc(lineName)}/${enc(workpieceId)}/${enc(stationName)}${
      qs ? `?${qs}` : ""
    }`
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

export function fetchApiState(
  input?: FetchApiStateInput
): Promise<ApiStateResponse> {
  const signal = input && "aborted" in input ? input : input?.signal
  return fetchJson<ApiStateResponse>("/api/state", { signal })
}

export const fetchGlobalState = fetchApiState
export const fetchDashboardState = fetchApiState

export function getLineKanban(lineName: string): Promise<KanbanState> {
  return fetchJson<KanbanState>(`/api/line/${enc(lineName)}/kanban`)
}

export const fetchKanbanState = getLineKanban

export function getDoneKanbanCards(
  lineName: string,
  offset: number,
  limit: number
): Promise<ApiKanbanDoneResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  })
  return fetchJson<ApiKanbanDoneResponse>(
    `/api/line/${enc(lineName)}/kanban/done?${params.toString()}`
  )
}

export const fetchDoneCards = getDoneKanbanCards

export function releaseHeldTasks(
  lineName: string,
  body: { all: true } | { taskFile: string }
): Promise<ApiReleaseHeldResponse> {
  return fetchJson<ApiReleaseHeldResponse>(`/api/line/${enc(lineName)}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function releaseAllHeld(
  lineName: string
): Promise<ApiReleaseHeldResponse> {
  return releaseHeldTasks(lineName, { all: true })
}

export function releaseHeldTask(
  lineName: string,
  taskFile: string
): Promise<ApiReleaseHeldResponse> {
  return releaseHeldTasks(lineName, { taskFile })
}
