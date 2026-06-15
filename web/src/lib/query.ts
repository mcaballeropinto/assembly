import { QueryClient, queryOptions } from "@tanstack/react-query"

import { fetchApiState } from "./api"

export const API_STATE_QUERY_KEY = ["api", "state"] as const
export const API_STATE_REFETCH_INTERVAL_MS = 3000

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 0,
    },
  },
})

export function apiStateQueryOptions(
  overrides: Partial<{
    refetchInterval: number | false
    refetchOnWindowFocus: boolean
    retry: boolean | number
  }> = {}
) {
  return queryOptions({
    queryKey: API_STATE_QUERY_KEY,
    queryFn: ({ signal }) => fetchApiState(signal),
    staleTime: 0,
    refetchInterval: API_STATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
    ...overrides,
  })
}

export function lineKanbanQueryKey(lineName: string) {
  return ["line", lineName, "kanban"] as const
}

export function workpieceQueryKey(lineName?: string, fileName?: string) {
  return ["workpiece", lineName, fileName] as const
}
