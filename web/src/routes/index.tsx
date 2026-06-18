import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { createRoute } from "@tanstack/react-router"

import { KpiStrip } from "../components/kpi/kpi-strip"
import { LineSummaryGrid } from "../components/overview/line-summary-grid"
import { ActivityFeed } from "../components/ui/activity-feed"
import { Card } from "../components/ui/card"
import {
  filterActivity,
  normalizeActivity,
  parseActivitySearch,
  serializeActivitySearch,
  type ActivityFilterKey,
} from "../lib/activity"
import { openWorkpieceSearch } from "../lib/drawer-url"
import { apiStateQueryOptions } from "../lib/query"

import { Route as rootRoute } from "./__root"

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewRoute,
})

export function OverviewRoute() {
  const [selectedFilters, setSelectedFilters] = useState<
    Set<ActivityFilterKey>
  >(() => parseActivitySearch(readActivitySearch()))

  const { data, isPending, error } = useQuery(apiStateQueryOptions())

  const normalized = useMemo(() => (data ? normalizeActivity(data) : []), [data])
  const filtered = useMemo(
    () => filterActivity(normalized, selectedFilters).slice(0, 50),
    [normalized, selectedFilters],
  )

  const handleSelectedFiltersChange = (next: Set<ActivityFilterKey>) => {
    setSelectedFilters(next)
    writeActivitySearch(next)
  }

  if (error) {
    return (
      <Card className="border-destructive/40 p-6">
        <p className="text-sm font-medium text-destructive">
          Failed to load dashboard state
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {(error as Error).message}
        </p>
      </Card>
    )
  }

  if (isPending || !data) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Loading overview...</p>
      </Card>
    )
  }

  return (
    <div className="space-y-8 pt-6 pb-12">
      <KpiStrip totals={data.totals} />
      <LineSummaryGrid lines={data.lines} />
      <ActivityFeed
        items={filtered}
        totalItems={normalized.length}
        selectedFilters={selectedFilters}
        onSelectedFiltersChange={handleSelectedFiltersChange}
        title="Activity"
        onOpenWorkpiece={(lineName, fileName) => {
          writeDrawerSearch(fileName, lineName)
        }}
      />
    </div>
  )
}

function writeDrawerSearch(fileName: string, lineName: string): void {
  const url = new URL(window.location.href)
  const next = openWorkpieceSearch(
    Object.fromEntries(url.searchParams.entries()),
    fileName,
    lineName,
  )
  for (const key of ["wp", "wpline"]) {
    const value = next[key]
    if (typeof value === "string") {
      url.searchParams.set(key, value)
    } else {
      url.searchParams.delete(key)
    }
  }
  window.history.replaceState({}, "", url.toString())
}

function readActivitySearch(): string | undefined {
  const params = new URLSearchParams(window.location.search)
  return params.has("activity") ? (params.get("activity") ?? "") : undefined
}

function writeActivitySearch(selectedKeys: Set<ActivityFilterKey>): void {
  const url = new URL(window.location.href)
  const nextActivity = serializeActivitySearch(selectedKeys)

  if (nextActivity === undefined) {
    url.searchParams.delete("activity")
  } else {
    url.searchParams.set("activity", nextActivity)
  }

  window.history.replaceState({}, "", url.toString())
}
