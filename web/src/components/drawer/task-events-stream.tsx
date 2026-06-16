import * as React from "react"
import { RefreshCw } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetchTaskEvents, fetchTaskEventStations } from "@/lib/api"
import type { StationMeta } from "@/lib/api"
import { cn } from "@/lib/utils"
import { sortStationMeta, stationStatusClass, stringifyDetail } from "./drawer-utils"

interface TaskEventsStreamProps {
  lineName: string
  workpieceId: string
  initialStations?: StationMeta[]
}

function chooseInitialStation(stations: StationMeta[]): string {
  const sorted = sortStationMeta(stations)
  return sorted.find((station) => station.status === "running")?.name ?? sorted[0]?.name ?? ""
}

export function TaskEventsStream({ lineName, workpieceId, initialStations = [] }: TaskEventsStreamProps) {
  const [selectedStation, setSelectedStation] = React.useState(() => chooseInitialStation(initialStations))
  const [autoTail, setAutoTail] = React.useState(true)
  const parentRef = React.useRef<HTMLDivElement | null>(null)

  const stationsQuery = useQuery({
    queryKey: ["task-event-stations", lineName, workpieceId],
    queryFn: () => fetchTaskEventStations(lineName, workpieceId),
    initialData: initialStations.length > 0 ? { stations: initialStations } : undefined,
    refetchInterval: autoTail ? 3000 : false,
  })

  const stations = React.useMemo(
    () => sortStationMeta(stationsQuery.data?.stations ?? initialStations),
    [initialStations, stationsQuery.data?.stations]
  )

  React.useEffect(() => {
    if (!selectedStation && stations.length > 0) {
      setSelectedStation(chooseInitialStation(stations))
    }
  }, [selectedStation, stations])

  const eventsQuery = useQuery({
    queryKey: ["task-events", lineName, workpieceId, selectedStation],
    queryFn: () => fetchTaskEvents(lineName, workpieceId, selectedStation, { limit: 500 }),
    enabled: Boolean(selectedStation),
    refetchInterval: autoTail ? 3000 : false,
  })

  const events = eventsQuery.data?.events ?? []
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 8,
  })

  React.useEffect(() => {
    if (autoTail && events.length > 0) {
      virtualizer.scrollToIndex(events.length - 1, { align: "end" })
    }
  }, [autoTail, events.length, virtualizer])

  if (stationsQuery.isError) {
    return (
      <div className="rounded-md border border-destructive/30 p-4 text-sm">
        <div className="mb-3 text-destructive">Could not load task-event stations.</div>
        <Button variant="outline" size="sm" onClick={() => void stationsQuery.refetch()}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedStation} onValueChange={setSelectedStation} disabled={stations.length === 0}>
          <SelectTrigger className="h-9 min-w-[220px] flex-1">
            <SelectValue placeholder="Select station" />
          </SelectTrigger>
          <SelectContent>
            {stations.map((station) => (
              <SelectItem key={station.name} value={station.name}>
                {station.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={autoTail ? "secondary" : "outline"}
          size="sm"
          aria-pressed={autoTail}
          onClick={() => setAutoTail((value) => !value)}
        >
          Auto-tail
        </Button>
        <div className="text-xs text-muted-foreground">
          {events.length} of {eventsQuery.data?.total ?? 0} events
        </div>
      </div>

      {stations.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No task-event stations found.</div>
      ) : eventsQuery.isLoading ? (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading events...</div>
      ) : eventsQuery.isError ? (
        <div className="rounded-md border border-destructive/30 p-4 text-sm">
          <div className="mb-3 text-destructive">Could not load task events.</div>
          <Button variant="outline" size="sm" onClick={() => void eventsQuery.refetch()}>
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No events for this station.</div>
      ) : (
        <div ref={parentRef} className="h-[400px] overflow-y-auto rounded-md border bg-muted/20">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const event = events[virtualRow.index]
              if (!event) return null
              const detail = stringifyDetail(event.detail)
              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 top-0 w-full border-b px-3 py-2 font-mono text-xs"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">{event.ts}</span>
                    <span className="text-muted-foreground">#{event.seq}</span>
                    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", stationStatusClass(event.kind))}>
                      {event.kind}
                    </Badge>
                    <span className="min-w-0 flex-1 break-words text-foreground">{event.summary}</span>
                  </div>
                  {detail ? <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{detail}</pre> : null}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
