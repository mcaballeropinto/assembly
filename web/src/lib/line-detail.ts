import type { ApiLineStateResponse } from "./api"
import { formatDuration, formatTaskPreview } from "./dashboard-format"

type RecordValue = Record<string, unknown>

export interface LineWorkpieceRecord {
  id: string
  fileName: string
  task: string
  taskPreview: string
  source: "held" | "completed" | "error" | "dismissed" | "review"
  outcome?: string
  finishedAt?: string
  durationLabel?: string
  failedStation?: string
  error?: string
  dismissedAt?: string
  escalatedStation?: string
}

export interface StationSequenceRow {
  name: string
  inbox: number
  processing: number
  output: number
  doneTotal: number
  state: "running" | "queued" | "idle" | "done"
  freshnessLabel?: string
  progress?: string
}

export function isLineStateError(
  value: ApiLineStateResponse | undefined,
): value is { error: string } {
  return Boolean(value && "error" in value && typeof value.error === "string")
}

export function normalizeHeld(
  held: unknown,
): LineWorkpieceRecord[] {
  if (!Array.isArray(held)) return []

  return held.flatMap((item) => {
    if (!isRecord(item)) return []
    const fileName = stringField(item.fileName)
    if (!fileName) return []
    const task = stringField(item.task) ?? ""

    return [{
      id: fileName.replace(/\.json$/, ""),
      fileName,
      task,
      taskPreview: formatTaskPreview(task),
      source: "held" as const,
    }]
  })
}

export function normalizeCompleted(
  completed: unknown,
): LineWorkpieceRecord[] {
  return normalizeWorkpieces(completed, "completed")
}

export function normalizeErrors(
  errors: unknown,
  source: "error" | "dismissed" = "error",
): LineWorkpieceRecord[] {
  return normalizeWorkpieces(errors, source)
}

export function normalizeReviews(reviews: unknown): LineWorkpieceRecord[] {
  if (!Array.isArray(reviews)) return []

  return reviews.flatMap((item) => {
    if (!isRecord(item)) return []
    const fileName = stringField(item.fileName)
    const id = stringField(item.id) ?? fileName?.replace(/\.json$/, "")
    if (!fileName || !id) return []
    const task = stringField(item.task) ?? ""
    const escalated = Array.isArray(item.escalated) ? item.escalated : []
    const firstEscalated = escalated.find(isRecord)

    return [{
      id,
      fileName,
      task,
      taskPreview: formatTaskPreview(task),
      source: "review" as const,
      escalatedStation: firstEscalated
        ? stringField(firstEscalated.station)
        : undefined,
      error: firstEscalated ? stringField(firstEscalated.feedback) : undefined,
    }]
  })
}

export function mergeCompletedWithFailed(
  completed: LineWorkpieceRecord[],
  failed: LineWorkpieceRecord[],
): LineWorkpieceRecord[] {
  const completedFiles = new Set(completed.map((item) => item.fileName))
  return [
    ...failed.filter((item) => !completedFiles.has(item.fileName)),
    ...completed,
  ]
}

export function stationSequenceRows(
  state: Extract<ApiLineStateResponse, { line: string }>,
): StationSequenceRow[] {
  return state.sequence.map((name) => {
    const section = state.sections?.[name] ?? {}
    const timing = state.stationTimings?.[name]
    const freshness = state.stationFreshness?.[name]
    const inbox = numberField(section.inbox)
    const processing = numberField(section.processing)
    const output = numberField(section.output)
    const doneTotal = numberField(section.done_total)
    const running = Boolean(timing?.running) || processing > 0
    const queued = inbox > 0 || output > 0

    return {
      name,
      inbox,
      processing,
      output,
      doneTotal,
      state: running ? "running" : queued ? "queued" : doneTotal > 0 ? "done" : "idle",
      freshnessLabel: freshness?.label,
      progress: timing?.latestProgress?.detail,
    }
  })
}

export function historyQueryDefaults(): {
  limit: number
  include: Array<"done" | "error">
} {
  return { limit: 10, include: ["done"] }
}

function normalizeWorkpieces(
  items: unknown,
  source: "completed" | "error" | "dismissed",
): LineWorkpieceRecord[] {
  if (!Array.isArray(items)) return []

  return items.flatMap((item) => {
    if (!isRecord(item)) return []
    const fileName = stringField(item.fileName)
    const id = stringField(item.id) ?? fileName?.replace(/\.json$/, "")
    if (!fileName || !id) return []
    const task = stringField(item.task) ?? ""
    const failed = firstFailed(item)

    return [{
      id,
      fileName,
      task,
      taskPreview: formatTaskPreview(task),
      source,
      outcome: source === "completed" ? stringField(item.outcome) ?? "success" : "failed",
      finishedAt: stringField(item.finished_at),
      durationLabel: formatDuration(numberField(item.duration_ms)),
      failedStation: failed?.station,
      error: failed?.error,
      dismissedAt: stringField(item.dismissed_at),
    }]
  })
}

function firstFailed(item: RecordValue): { station?: string; error?: string } | undefined {
  const failed = Array.isArray(item.failed) ? item.failed.find(isRecord) : undefined
  if (failed) {
    return {
      station: stringField(failed.station),
      error: stringField(failed.error),
    }
  }

  const stations = isRecord(item.stations) ? item.stations : {}
  for (const [station, value] of Object.entries(stations)) {
    if (!isRecord(value)) continue
    if (value.status === "failed" || value.status === "escalated") {
      return {
        station,
        error: stringField(value.error) ?? stringField(value.summary),
      }
    }
  }

  return undefined
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
