import { describe, expect, test } from "bun:test"

import {
  API_STATE_QUERY_KEY,
  API_STATE_REFETCH_INTERVAL_MS,
  apiStateQueryOptions,
  queryClient,
} from "../lib/query"

describe("query configuration", () => {
  test("keeps global query defaults non-polling", () => {
    const defaults = queryClient.getDefaultOptions().queries

    expect(defaults?.staleTime).toBe(0)
    expect(defaults?.refetchOnWindowFocus).toBe(true)
    expect(defaults?.refetchInterval).toBeUndefined()
  })

  test("polls /api/state every three seconds", () => {
    const options = apiStateQueryOptions()

    expect(options.queryKey).toEqual(API_STATE_QUERY_KEY)
    expect(options.staleTime).toBe(0)
    expect(options.refetchInterval).toBe(API_STATE_REFETCH_INTERVAL_MS)
    expect(options.refetchOnWindowFocus).toBe(true)
  })
})
