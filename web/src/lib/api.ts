import type {
  ApiStateResponse,
  ApiTaskEventsResponse,
  ApiTaskEventStationsResponse,
  ApiWorkpieceResponse,
  ApiWorkpieceSidecarsResponse,
} from "../../../src/dashboard-api"

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
