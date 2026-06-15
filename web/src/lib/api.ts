import type { ApiStateResponse } from "../../../src/dashboard-api"

export async function fetchApiState(): Promise<ApiStateResponse> {
  const response = await fetch("/api/state")

  if (!response.ok) {
    throw new Error(`Failed to fetch /api/state: ${response.status}`)
  }

  return (await response.json()) as ApiStateResponse
}
