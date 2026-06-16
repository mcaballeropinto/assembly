import { AlertTriangle, CheckCircle2, Circle, SkipForward, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Timeline,
  TimelineContent,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@/components/ui/timeline"
import type { ApiWorkpieceResponse, Workpiece } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  formatCost,
  formatDuration,
  formatRounds,
  formatTokens,
  sortStationEntries,
  stationStatusClass,
} from "./drawer-utils"

function StatusIcon({ status }: { status?: string }) {
  const className = "h-3.5 w-3.5"
  switch (status) {
    case "done":
      return <CheckCircle2 className={className} />
    case "failed":
      return <XCircle className={className} />
    case "skipped":
      return <SkipForward className={className} />
    case "escalated":
      return <AlertTriangle className={className} />
    default:
      return <Circle className={className} />
  }
}

type WorkpieceData = Extract<ApiWorkpieceResponse, Workpiece>

export function StationTimeline({ workpiece }: { workpiece: WorkpieceData }) {
  const stations = sortStationEntries(workpiece.stations)

  if (stations.length === 0) {
    return <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No station runs found.</div>
  }

  return (
    <Timeline value={stations.length} className="pl-1">
      {stations.map(([name, station], index) => (
        <TimelineItem key={name} step={index + 1}>
          <TimelineSeparator />
          <TimelineIndicator className={cn("size-7 text-background", stationStatusClass(station.status))}>
            <StatusIcon status={station.status} />
          </TimelineIndicator>
          <TimelineContent className="space-y-2 pb-1">
            <TimelineHeader>
              <div className="flex min-w-0 items-center gap-2">
                <TimelineTitle className="truncate">{name}</TimelineTitle>
                <Badge variant="outline" className={cn("shrink-0", stationStatusClass(station.status))}>
                  {station.status}
                </Badge>
              </div>
            </TimelineHeader>
            <div className="space-y-1 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span>{formatDuration(station.started_at, station.finished_at)}</span>
                {station.model ? <span>{station.model}</span> : null}
                <span>
                  {formatTokens(station.tokens?.in)} in / {formatTokens(station.tokens?.out)} out
                </span>
                <span>{formatCost(station.cost_usd)}</span>
              </div>
              <div>{formatRounds(station.rounds)}</div>
            </div>
            {station.previous_attempts && station.previous_attempts.length > 0 ? (
              <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                <div className="mb-1 font-medium text-foreground">Prior attempts ({station.previous_attempts.length})</div>
                <div className="space-y-1">
                  {station.previous_attempts.map((attempt, attemptIndex) => (
                    <div key={`${name}-${attemptIndex}`} className="flex flex-wrap gap-x-2 gap-y-1">
                      <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", stationStatusClass(attempt.status))}>
                        {attempt.failure_class ?? attempt.status}
                      </Badge>
                      <span>{formatDuration(attempt.started_at, attempt.finished_at)}</span>
                      <span>{formatRounds(attempt.rounds)}</span>
                      {attempt.summary ? <span className="min-w-0 truncate">{attempt.summary}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {station.summary ? <p className="text-xs text-muted-foreground">{station.summary}</p> : null}
          </TimelineContent>
        </TimelineItem>
      ))}
    </Timeline>
  )
}
