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

export function apiStateQueryOptions() {
  return queryOptions({
    queryKey: API_STATE_QUERY_KEY,
    queryFn: ({ signal }) => fetchApiState(signal),
    staleTime: 0,
    refetchInterval: API_STATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  })
}
