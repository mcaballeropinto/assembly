import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"

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
import type { ApiWorkpieceResponse } from "../../../../src/dashboard-api"
import type { StationResult, Workpiece } from "../../../../src/types"

type WorkpieceData = Extract<ApiWorkpieceResponse, Workpiece>
type StationEntry = [string, StationResult]

export interface WorkpieceDrawerProps {
  lineName?: string
}

export function WorkpieceDrawer({ lineName }: WorkpieceDrawerProps) {
  const search = useSearch({ strict: false }) as { wp?: unknown }
  const navigate = useNavigate()
  const fileName =
    typeof search.wp === "string" && search.wp.length > 0
      ? search.wp
      : undefined
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
  const workpiece: WorkpieceData | undefined =
    query.data && !isApiError(query.data) ? query.data : undefined

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
        className="flex h-full w-[640px] flex-col gap-0 p-0 sm:max-w-[640px]"
      >
        <DrawerHeader
          fileName={fileName}
          isLoading={query.isLoading}
          workpiece={workpiece}
        />
        <DrawerBody
          error={apiError}
          isLoading={query.isLoading}
          workpiece={workpiece}
        />
      </SheetContent>
    </Sheet>
  )
}

function DrawerHeader({
  fileName,
  isLoading,
  workpiece,
}: {
  fileName?: string
  isLoading: boolean
  workpiece?: WorkpieceData
}) {
  if (isLoading) {
    return (
      <SheetHeader className="border-b p-6 pr-12">
        <div className="h-6 w-2/3 rounded bg-muted" />
        <SheetDescription className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="h-4 w-24 rounded bg-muted" />
          <span className="h-4 w-20 rounded bg-muted" />
          <span className="h-4 w-28 rounded bg-muted" />
        </SheetDescription>
      </SheetHeader>
    )
  }

  const title = getWorkpieceTitle(workpiece, fileName)
  const status = getWorkpieceStatus(workpiece)

  return (
    <SheetHeader className="border-b p-6 pr-12">
      <div className="flex min-w-0 items-center gap-2">
        <SheetTitle className="truncate">{title}</SheetTitle>
        <Badge variant="outline">{status}</Badge>
      </div>
      <SheetDescription className="flex flex-wrap gap-x-3 gap-y-1">
        <span>Model: {getPrimaryModel(workpiece)}</span>
        <span>Tokens: {formatTokens(workpiece)}</span>
        <span>Cost: {formatCost(workpiece)}</span>
      </SheetDescription>
    </SheetHeader>
  )
}

function DrawerBody({
  error,
  isLoading,
  workpiece,
}: {
  error?: string
  isLoading: boolean
  workpiece?: WorkpieceData
}) {
  return (
    <Tabs defaultValue="stations" className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-6 pt-4">
        <TabsList>
          <TabsTrigger value="stations">Stations</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="sidecars">Sidecars</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="stations"
        className="m-0 min-h-0 flex-1 overflow-y-auto p-6 pt-4"
      >
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading stations...</p>
        ) : (
          <StationsShell workpiece={workpiece} />
        )}
      </TabsContent>
      <TabsContent
        value="events"
        className="m-0 min-h-0 flex-1 overflow-y-auto p-6 pt-4"
      >
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading events...</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {workpiece?._activity?.length
              ? `${workpiece._activity.length} events shown.${workpiece._activityMeta?.note ? ` ${workpiece._activityMeta.note}` : ""}`
              : "No events recorded for this workpiece."}
          </p>
        )}
      </TabsContent>
      <TabsContent
        value="sidecars"
        className="m-0 min-h-0 flex-1 overflow-y-auto p-6 pt-4"
      >
        <p className="text-sm text-muted-foreground">
          No sidecars loaded for this phase.
        </p>
      </TabsContent>
    </Tabs>
  )
}

function StationsShell({ workpiece }: { workpiece?: WorkpieceData }) {
  const stations = getStationEntries(workpiece)

  if (stations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No station results recorded for this workpiece.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {stations.map(([name, station]) => (
        <div key={name} className="rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 truncate text-sm font-medium">{name}</div>
            <Badge variant="secondary">{station.status}</Badge>
          </div>
          {station.summary ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {station.summary}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function getWorkpieceTitle(
  workpiece: WorkpieceData | undefined,
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

function getWorkpieceStatus(workpiece: WorkpieceData | undefined): string {
  if (!workpiece) return "Unknown"

  const stations = getStationEntries(workpiece)
  if (workpiece._source === "error" || stations.some(([, station]) => station.status === "failed")) {
    return "Failed"
  }
  if (stations.some(([, station]) => station.status === "escalated")) {
    return "Escalated"
  }
  if (workpiece._source?.includes(":processing")) return "Running"
  if (workpiece._source === "review") return "Review"
  if (workpiece._source === "held") return "Held"
  return "Completed"
}

function getPrimaryModel(workpiece: WorkpieceData | undefined): string {
  const station = getStationEntries(workpiece)
    .filter(([, result]) => Boolean(result.model))
    .sort(([, a], [, b]) => {
      const aTime = Date.parse(a.started_at ?? "") || 0
      const bTime = Date.parse(b.started_at ?? "") || 0
      return bTime - aTime
    })[0]?.[1]

  return station?.model || "unknown"
}

function formatTokens(workpiece: WorkpieceData | undefined): string {
  const totals = workpiece?.totals?.tokens ?? getStationEntries(workpiece).reduce(
    (sum, [, station]) => ({
      in: sum.in + (station.tokens?.in ?? 0),
      out: sum.out + (station.tokens?.out ?? 0),
    }),
    { in: 0, out: 0 }
  )

  return `${formatNumber(totals.in)} in / ${formatNumber(totals.out)} out`
}

function formatCost(workpiece: WorkpieceData | undefined): string {
  const cost =
    workpiece?.totals?.cost_usd ??
    getStationEntries(workpiece).reduce(
      (sum, [, station]) => sum + (station.cost_usd ?? 0),
      0
    )

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cost > 0 && cost < 0.01 ? 4 : 2,
  }).format(cost)
}

function getStationEntries(workpiece: WorkpieceData | undefined): StationEntry[] {
  return Object.entries(workpiece?.stations ?? {}).sort(([, a], [, b]) => {
    const aTime = Date.parse(a.started_at ?? "") || Number.MAX_SAFE_INTEGER
    const bTime = Date.parse(b.started_at ?? "") || Number.MAX_SAFE_INTEGER
    return aTime - bTime
  }) as StationEntry[]
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10000 ? "compact" : "standard",
  }).format(value)
}
