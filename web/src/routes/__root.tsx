import { lazy, Suspense } from "react"
import { Shell } from "../components/shell/shell"
import { normalizeDashboardSearch } from "../lib/drawer-url"
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"

const WorkpieceDrawer = lazy(() =>
  import("../components/drawer/workpiece-drawer").then((module) => ({
    default: module.WorkpieceDrawer,
  })),
)

export const Route = createRootRoute({
  validateSearch: normalizeDashboardSearch,
  component: RootRoute,
})

function RootRoute() {
  const search = Route.useSearch()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const routeLine = lineFromPathname(pathname)
  const lineName =
    typeof search.wpline === "string"
      ? search.wpline
      : typeof search.line === "string"
        ? search.line
        : routeLine
  const hasWorkpiece = typeof search.wp === "string" && search.wp.length > 0

  return (
    <>
      <Shell>
        <Outlet />
      </Shell>
      {hasWorkpiece ? (
        <Suspense fallback={null}>
          <WorkpieceDrawer lineName={lineName} />
        </Suspense>
      ) : null}
    </>
  )
}

function lineFromPathname(pathname: string): string | undefined {
  const match = pathname.match(/^\/line\/([^/]+)/)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}
