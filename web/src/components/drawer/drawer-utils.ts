import type { ApiWorkpieceResponse, StationMeta, StationResult, StationRounds, Workpiece } from "@/lib/api"

export type StationEntry = [string, StationResult]
type WorkpieceData = Extract<ApiWorkpieceResponse, Workpiece>

export function sortStationEntries(stations: WorkpieceData["stations"]): StationEntry[] {
  return Object.entries(stations ?? {}).sort(([aName, a], [bName, b]) => {
    const aTime = Date.parse(a.started_at ?? "") || Number.MAX_SAFE_INTEGER
    const bTime = Date.parse(b.started_at ?? "") || Number.MAX_SAFE_INTEGER
    if (aTime !== bTime) return aTime - bTime
    return aName.localeCompare(bName)
  }) as StationEntry[]
}

export function sortStationMeta(stations: StationMeta[]): StationMeta[] {
  return [...stations].sort((a, b) => {
    const aTime = Date.parse(a.started_at ?? "") || Number.MAX_SAFE_INTEGER
    const bTime = Date.parse(b.started_at ?? "") || Number.MAX_SAFE_INTEGER
    if (aTime !== bTime) return aTime - bTime
    return a.name.localeCompare(b.name)
  })
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "duration unknown"
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const minuteRest = minutes % 60
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`
}

export function formatDuration(start?: string, finish?: string): string {
  if (!start) return "duration unknown"
  const endMs = finish ? Date.parse(finish) : Date.now()
  const startMs = Date.parse(start)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "duration unknown"
  return formatDurationMs(endMs - startMs)
}

export function formatTokens(n: number | null | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "0"
  return new Intl.NumberFormat(undefined, { notation: n >= 10000 ? "compact" : "standard" }).format(n)
}

export function formatCost(n: number | null | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "$0.00"
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
  }).format(n)
}

export function stationStatusClass(status?: string): string {
  switch (status) {
    case "done":
    case "ok":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
    case "failed":
    case "error":
    case "aborted":
    case "timeout":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    case "skipped":
    case "escalated":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
    case "running":
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300"
    default:
      return "border-border bg-muted text-muted-foreground"
  }
}

export function stationStatusVariant(status?: string): string {
  return stationStatusClass(status)
}

export function getWorkpieceOutcome(workpiece: WorkpieceData): {
  state: "failed" | "completed" | "active" | "held" | "review" | "inbox";
  failedStation?: string;
  summary?: string;
} {
  const failed = sortStationEntries(workpiece.stations).find(([, station]) => station.status === "failed")
  if (failed) return { state: "failed", failedStation: failed[0], summary: failed[1].summary }

  const source = workpiece._source ?? ""
  if (source === "done") return { state: "completed" }
  if (source === "review") return { state: "review" }
  if (source === "inbox" || source.endsWith(":inbox")) return { state: "inbox" }
  if (source.includes(":processing") || source.includes(":output")) return { state: "active" }
  if (source === "held") return { state: "held" }
  return { state: "active" }
}

export function formatRounds(rounds?: StationRounds): string {
  if (!rounds) return "no tool rounds"
  const tools = Object.entries(rounds.tools ?? {}).sort((a, b) => b[1] - a[1])
  const shown = tools.slice(0, 6).map(([name, count]) => `${name} ${count}`)
  const hidden = tools.slice(6).reduce((sum, [, count]) => sum + count, 0)
  const suffix = hidden > 0 ? `, +${tools.length - 6} more (${hidden})` : ""
  const toolText = shown.length > 0 ? `; ${shown.join(", ")}${suffix}` : ""
  return `${rounds.turns ?? 0} turns${toolText}`
}

export function stringifyDetail(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
