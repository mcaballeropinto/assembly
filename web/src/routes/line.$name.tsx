import { Outlet, createRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card"
import {
  getItemFileName,
  useDismissErrors,
  useReleaseAllHeld,
  useReleaseHeld,
  useRetryWorkpiece,
  useUndismissErrors,
} from "../hooks/use-dashboard-mutations"
import { apiStateQueryOptions } from "../lib/query"

import { Route as rootRoute } from "./__root"

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/line/$name",
  component: LineRoute,
})

function LineRoute() {
  const { name } = Route.useParams()
  const navigate = useNavigate({ from: "/line/$name" })
  const search = rootRoute.useSearch()
  const state = useQuery(apiStateQueryOptions())
  const release = useReleaseHeld(name)
  const releaseAll = useReleaseAllHeld(name)
  const retry = useRetryWorkpiece(name)
  const dismiss = useDismissErrors(name)
  const undismiss = useUndismissErrors(name)
  const line = state.data?.lines.find((entry) => entry.name === name)

  if (window.location.pathname.endsWith("/kanban")) {
    return <Outlet />
  }

  function openDrawer(fileName: string) {
    void navigate({
      search: { ...search, wp: fileName, wpline: name },
      replace: true,
    })
  }

  const held = line?.state?.held ?? []
  const errors = line?.state?.errors ?? []
  const dismissed = line?.state?.errorsDismissed ?? []
  const reviews = line?.state?.reviews ?? []

  return (
    <div className="mx-auto max-w-screen-2xl px-6 pb-12 pt-6 lg:px-8">
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
                search: ((prev: Record<string, unknown>) => ({
                  ...prev,
                  wp: undefined,
                  wpline: name,
                })) as never,
              })
            }}
          >
            Kanban
          </button>
        </div>
      </div>

      {state.isLoading ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Loading line state...</p>
        </Card>
      ) : state.isError ? (
        <Card className="border-destructive/40 p-6">
          <p className="text-sm text-destructive">Failed to load line state.</p>
        </Card>
      ) : !line?.state ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Line state unavailable.</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ListSection
            title="Held"
            count={held.length}
            action={
              held.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={releaseAll.isPending}
                  onClick={() => releaseAll.mutate()}
                >
                  Release all
                </Button>
              ) : null
            }
          >
            {held.map((item) => (
              <ListRow
                key={item.fileName}
                title={item.task || item.fileName}
                fileName={item.fileName}
                onOpen={openDrawer}
                actions={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={release.isPending}
                    onClick={() => release.mutate(item.fileName)}
                  >
                    Release
                  </Button>
                }
              />
            ))}
          </ListSection>

          <ListSection title="Active Errors" count={errors.length}>
            {errors.map((item) => {
              const fileName = getItemFileName(item)
              if (!fileName) return null
              return (
                <ListRow
                  key={fileName}
                  title={getItemTitle(item, fileName)}
                  fileName={fileName}
                  onOpen={openDrawer}
                  actions={
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(fileName)}
                      >
                        Retry
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={dismiss.isPending}
                        onClick={() => dismiss.mutate([fileName])}
                      >
                        Dismiss
                      </Button>
                    </>
                  }
                />
              )
            })}
          </ListSection>

          <ListSection title="Dismissed Errors" count={dismissed.length}>
            {dismissed.map((item) => {
              const fileName = getItemFileName(item)
              if (!fileName) return null
              return (
                <ListRow
                  key={fileName}
                  title={getItemTitle(item, fileName)}
                  fileName={fileName}
                  onOpen={openDrawer}
                  actions={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={undismiss.isPending}
                      onClick={() => undismiss.mutate([fileName])}
                    >
                      Undismiss
                    </Button>
                  }
                />
              )
            })}
          </ListSection>

          <ListSection title="Review" count={reviews.length}>
            {reviews.map((item) => {
              const fileName = getItemFileName(item)
              if (!fileName) return null
              return (
                <ListRow
                  key={fileName}
                  title={getItemTitle(item, fileName)}
                  fileName={fileName}
                  onOpen={openDrawer}
                />
              )
            })}
          </ListSection>
        </div>
      )}
    </div>
  )
}

function ListSection({
  title,
  count,
  action,
  children,
}: {
  title: string
  count: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <Badge variant="secondary">{count}</Badge>
        </div>
        {action}
      </CardHeader>
      <CardContent className="space-y-2">
        {count === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No items
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}

function ListRow({
  title,
  fileName,
  actions,
  onOpen,
}: {
  title: string
  fileName: string
  actions?: ReactNode
  onOpen: (fileName: string) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => onOpen(fileName)}
      >
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {fileName}
        </div>
      </button>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  )
}

function getItemTitle(item: unknown, fallback: string): string {
  if (!item || typeof item !== "object") return fallback
  const record = item as Record<string, unknown>
  if (typeof record.task === "string" && record.task.trim()) {
    return record.task.trim()
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim()
  }
  return fallback
}
