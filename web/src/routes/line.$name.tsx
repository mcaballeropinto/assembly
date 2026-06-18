import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Outlet, createRoute, useNavigate, useSearch } from "@tanstack/react-router"

import { ActivityFeed } from "../components/ui/activity-feed"
import { FlowMetrics } from "../components/history/flow-metrics"
import { HistoryTable } from "../components/history/history-table"
import { LineDetailHeader } from "../components/line/line-detail-header"
import { StationSequence } from "../components/line/station-sequence"
import { WorkpieceSections } from "../components/line/workpiece-sections"
import { Card } from "../components/ui/card"
import { filterActivity, normalizeActivity, parseActivitySearch, serializeActivitySearch, type ActivityFilterKey } from "../lib/activity"
import { fetchLineState, isLineStateError, type ApiStateResponse } from "../lib/api"
import { openWorkpieceSearch } from "../lib/drawer-url"
import {
  mergeCompletedWithFailed,
  normalizeCompleted,
  normalizeErrors,
  normalizeHeld,
  normalizeReviews,
  stationSequenceRows,
} from "../lib/line-detail"
import { Route as rootRoute } from "./__root"

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/line/$name",
  component: LineRoute,
})

function LineRoute() {
  const { name } = Route.useParams()
  const navigate = useNavigate({ from: "/line/$name" })
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const [selectedFilters, setSelectedFilters] = useState<Set<ActivityFilterKey>>(
    () => parseActivitySearch(typeof search.activity === "string" ? search.activity : undefined),
  )

  const line = useQuery({
    queryKey: ["line", name],
    queryFn: ({ signal }) => fetchLineState(name, signal),
    refetchInterval: 3000,
    enabled: !window.location.pathname.endsWith("/kanban"),
  })

  const state = line.data && !isLineStateError(line.data) ? line.data : undefined
  const activityItems = useMemo(() => {
    if (!state) return []
    const apiState: ApiStateResponse = {
      lines: [{
        name,
        path: "",
        status: "running",
        startedAt: state.timestamp,
        state,
      }],
      totals: {
        lines: 1,
        linesRunning: 1,
        linesErrored: 0,
        totalInbox: state.lineQueue.inbox,
        totalDone: state.lineQueue.done,
        totalErrors: state.lineQueue.error,
        totalReview: state.lineQueue.review,
        totalCostUsd: state.sessionTotals.cost_usd,
        totalThroughput1h: state.throughput.last_1h,
        totalThroughput24h: state.throughput.last_24h,
      },
      timestamp: state.timestamp,
      version: "line",
    }
    return normalizeActivity(apiState)
  }, [name, state])
  const filteredActivity = useMemo(
    () => filterActivity(activityItems, selectedFilters),
    [activityItems, selectedFilters],
  )

  function openWorkpiece(fileName: string) {
    void navigate({
      search: openWorkpieceSearch(search, fileName),
      replace: true,
    })
  }

  function setFilters(next: Set<ActivityFilterKey>) {
    setSelectedFilters(next)
    void navigate({
      search: {
        ...search,
        activity: serializeActivitySearch(next),
      },
      replace: true,
    })
  }

  if (window.location.pathname.endsWith("/kanban")) {
    return <Outlet />
  }

  return (
    <div className="space-y-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">List</p>
        </div>
        <div
          role="tablist"
          aria-label="Line view"
          className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground"
        >
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md bg-background px-3 py-1 text-sm font-medium text-foreground shadow-sm"
          >
            List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all hover:text-foreground"
            onClick={() => {
              void navigate({
                to: "/line/$name/kanban",
                params: { name },
                search: { wp: undefined },
              })
            }}
          >
            Kanban
          </button>
        </div>
      </div>

      {line.isLoading ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Loading line...</p>
        </Card>
      ) : line.isError ? (
        <Card className="border-destructive/40 p-6">
          <p className="text-sm text-destructive">
            {line.error instanceof Error ? line.error.message : "Failed to load line."}
          </p>
        </Card>
      ) : line.data && isLineStateError(line.data) ? (
        <Card className="border-destructive/40 p-6">
          <p className="text-sm text-destructive">{line.data.error}</p>
        </Card>
      ) : state ? (
        <>
          <LineDetailHeader state={state} />
          <StationSequence rows={stationSequenceRows(state)} />
          <WorkpieceSections
            lineName={name}
            held={normalizeHeld(state.held)}
            completed={mergeCompletedWithFailed(
              normalizeCompleted(state.completed),
              normalizeErrors(state.errors),
            )}
            errors={normalizeErrors(state.errors)}
            dismissed={normalizeErrors(state.errorsDismissed, "dismissed")}
            reviews={normalizeReviews(state.reviews)}
            onOpenWorkpiece={openWorkpiece}
          />
          <ActivityFeed
            items={filteredActivity}
            totalItems={activityItems.length}
            selectedFilters={selectedFilters}
            onSelectedFiltersChange={setFilters}
            title="Detail Activity"
            onOpenWorkpiece={(_, fileName) => openWorkpiece(fileName)}
          />
          <HistoryTable lineName={name} onOpenWorkpiece={openWorkpiece} />
          <FlowMetrics lineName={name} />
        </>
      ) : null}
    </div>
  )
}
