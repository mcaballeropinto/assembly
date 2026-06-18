import { describe, expect, test } from "bun:test"

import {
  mergeCompletedWithFailed,
  normalizeCompleted,
  normalizeErrors,
  normalizeHeld,
  normalizeReviews,
  stationSequenceRows,
} from "./line-detail"

describe("line detail normalization", () => {
  test("skips malformed records safely", () => {
    expect(normalizeHeld([null, {}, { fileName: "a.json", task: "Ship it" }])).toEqual([
      expect.objectContaining({ fileName: "a.json", taskPreview: "Ship it" }),
    ])
    expect(normalizeCompleted([{}, { id: "done-1", fileName: "done-1.json", task: "" }])).toHaveLength(1)
    expect(normalizeErrors("bad")).toEqual([])
    expect(normalizeReviews([{ fileName: "review.json", id: "review", escalated: [] }])).toHaveLength(1)
  })

  test("prepends failed items ahead of completed items", () => {
    const completed = normalizeCompleted([{ id: "done", fileName: "done.json" }])
    const failed = normalizeErrors([{ id: "fail", fileName: "fail.json" }])

    expect(mergeCompletedWithFailed(completed, failed).map((item) => item.fileName)).toEqual([
      "fail.json",
      "done.json",
    ])
  })

  test("truncates task previews and derives station rows", () => {
    const longTask = `${"x".repeat(120)} trailing`
    const [error] = normalizeErrors([{ id: "err", fileName: "err.json", task: longTask }])
    expect(error.taskPreview.length).toBeLessThanOrEqual(100)

    const rows = stationSequenceRows({
      line: "demo",
      sequence: ["plan", "build"],
      lineQueue: { inbox: 0, done: 0, error: 0, errorActive: 0, review: 0 },
      held: [],
      sections: {
        plan: { inbox: 0, processing: 1, output: 0, done_total: 0 },
        build: { inbox: 2, processing: 0, output: 0, done_total: 3 },
      },
      stationTimings: { plan: { started_at: "2026-06-18T00:00:00Z", running: true } },
      stationFreshness: {},
      pipelineTotalMs: null,
      activity: [],
      completed: [],
      errors: [],
      banner_errors: [],
      errors_meta: { total_active: 0, in_banner: 0, oldest_in_banner_age_ms: 0, max_banner_age_ms: 0 },
      errorsDismissed: [],
      reviews: [],
      triggers: [],
      health: { state: "processing", count: 1, detail: "Running" },
      sessionTotals: {
        tokens_in: 0,
        tokens_out: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0,
        workpieces: 0,
        byStation: {},
      },
      throughput: { last_1h: 0, last_24h: 0 },
      timestamp: "2026-06-18T00:00:00Z",
    })

    expect(rows.map((row) => row.state)).toEqual(["running", "queued"])
  })
})
