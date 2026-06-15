import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

import type { ApiStateLineEntry } from "../../lib/api"

import {
  deriveStationStatus,
  LineSummaryGrid,
  lineHref,
  queueCountsForLine,
} from "./line-summary-grid"

const runningLine: ApiStateLineEntry = {
  name: "assembly-dev",
  path: "/tmp/assembly-dev",
  status: "running",
  startedAt: "2026-06-15T00:00:00.000Z",
  state: {
    line: "assembly-dev",
    sequence: ["plan", "develop", "review"],
    lineQueue: {
      inbox: 2,
      done: 11,
      error: 4,
      errorActive: 3,
      review: 5,
    },
    held: [
      {
        fileName: "held.json",
        task: "Held task",
      },
    ],
    sections: {
      plan: { inbox: 0, processing: 1, output: 0, done_total: 7 },
      develop: { inbox: 2, processing: 0, output: 0, done_total: 3 },
      review: { inbox: 0, processing: 0, output: 0, done_total: 1 },
    },
    stationTimings: {
      plan: {
        started_at: "2026-06-15T00:00:00.000Z",
        running: true,
      },
    },
    activity: [],
    completed: [],
    errors: [],
    errorsDismissed: [],
    timestamp: "2026-06-15T00:00:00.000Z",
  },
}

const errorLine: ApiStateLineEntry = {
  name: "failed line",
  path: "/tmp/failed-line",
  status: "error",
  error: "Could not read line",
  startedAt: "2026-06-15T00:00:00.000Z",
  state: null,
}

describe("LineSummaryGrid", () => {
  test("renders linked line cards with status, queue counts, and station chips", () => {
    const markup = renderToString(
      createElement(LineSummaryGrid, { lines: [runningLine, errorLine] }),
    )

    expect(markup).toContain("grid-cols-1")
    expect(markup).toContain("md:grid-cols-2")
    expect(markup).toContain("xl:grid-cols-3")
    expect(markup).toContain("gap-4")
    expect(markup).toContain("p-6")
    expect(markup).toContain('href="/line/assembly-dev"')
    expect(markup).toContain("assembly-dev")
    expect(markup).toContain("failed line")
    expect(markup).toContain("running")
    expect(markup).toContain("error")
    expect(markup).toContain("Inbox")
    expect(markup).toContain("Done")
    expect(markup).toContain("Errors")
    expect(markup).toContain("Review")
    expect(markup).toContain("Held")
    expect(markup).toContain(">2<")
    expect(markup).toContain(">11<")
    expect(markup).toContain(">3<")
    expect(markup).toContain(">5<")
    expect(markup).toContain(">1<")
    expect(markup).toContain("plan")
    expect(markup).toContain("develop")
    expect(markup).toContain("review")
    expect(markup).toContain("bg-emerald-600")
    expect(markup).toContain("bg-amber-600")
  })

  test("exports deterministic helpers", () => {
    expect(lineHref("line with spaces")).toBe("/line/line%20with%20spaces")
    expect(queueCountsForLine(runningLine)).toEqual({
      inbox: 2,
      done: 11,
      errors: 3,
      review: 5,
      held: 1,
    })
    expect(deriveStationStatus(runningLine, "plan")).toBe("running")
    expect(deriveStationStatus(runningLine, "develop")).toBe("blocked")
    expect(deriveStationStatus(runningLine, "review")).toBe("idle")
    expect(deriveStationStatus(errorLine, "plan")).toBe("errored")
    expect(deriveStationStatus(runningLine, "missing")).toBe("muted")
  })

  test("renders an empty state", () => {
    const markup = renderToString(createElement(LineSummaryGrid, { lines: [] }))

    expect(markup).toContain("No lines discovered.")
    expect(markup).toContain("p-6")
  })
})
