import { useEffect, useMemo, useState } from "react"
import { Outlet, useRouterState, useSearch } from "@tanstack/react-router"

import { ActivityFeed } from "./components/activity/activity-feed"
import {
  ActivityFilter,
  filterActivity,
  readFiltersFromURL,
  writeFiltersToURL,
} from "./components/activity/activity-filter"
import { ErrorBanner } from "./components/banners/error-banner"
import { FetchErrorBanner } from "./components/banners/fetch-error-banner"
import { WorkpieceDrawer } from "./components/drawer/workpiece-drawer"
import { AppShell } from "./components/shell/app-shell"
import {
  mockBannerErrors,
  mockFetchError,
  noopDismiss,
  noopRetry,
} from "./lib/dashboard-mock-data"
import type { ActivityEntry } from "./lib/api"
import { useGlobalState } from "./hooks/use-state-query"

export function App() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const search = useSearch({ strict: false }) as {
    wp?: unknown
    wpline?: unknown
    line?: unknown
  }
  const lineName =
    typeof search.wpline === "string"
      ? search.wpline
      : typeof search.line === "string"
        ? search.line
        : undefined
  const hasWorkpieceParam = typeof search.wp === "string" && search.wp.length > 0
  const { data, isLoading, error } = useGlobalState()
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() =>
    readFiltersFromURL()
  )

  useEffect(() => {
    writeFiltersToURL(selectedKeys)
  }, [selectedKeys])

  const allActivity = useMemo(() => {
    if (!data?.lines) return []

    const merged: ActivityEntry[] = []
    for (const line of data.lines) {
      if (line.state?.activity) {
        for (const act of line.state.activity) {
          merged.push({ ...act, _line: line.name })
        }
      }
    }

    merged.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
    return merged.slice(0, 50)
  }, [data])

  const filteredActivity = useMemo(
    () => filterActivity(allActivity, selectedKeys),
    [allActivity, selectedKeys]
  )

  if (pathname !== "/") {
    return <Outlet />
  }

  return (
    <AppShell>
      <div className="space-y-3">
        <ErrorBanner errors={mockBannerErrors} onDismiss={noopDismiss} />
        <FetchErrorBanner error={mockFetchError} onRetry={noopRetry} />
      </div>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Overview</h1>
          <ActivityFilter
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
          />
        </div>
        <ActivityFeed entries={filteredActivity} />
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive">
            Failed to fetch: {(error as Error).message}
          </p>
        ) : null}
      </section>

      {hasWorkpieceParam && !lineName ? (
        <p
          role="alert"
          className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Cannot open workpiece drawer: this deep link is missing line context.
        </p>
      ) : null}
      <WorkpieceDrawer lineName={lineName} />
    </AppShell>
  )
}

export default App
