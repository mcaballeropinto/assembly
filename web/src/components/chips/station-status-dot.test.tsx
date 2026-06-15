import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"

import type { StationStatusState } from "../../../../src/dashboard-api"

import { StationStatusDot } from "./station-status-dot"

const expectedClasses: Record<StationStatusState, string> = {
  running: "bg-emerald-600",
  idle: "bg-muted-foreground",
  blocked: "bg-amber-600",
  errored: "bg-destructive",
  muted: "bg-muted-foreground/35",
}

describe("StationStatusDot", () => {
  test("renders an accessible 8px semantic dot for every state", () => {
    for (const state of Object.keys(expectedClasses) as StationStatusState[]) {
      const markup = renderToString(
        <StationStatusDot state={state} label={`${state} status`} />,
      )

      expect(markup).toContain('role="img"')
      expect(markup).toContain(`aria-label="${state} status"`)
      expect(markup).toContain("h-2")
      expect(markup).toContain("w-2")
      expect(markup).toContain("rounded-full")
      expect(markup).toContain(expectedClasses[state])
    }
  })
})
