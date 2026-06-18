import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

import type { ApiStateTotals } from "../../lib/api"

import { buildKpiItems, KpiStrip } from "./kpi-strip"

const totals: ApiStateTotals = {
  lines: 3,
  linesRunning: 2,
  linesErrored: 1,
  totalInbox: 12,
  totalDone: 3456,
  totalErrors: 7,
  totalReview: 8,
  totalCostUsd: 9.5,
  totalThroughput1h: 4,
  totalThroughput24h: 1234,
}

describe("KpiStrip", () => {
  test("renders the exact responsive grid and live total KPI items", () => {
    const markup = renderToString(createElement(KpiStrip, { totals }))

    expect(markup).toContain("grid")
    expect(markup).toContain("grid-cols-2")
    expect(markup).toContain("md:grid-cols-4")
    expect(markup).toContain("xl:grid-cols-8")
    expect(markup).toContain("gap-4")
    expect(markup).toContain("Lines")
    expect(markup).toContain("Done")
    expect(markup).toContain("Running")
    expect(markup).toContain("Incoming")
    expect(markup).toContain("Errors")
    expect(markup).toContain("Review")
    expect(markup).toContain("Recent Cost")
    expect(markup).toContain("Throughput")
    expect(markup).toContain("2")
    expect(markup).toContain("$9.50")
    expect(markup).toContain("1,234")
  })

  test("builds the eight overview KPIs in the required order", () => {
    expect(buildKpiItems(totals).map((item) => item.label)).toEqual([
      "Lines",
      "Running",
      "Incoming",
      "Done",
      "Errors",
      "Review",
      "Recent Cost",
      "Throughput",
    ])
  })
})
