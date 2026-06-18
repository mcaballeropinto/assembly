import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { createElement } from "react"
import { act } from "react-dom/test-utils"
import { createRoot } from "react-dom/client"

import { Shell } from "./shell"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}

afterEach(() => {
  document.body.innerHTML = ""
})

async function waitFor(assertion: () => void) {
  let error: unknown

  for (let index = 0; index < 20; index += 1) {
    try {
      assertion()
      return
    } catch (caught) {
      error = caught
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  throw error
}

describe("Shell", () => {
  test("renders full-width main gutters without a centered max-width cap", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
        },
      },
    })
    queryClient.setQueryData(["api", "state"], {
      timestamp: "2026-06-15T00:00:00.000Z",
      version: "test",
      totals: {
        lines: 0,
        linesRunning: 0,
        linesErrored: 0,
        totalInbox: 0,
        totalDone: 0,
        totalErrors: 0,
        totalReview: 0,
        totalCostUsd: 0,
        totalThroughput1h: 0,
        totalThroughput24h: 0,
      },
      lines: [],
    })
    queryClient.setQueryData(["api", "usage"], {
      state: "unknown",
      providers: {},
      threshold: 75,
      ageMs: 0,
    })
    const routeTree = createRootRoute({
      component: () =>
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Shell, null, createElement("span", null, "Overview")),
        ),
    })
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(createElement(RouterProvider, { router }))
    })

    await waitFor(() => {
      expect(container.querySelector("main")).not.toBeNull()
    })

    const main = container.querySelector("main")?.className

    act(() => {
      root.unmount()
    })
    queryClient.clear()

    expect(main).toContain("w-full")
    expect(main).toContain("px-4")
    expect(main).toContain("sm:px-6")
    expect(main).toContain("lg:px-8")
    expect(main).toContain("2xl:px-10")
    expect(main).not.toContain("max-w-screen-2xl")
    expect(main).not.toContain("mx-auto")
  })
})
