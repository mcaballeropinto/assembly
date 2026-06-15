import { useNavigate, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetchWorkpiece, isApiError } from "@/lib/api"
import type { ApiWorkpieceData } from "../../../../src/dashboard-api"
import { DrawerFooter } from "./drawer-footer"
import {
  formatCost,
  formatTokens,
  getWorkpieceOutcome,
  sortStationEntries,
  stationStatusClass,
} from "./drawer-utils"
import { SidecarTails } from "./sidecar-tails"
import { StationTimeline } from "./station-timeline"
import { TaskEventsStream } from "./task-events-stream"

export interface WorkpieceDrawerProps {
  lineName?: string
}

export function WorkpieceDrawer({ lineName: lineNameProp }: WorkpieceDrawerProps) {
  const search = useSearch({ strict: false }) as {
    wp?: unknown
    wpline?: unknown
    line?: unknown
  }
  const navigate = useNavigate()
  const fileName =
    typeof search.wp === "string" && search.wp.length > 0
      ? search.wp
      : undefined
  const lineName =
    lineNameProp ??
    (typeof search.wpline === "string" && search.wpline.length > 0
      ? search.wpline
      : typeof search.line === "string" && search.line.length > 0
        ? search.line
        : undefined)
  const open = Boolean(fileName && lineName)

  const query = useQuery({
    queryKey: ["workpiece", lineName, fileName],
    queryFn: () => fetchWorkpiece(lineName!, fileName!),
    enabled: open,
  })

  const apiError =
    query.error instanceof Error
      ? query.error.message
      : query.data && isApiError(query.data)
        ? query.data.error
        : undefined
  const workpiece: ApiWorkpieceData | undefined =
    query.data && !isApiError(query.data) ? query.data : undefined
  const outcome = workpiece ? getWorkpieceOutcome(workpiece) : null
  const stations = workpiece ? sortStationEntries(workpiece.stations) : []
  const models = [...new Set(stations.map(([, station]) => station.model).filter(Boolean))]
  const totalIn =
    workpiece?.totals?.tokens?.in ??
    stations.reduce((sum, [, station]) => sum + (station.tokens?.in ?? 0), 0)
  const totalOut =
    workpiece?.totals?.tokens?.out ??
    stations.reduce((sum, [, station]) => sum + (station.tokens?.out ?? 0), 0)
  const totalCost =
    workpiece?.totals?.cost_usd ??
    stations.reduce((sum, [, station]) => sum + (station.cost_usd ?? 0), 0)
  const title = getWorkpieceTitle(workpiece, fileName)

  function closeDrawer() {
    void navigate({
      search: (prev) => {
        const next = { ...(prev as Record<string, unknown>) }
        delete next.wp
        return next
      },
      replace: true,
    })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeDrawer()
      }}
    >
      <SheetContent
        side="right"
        className="flex w-[640px] max-w-full flex-col gap-0 p-0 sm:max-w-[640px]"
      >
        {query.isLoading ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading workpiece...
          </div>
        ) : apiError ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
            {apiError}
          </div>
        ) : workpiece && outcome && lineName && fileName ? (
          <>
            <SheetHeader className="border-b p-6 pr-12">
              <div className="flex min-w-0 items-center gap-2">
                <SheetTitle className="truncate">{title}</SheetTitle>
                <Badge variant="outline" className={stationStatusClass(outcome.state)}>
                  {outcome.state}
                </Badge>
              </div>
              <SheetDescription className="space-y-1">
                <span className="block truncate">{workpiece.task}</span>
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  <span>{lineName}</span>
                  {models.length > 0 ? <span>{models.slice(0, 3).join(", ")}</span> : null}
                  <span>
                    {formatTokens(totalIn)} in / {formatTokens(totalOut)} out
                  </span>
                  <span>{formatCost(totalCost)}</span>
                </span>
              </SheetDescription>
            </SheetHeader>

            <Tabs defaultValue="stations" className="flex min-h-0 flex-1 flex-col">
              <div className="border-b px-6 pt-4">
                <TabsList>
                  <TabsTrigger value="stations">Stations</TabsTrigger>
                  <TabsTrigger value="events">Events</TabsTrigger>
                  <TabsTrigger value="sidecars">Sidecars</TabsTrigger>
                </TabsList>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TabsContent value="stations" className="m-0 p-6 pt-4">
                  <StationTimeline workpiece={workpiece} />
                </TabsContent>
                <TabsContent value="events" className="m-0 p-6 pt-4">
                  <TaskEventsStream
                    lineName={lineName}
                    workpieceId={String(workpiece.id)}
                    initialStations={workpiece._taskEventStations ?? []}
                  />
                </TabsContent>
                <TabsContent value="sidecars" className="m-0 p-6 pt-4">
                  <SidecarTails lineName={lineName} fileName={fileName} />
                </TabsContent>
              </div>
            </Tabs>

            <DrawerFooter workpiece={workpiece} fileName={fileName} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Select a workpiece.
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function getWorkpieceTitle(
  workpiece: ApiWorkpieceData | undefined,
  fileName: string | undefined
): string {
  if (!workpiece) return fileName ?? "Workpiece"
  if (workpiece.taskKey?.trim()) return workpiece.taskKey.trim()

  const firstTaskLine = workpiece.task
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  if (firstTaskLine) return firstTaskLine

  return workpiece.id || fileName || "Workpiece"
}
