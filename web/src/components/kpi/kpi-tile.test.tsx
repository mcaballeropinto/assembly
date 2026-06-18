import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { renderToString } from "react-dom/server"

import { KpiTile } from "./kpi-tile"

describe("KpiTile", () => {
  test("renders the locked card, label, and value typography classes", () => {
    const markup = renderToString(<KpiTile label="Queued" value="42" />)

    expect(markup).toContain("p-4")
    expect(markup).toContain("text-sm")
    expect(markup).toContain("font-medium")
    expect(markup).toContain("text-muted-foreground")
    expect(markup).toContain("text-2xl")
    expect(markup).toContain("font-semibold")
    expect(markup).toContain("tabular-nums")
    expect(markup).toContain("Queued")
    expect(markup).toContain("42")
  })

  test("renders trend states with semantic classes", () => {
    const up = renderToString(
      <KpiTile label="Up" value="10" trend={{ direction: "up", value: "+3%" }} />,
    )
    const down = renderToString(
      <KpiTile label="Down" value="4" trend={{ direction: "down", value: "-2" }} />,
    )
    const neutral = renderToString(
      <KpiTile
        label="Neutral"
        value="8"
        trend={{ direction: "neutral", value: "flat" }}
      />,
    )

    expect(up).toContain("text-emerald-600")
    expect(down).toContain("text-destructive")
    expect(neutral).toContain("text-muted-foreground")
  })

  test("uses Tremor SparkLineChart and no manual svg markup", () => {
    const source = readFileSync(
      new URL("./kpi-tile.tsx", import.meta.url),
      "utf8",
    )

    expect(source).toContain('@tremor/react"')
    expect(source).toContain("SparkLineChart")
    expect(source).not.toContain("<svg")
  })
})
