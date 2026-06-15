import { describe, expect, test } from "bun:test"

import {
  clampPercent,
  findSoonestReset,
  formatLastUpdate,
  formatResetShort,
} from "./dashboard-format"

describe("dashboard format helpers", () => {
  test("clamps invalid and out-of-range percentages", () => {
    expect(clampPercent(Number.NaN)).toBe(0)
    expect(clampPercent(-12)).toBe(0)
    expect(clampPercent(42.3)).toBe(42.3)
    expect(clampPercent(120)).toBe(100)
  })

  test("formats connection freshness labels", () => {
    expect(formatLastUpdate(null)).toBe("not connected")
    expect(formatLastUpdate(-1)).toBe("not connected")
    expect(formatLastUpdate(250)).toBe("just now")
    expect(formatLastUpdate(12_000)).toBe("12s ago")
    expect(formatLastUpdate(120_000)).toBe("2m ago")
  })

  test("formats past and invalid reset labels", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")

    expect(formatResetShort(null, now)).toBe("reset unknown")
    expect(formatResetShort("not-a-date", now)).toBe("reset unknown")
    expect(formatResetShort("2025-12-31T23:59:00.000Z", now)).toBe("resets now")
  })

  test("formats future reset labels", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")

    expect(formatResetShort("2026-01-01T00:00:30.000Z", now)).toBe("resets <1m")
    expect(formatResetShort("2026-01-01T00:12:00.000Z", now)).toBe("resets 12m")
    expect(formatResetShort("2026-01-01T02:15:00.000Z", now)).toBe("resets 2h 15m")
    expect(formatResetShort("2026-01-03T03:00:00.000Z", now)).toBe("resets 2d 3h")
  })

  test("finds the earliest valid reset", () => {
    expect(
      findSoonestReset([
        { resets_at: null },
        { resets_at: "not-a-date" },
        { resets_at: "2026-01-01T03:00:00.000Z" },
        { resets_at: "2026-01-01T01:00:00.000Z" },
      ])
    ).toBe("2026-01-01T01:00:00.000Z")
  })
})
