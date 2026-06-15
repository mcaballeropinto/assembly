import { beforeEach, describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

import type { ReactElement } from "react"
import type { ActivityFilterKey } from "../lib/activity"
import type { ApiStateResponse } from "../lib/api"
import { apiStateQueryOptions } from "../lib/query"

type ActivityFeedProps = {
  items: unknown[]
  selectedFilters: Set<ActivityFilterKey>
  onSelectedFiltersChange: (next: Set<ActivityFilterKey>) => void
  title?: string
  totalItems?: number
}

let lastFeedProps: ActivityFeedProps | undefined

mock.module("../components/ui/activity-feed", () => ({
  ActivityFeed: (props: ActivityFeedProps) => {
    lastFeedProps = props

    return createElement(
      "section",
      { "data-testid": "activity-feed" },
      createElement("h2", null, props.title),
      createElement("p", null, `${props.items.length} of ${props.totalItems}`),
      createElement("p", null, Array.from(props.selectedFilters).join(",")),
    )
  },
}))

const stateFixture: ApiStateResponse = {
  timestamp: "2026-06-15T00:00:00.000Z",
  version: "test",
  totals: {
    lines: 2,
    linesRunning: 1,
    linesErrored: 1,
    totalInbox: 12,
    totalDone: 34,
    totalErrors: 2,
    totalReview: 3,
    totalCostUsd: 4.5,
    totalThroughput1h: 6,
    totalThroughput24h: 78,
  },
  lines: [
    {
      name: "assembly-dev",
      path: "/tmp/assembly-dev",
      status: "running",
      startedAt: "2026-06-15T00:00:00.000Z",
      state: {
        line: "assembly-dev",
        sequence: ["plan"],
        lineQueue: {
          inbox: 12,
          done: 34,
          error: 2,
          errorActive: 2,
          review: 3,
        },
        held: [],
        sections: {
          plan: { inbox: 0, processing: 1, output: 0, done_total: 0 },
        },
        activity: [
          {
            ts: "2026-06-15T00:02:00.000Z",
            event: "error_bucket",
            error: "Failed task",
          },
          {
            ts: "2026-06-15T00:01:00.000Z",
            event: "trigger_fired",
            source: "plan",
            target: "develop",
          },
        ],
        completed: [],
        errors: [],
        errorsDismissed: [],
        timestamp: "2026-06-15T00:00:00.000Z",
      },
    },
  ],
}

function installWindow(search = "") {
  const location = new URL(`http://localhost/${search}`)
  const windowValue = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        windowValue.location = new URL(url)
      },
    },
  }

  Object.defineProperty(globalThis, "window", {
    value: windowValue,
    configurable: true,
  })
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
      },
    },
  })
}

function renderOverviewRoute(
  OverviewRoute: () => ReactElement,
  options: { data?: ApiStateResponse; error?: Error } = { data: stateFixture },
) {
  const queryClient = createQueryClient()
  const queryOptions = apiStateQueryOptions()

  if (options.data) {
    queryClient.setQueryData(queryOptions.queryKey, options.data)
  }

  if (options.error) {
    queryClient.getQueryCache().build(queryClient, queryOptions, {
      data: undefined,
      dataUpdateCount: 0,
      dataUpdatedAt: 0,
      error: options.error,
      errorUpdateCount: 1,
      errorUpdatedAt: Date.now(),
      fetchFailureCount: 1,
      fetchFailureReason: options.error,
      fetchMeta: null,
      isInvalidated: false,
      status: "error",
      fetchStatus: "idle",
    })
  }

  const markup = renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(OverviewRoute),
    ),
  )
  queryClient.clear()

  return markup
}

describe("OverviewRoute", () => {
  beforeEach(() => {
    installWindow()
    lastFeedProps = undefined
  })

  test("renders the overview shell from live state totals and lines", async () => {
    const { OverviewRoute } = await import("./index")
    const markup = renderOverviewRoute(OverviewRoute)

    expect(markup).toContain("space-y-8")
    expect(markup).toContain("pt-6")
    expect(markup).toContain("pb-12")
    expect(markup).toContain("Lines")
    expect(markup).toContain("1/2")
    expect(markup).toContain("Inbox")
    expect(markup).toContain("12")
    expect(markup).toContain("$4.50")
    expect(markup).toContain("Throughput 24h")
    expect(markup).toContain("assembly-dev")
    expect(markup).toContain('href="/line/assembly-dev"')
    expect(markup).toContain("Activity")
    expect(markup).not.toContain("Chrome primitive mock wiring")
    expect(markup).not.toContain("It works")
  })

  test("preserves activity URL filter parsing and serialization", async () => {
    installWindow("?activity=error")
    const { OverviewRoute } = await import("./index")

    renderOverviewRoute(OverviewRoute)

    expect(lastFeedProps?.items).toHaveLength(1)
    expect(lastFeedProps?.selectedFilters).toEqual(new Set(["error"]))

    lastFeedProps?.onSelectedFiltersChange(new Set(["trigger"]))

    expect(window.location.search).toBe("?activity=trigger")
  })

  test("renders the error branch", async () => {
    const { OverviewRoute } = await import("./index")
    const markup = renderOverviewRoute(OverviewRoute, {
      error: new Error("Nope"),
    })

    expect(markup).toContain("Failed to load dashboard state")
    expect(markup).toContain("Nope")
  })
})
