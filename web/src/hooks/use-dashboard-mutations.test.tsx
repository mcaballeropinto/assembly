import { afterEach, describe, expect, test } from "bun:test"

import type { ApiStateResponse } from "@/lib/api"
import {
  dismissErrors,
  retryWorkpiece,
  undismissErrors,
} from "@/lib/api"
import {
  optimisticallyDismissErrors,
  optimisticallyUndismissErrors,
} from "./use-dashboard-mutations"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function state(): ApiStateResponse {
  return {
    lines: [
      {
        name: "assembly-dev",
        path: "/tmp/assembly-dev",
        status: "running",
        startedAt: "2026-06-15T12:00:00.000Z",
        state: {
          line: "assembly-dev",
          sequence: ["plan"],
          lineQueue: {
            inbox: 0,
            done: 0,
            error: 2,
            errorActive: 1,
            review: 0,
          },
          held: [],
          sections: {},
          activity: [],
          completed: [],
          errors: [{ id: "wp-1", fileName: "wp-1.json", task: "Fix one" }],
          banner_errors: [{ id: "wp-1", fileName: "wp-1.json" }],
          errors_meta: {
            total_active: 1,
            in_banner: 1,
            oldest_in_banner_age_ms: 0,
            max_banner_age_ms: 1,
          },
          errorsDismissed: [
            {
              id: "wp-2",
              fileName: "wp-2.json",
              dismissed_at: "2026-06-15T11:00:00.000Z",
            },
          ],
          timestamp: "2026-06-15T12:00:00.000Z",
        },
      },
    ],
    totals: {
      lines: 1,
      linesRunning: 1,
      linesErrored: 0,
      totalInbox: 0,
      totalDone: 0,
      totalErrors: 1,
      totalReview: 0,
      totalCostUsd: 0,
      totalThroughput1h: 0,
      totalThroughput24h: 0,
    },
    timestamp: "2026-06-15T12:00:00.000Z",
    version: "test",
  }
}

describe("dashboard mutation API helpers", () => {
  test("post exact dismiss, undismiss, and retry endpoint payloads", async () => {
    const calls: Array<{ url: string; body?: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") })
      return Response.json({ dismissed: {}, ok: true, newId: "wp-3", newFileName: "wp-3.json" })
    }) as typeof fetch

    await dismissErrors("assembly dev", ["wp-1.json"])
    await undismissErrors("assembly dev", ["wp-2.json"])
    await retryWorkpiece("assembly dev", "wp-1.json")

    expect(calls).toEqual([
      {
        url: "/api/line/assembly%20dev/errors/dismiss",
        body: JSON.stringify({ fileNames: ["wp-1.json"] }),
      },
      {
        url: "/api/line/assembly%20dev/errors/undismiss",
        body: JSON.stringify({ fileNames: ["wp-2.json"] }),
      },
      {
        url: "/api/line/assembly%20dev/retry",
        body: JSON.stringify({ fileName: "wp-1.json" }),
      },
    ])
  })
})

describe("optimistic dashboard error movement", () => {
  test("dismiss moves an active error into dismissed and recalculates counters", () => {
    const next = optimisticallyDismissErrors(
      state(),
      "assembly-dev",
      ["wp-1.json"],
      "2026-06-15T12:30:00.000Z"
    )
    const line = next.lines[0]?.state

    expect(line?.errors).toEqual([])
    expect(line?.errorsDismissed[0]).toMatchObject({
      fileName: "wp-1.json",
      dismissed_at: "2026-06-15T12:30:00.000Z",
    })
    expect(line?.lineQueue.errorActive).toBe(0)
    expect(next.totals.totalErrors).toBe(0)
    expect(line?.banner_errors).toEqual([])
  })

  test("undismiss moves a dismissed error back to active and recalculates counters", () => {
    const next = optimisticallyUndismissErrors(state(), "assembly-dev", [
      "wp-2.json",
    ])
    const line = next.lines[0]?.state

    expect(line?.errors[0]).toMatchObject({ fileName: "wp-2.json" })
    expect(line?.errorsDismissed).toHaveLength(0)
    expect(line?.lineQueue.errorActive).toBe(2)
    expect(next.totals.totalErrors).toBe(2)
  })
})
