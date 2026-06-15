import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { createRoute } from "@tanstack/react-router"

import { ErrorBanner } from "../components/banners/error-banner"
import type { DashboardErrorBannerItem } from "../components/banners/error-banner"
import { KpiStrip } from "../components/kpi/kpi-strip"
import { LineSummaryGrid } from "../components/overview/line-summary-grid"
import { ActivityFeed } from "../components/ui/activity-feed"
import { Card } from "../components/ui/card"
import { useDismissErrors } from "../hooks/use-dashboard-mutations"
import {
  filterActivity,
  normalizeActivity,
  parseActivitySearch,
  serializeActivitySearch,
  type ActivityFilterKey,
} from "../lib/activity"
import type { ApiStateLineEntry } from "../lib/api"
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
    () => filterActivity(normalized, selectedFilters),
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
      <div className="space-y-3">
        {data.lines.map((line) => (
          <LineErrorBanner key={line.name} line={line} />
        ))}
      </div>
      <KpiStrip totals={data.totals} />
      <LineSummaryGrid lines={data.lines} />
      <ActivityFeed
        items={filtered}
        totalItems={normalized.length}
        selectedFilters={selectedFilters}
        onSelectedFiltersChange={handleSelectedFiltersChange}
        title="Activity"
      />
    </div>
  )
}

function LineErrorBanner({ line }: { line: ApiStateLineEntry }) {
  const dismiss = useDismissErrors(line.name)
  const errors = getBannerErrors(line)

  return (
    <ErrorBanner
      errors={errors}
      onDismiss={(fileNames) => dismiss.mutate(fileNames)}
    />
  )
}

function getBannerErrors(line: ApiStateLineEntry): DashboardErrorBannerItem[] {
  const source =
    line.state?.banner_errors && line.state.banner_errors.length > 0
      ? line.state.banner_errors
      : line.state?.errors ?? []

  return source
    .map((item) => normalizeBannerError(item, line.name))
    .filter((item): item is DashboardErrorBannerItem => Boolean(item))
}

function normalizeBannerError(
  item: unknown,
  lineName: string
): DashboardErrorBannerItem | undefined {
  if (!item || typeof item !== "object") return undefined
  const record = item as Record<string, unknown>
  const fileName =
    typeof record.fileName === "string" ? record.fileName : undefined
  if (!fileName) return undefined
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    fileName,
    lineName,
    task: typeof record.task === "string" ? record.task : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
    severity:
      record.severity === "critical" ||
      record.severity === "warning" ||
      record.severity === "suppressed"
        ? record.severity
        : undefined,
    finished_at:
      typeof record.finished_at === "string" ? record.finished_at : undefined,
  }
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
