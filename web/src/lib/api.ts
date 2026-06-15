import type {
  ApiStateResponse,
  ApiTaskEventsResponse,
  ApiTaskEventStationsResponse,
  ApiWorkpieceResponse,
  ApiWorkpieceSidecarsResponse,
  KanbanCard,
  KanbanState,
} from "../../../src/dashboard-api"

export type {
  KanbanLane,
  KanbanCardState,
  KanbanCard,
  KanbanColumn,
  StationFreshnessState,
  StationFreshness,
  StationStatusState,
  StationStatus,
  StationTooltipMeta,
  KanbanState,
} from "../../../src/dashboard-api"

export interface ApiErrorResponse {
  error: string
}

export type ApiKanbanResponse = KanbanState | ApiErrorResponse

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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const json = (await res.json().catch(() => null)) as
    | T
    | ApiErrorResponse
    | null

  if (!res.ok) {
    const detail =
      json && typeof json === "object" && "error" in json
        ? `: ${String(json.error)}`
        : ""
    throw new Error(`Request failed (${res.status})${detail}`)
  }

  if (json && typeof json === "object" && "error" in json) {
    throw new Error(String(json.error))
  }

  return json as T
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
