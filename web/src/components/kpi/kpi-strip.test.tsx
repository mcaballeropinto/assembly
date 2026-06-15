import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"

import { KpiStrip } from "./kpi-strip"

describe("KpiStrip", () => {
  test("renders the exact responsive grid and its KPI items", () => {
    const markup = renderToString(
      <KpiStrip
        items={[
          { label: "Queued", value: "12" },
          { label: "Done", value: "34" },
        ]}
      />,
    )

    expect(markup).toContain("grid")
    expect(markup).toContain("grid-cols-2")
    expect(markup).toContain("md:grid-cols-4")
    expect(markup).toContain("xl:grid-cols-7")
    expect(markup).toContain("gap-4")
    expect(markup).toContain("Queued")
    expect(markup).toContain("Done")
  })
})
