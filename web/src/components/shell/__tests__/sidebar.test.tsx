import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react-dom/test-utils"
import { createRoot } from "react-dom/client"

import {
  SIDEBAR_COLLAPSE_STORAGE_KEY,
  STATE_REFETCH_INTERVAL_MS,
  Sidebar,
} from "../sidebar"

import type { ApiStateResponse } from "../../../../../src/dashboard-api"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}

function createApiState(lines: ApiStateResponse["lines"]): ApiStateResponse {
  return {
    lines,
    totals: {
      lines: lines.length,
      linesRunning: lines.filter((line) => line.status === "running").length,
      linesErrored: lines.filter((line) => line.status === "error").length,
      totalInbox: lines.reduce(
        (total, line) => total + (line.state?.lineQueue.inbox ?? 0),
        0,
      ),
      totalDone: 0,
      totalErrors: 0,
      totalReview: 0,
      totalCostUsd: 0,
      totalThroughput1h: 0,
      totalThroughput24h: 0,
    },
    timestamp: "2026-06-15T00:00:00.000Z",
    version: "2026.05.24",
  }
}

function createLine(
  name: string,
  status: "running" | "error",
  inbox: number,
): ApiStateResponse["lines"][number] {
  return {
    name,
    path: `/tmp/${name}`,
    status,
    startedAt: "2026-06-15T00:00:00.000Z",
    state: {
      line: name,
      sequence: [],
      lineQueue: {
        inbox,
        done: 0,
        error: 0,
        errorActive: 0,
        review: 0,
      },
      held: [],
      sections: {},
      activity: [],
      completed: [],
      errors: [],
      errorsDismissed: [],
      timestamp: "2026-06-15T00:00:00.000Z",
    },
  }
}

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Sidebar />
      </QueryClientProvider>,
    )
  })

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      queryClient.clear()
      container.remove()
    },
  }
}

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

afterEach(() => {
  document.body.innerHTML = ""
  localStorage.clear()
})

describe("Sidebar", () => {
  test("uses a thirty second state refetch interval", () => {
    expect(STATE_REFETCH_INTERVAL_MS).toBe(30000)
  })

  test("renders discovered lines and inbox counts", async () => {
    const apiState = createApiState([
      createLine("operator", "error", 3),
      createLine("assembly-dev", "running", 7),
    ])
    const fetchMock = async (input: RequestInfo | URL) => {
      expect(input).toBe("/api/state")
      return new Response(JSON.stringify(apiState), { status: 200 })
    }
    globalThis.fetch = fetchMock as typeof fetch

    const screen = renderSidebar()

    await waitFor(() => {
      expect(screen.container.textContent).toContain("assembly-dev")
      expect(screen.container.textContent).toContain("operator")
      expect(screen.container.textContent).toContain("7")
      expect(screen.container.textContent).toContain("3")
    })

    screen.unmount()
  })

  test("persists collapsed state and hides expanded labels", async () => {
    const apiState = createApiState([createLine("assembly-dev", "running", 7)])
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(apiState), { status: 200 })) as typeof fetch

    const screen = renderSidebar()

    await waitFor(() => {
      expect(screen.container.textContent).toContain("assembly-dev")
    })

    const button = screen.container.querySelector(
      'button[aria-label="Collapse sidebar"]',
    )
    expect(button).not.toBeNull()

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    await waitFor(() => {
      expect(localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY)).toBe("true")
      expect(screen.container.textContent).not.toContain("assembly-dev")
      expect(
        screen.container.querySelector('a[aria-label="assembly-dev"]'),
      ).not.toBeNull()
    })

    screen.unmount()
  })

  test("renders an empty state", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(createApiState([])), {
        status: 200,
      })) as typeof fetch

    const screen = renderSidebar()

    await waitFor(() => {
      expect(screen.container.textContent).toContain("No lines")
    })

    screen.unmount()
  })

  test("renders a fetch failure", async () => {
    globalThis.fetch = (async () =>
      new Response("Nope", { status: 500 })) as typeof fetch

    const screen = renderSidebar()

    await waitFor(() => {
      expect(screen.container.textContent).toContain("Unable to load lines")
    })

    screen.unmount()
  })
})
