import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

import type { ActivityFilterKey } from "../lib/activity"
import type { ApiStateResponse } from "../lib/api"

type QueryResult = {
  data?: ApiStateResponse
  isPending: boolean
  error: Error | null
}

type ActivityFeedProps = {
  items: unknown[]
  selectedFilters: Set<ActivityFilterKey>
  onSelectedFiltersChange: (next: Set<ActivityFilterKey>) => void
  title?: string
  totalItems?: number
}

let queryResult: QueryResult
let lastQueryOptions: unknown
let lastFeedProps: ActivityFeedProps | undefined

mock.module("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {
    options: unknown

    constructor(options: unknown) {
      this.options = options
    }

    getDefaultOptions() {
      return (this.options as { defaultOptions?: unknown }).defaultOptions
    }
  },
  queryOptions: (options: unknown) => options,
  useQuery: (options: unknown) => {
    lastQueryOptions = options
    return queryResult
  },
}))

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

describe("OverviewRoute", () => {
  beforeEach(() => {
    installWindow()
    queryResult = {
      data: stateFixture,
      isPending: false,
      error: null,
    }
    lastQueryOptions = undefined
    lastFeedProps = undefined
  })

  test("renders the overview shell from live state totals and lines", async () => {
    const { OverviewRoute } = await import("./index")
    const markup = renderToString(createElement(OverviewRoute))

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
    expect(lastQueryOptions).toEqual(
      expect.objectContaining({
        queryKey: ["api", "state"],
        refetchInterval: 3000,
      }),
    )
  })

  test("preserves activity URL filter parsing and serialization", async () => {
    installWindow("?activity=error")
    const { OverviewRoute } = await import("./index")

    renderToString(createElement(OverviewRoute))

    expect(lastFeedProps?.items).toHaveLength(1)
    expect(lastFeedProps?.selectedFilters).toEqual(new Set(["error"]))

    lastFeedProps?.onSelectedFiltersChange(new Set(["trigger"]))

    expect(window.location.search).toBe("?activity=trigger")
  })

  test("renders the error branch", async () => {
    queryResult = {
      isPending: false,
      error: new Error("Nope"),
    }
    const { OverviewRoute } = await import("./index")
    const markup = renderToString(createElement(OverviewRoute))

    expect(markup).toContain("Failed to load dashboard state")
    expect(markup).toContain("Nope")
  })
})
