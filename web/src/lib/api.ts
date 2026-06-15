import type { ApiStateResponse } from "../../../src/dashboard-api"

type FetchApiStateInput = AbortSignal | { signal?: AbortSignal }

export async function fetchApiState(
  input?: FetchApiStateInput,
): Promise<ApiStateResponse> {
  const signal = input && "aborted" in input ? input : input?.signal
  const response = await fetch("/api/state", { signal })

  if (!response.ok) {
    throw new Error(`Failed to fetch /api/state: ${response.status}`)
  }

  return (await response.json()) as ApiStateResponse
}
