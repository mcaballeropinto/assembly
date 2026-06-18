import { describe, expect, test } from "bun:test"

import {
  assertTtiBudget,
  measureJsAssets,
  parseInteractiveMs,
} from "./performance-budget"

describe("dashboard performance budget", () => {
  test("passes and fails JS gzip budgets", () => {
    const passing = measureJsAssets([{ path: "a.js", content: "console.log(1)" }], 1000)
    expect(passing.pass).toBe(true)

    const failing = measureJsAssets([{ path: "big.js", content: "x".repeat(1000) }], 10)
    expect(failing.pass).toBe(false)
    expect(failing.assets[0].gzipBytes).toBeGreaterThan(10)
  })

  test("parses and enforces Lighthouse interactive timing", () => {
    const tti = parseInteractiveMs(JSON.stringify({
      audits: { interactive: { numericValue: 1750 } },
    }))
    expect(assertTtiBudget(tti, 2000).pass).toBe(true)
    expect(assertTtiBudget(2500, 2000).pass).toBe(false)
    expect(assertTtiBudget(null, 2000).pass).toBe(false)
  })
})
