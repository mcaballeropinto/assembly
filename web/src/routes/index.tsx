import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { createRoute } from "@tanstack/react-router"

import { ActivityFeed } from "../components/ui/activity-feed"
import { Card } from "../components/ui/card"
import { fetchDashboardState } from "../lib/api"
import {
  filterActivity,
  normalizeActivity,
  parseActivitySearch,
  serializeActivitySearch,
  type ActivityFilterKey,
} from "../lib/activity"

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

  const { data, isPending, error } = useQuery({
    queryKey: ["dashboard-state"],
    queryFn: fetchDashboardState,
    refetchInterval: 3000,
  })

  const normalized = useMemo(() => (data ? normalizeActivity(data) : []), [data])
  const filtered = useMemo(
    () => filterActivity(normalized, selectedFilters),
    [normalized, selectedFilters],
  )

  const handleSelectedFiltersChange = (next: Set<ActivityFilterKey>) => {
    setSelectedFilters(next)
    writeActivitySearch(next)
  }

  if (isPending) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Loading activity...</p>
      </Card>
    )
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

  return (
    <ActivityFeed
      items={filtered}
      totalItems={normalized.length}
      selectedFilters={selectedFilters}
      onSelectedFiltersChange={handleSelectedFiltersChange}
      title="Activity"
    />
  )
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
