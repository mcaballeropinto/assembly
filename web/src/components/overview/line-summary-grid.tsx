import type { ApiStateLineEntry, StationStatusState } from "../../lib/api"

import { cn } from "../../lib/utils"
import { StationStatusDot } from "../chips/station-status-dot"
import { Badge } from "../ui/badge"
import { Card } from "../ui/card"

export interface LineSummaryGridProps {
  lines: ApiStateLineEntry[]
  className?: string
}

export interface LineQueueCounts {
  inbox: number
  done: number
  errors: number
  review: number
  held: number
}

const queueLabels: Array<{ key: keyof LineQueueCounts; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "done", label: "Done" },
  { key: "errors", label: "Errors" },
  { key: "review", label: "Review" },
  { key: "held", label: "Held" },
]

export function LineSummaryGrid({ lines, className }: LineSummaryGridProps) {
  const sortedLines = [...lines].sort((a, b) => a.name.localeCompare(b.name))

  if (sortedLines.length === 0) {
    return (
      <section
        className={cn(
          "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4",
          className,
        )}
      >
        <Card className="p-6 md:col-span-2 xl:col-span-3 2xl:col-span-4">
          <p className="text-sm text-muted-foreground">No lines discovered.</p>
        </Card>
      </section>
    )
  }

  return (
    <section
      className={cn(
        "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4",
        className,
      )}
    >
      {sortedLines.map((line) => (
        <a key={line.name} href={lineHref(line.name)} className="block">
          <Card className="h-full p-6 transition-colors hover:bg-accent/40">
            <div className="flex items-start justify-between gap-4">
              <h2 className="min-w-0 truncate text-base font-semibold">
                {line.name}
              </h2>
              <Badge
                variant={line.status === "error" ? "destructive" : "secondary"}
                className="shrink-0 capitalize"
              >
                {line.status}
              </Badge>
            </div>

            <QueueDepthRow counts={queueCountsForLine(line)} />
            <StationChips line={line} />
          </Card>
        </a>
      ))}
    </section>
  )
}

function QueueDepthRow({ counts }: { counts: LineQueueCounts }) {
  return (
    <dl className="mt-6 grid grid-cols-5 gap-4">
      {queueLabels.map(({ key, label }) => (
        <div key={key} className="min-w-0">
          <dt className="truncate text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-base font-semibold tabular-nums">
            {counts[key].toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function StationChips({ line }: { line: ApiStateLineEntry }) {
  const sequence = line.state?.sequence ?? []

  if (sequence.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">
        No stations configured.
      </p>
    )
  }

  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {sequence.map((station) => {
        const state = deriveStationStatus(line, station)

        return (
          <span
            key={station}
            className="inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1 text-xs"
          >
            <StationStatusDot state={state} label={`${station} ${state}`} />
            <span className="truncate">{station}</span>
          </span>
        )
      })}
    </div>
  )
}

export function lineHref(name: string): string {
  return `/line/${encodeURIComponent(name)}`
}

export function queueCountsForLine(line: ApiStateLineEntry): LineQueueCounts {
  return {
    inbox: line.state?.lineQueue.inbox ?? 0,
    done: line.state?.lineQueue.done ?? 0,
    errors: line.state?.lineQueue.errorActive ?? line.state?.lineQueue.error ?? 0,
    review: line.state?.lineQueue.review ?? 0,
    held: line.state?.held.length ?? 0,
  }
}

export function deriveStationStatus(
  line: ApiStateLineEntry,
  station: string,
): StationStatusState {
  if (line.status === "error" && !line.state) return "errored"

  const state = line.state
  if (!state) return "muted"

  if (
    state.stationTimings?.[station]?.running === true ||
    (state.sections[station]?.processing ?? 0) > 0
  ) {
    return "running"
  }

  if ((state.sections[station]?.inbox ?? 0) > 0) return "blocked"
  if (state.sequence.includes(station)) return "idle"

  return "muted"
}
