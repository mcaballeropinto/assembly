import { WorkpieceDrawer } from "../components/drawer/workpiece-drawer"
import { Shell } from "../components/shell/shell"
import { Toaster } from "../components/ui/sonner"
import { normalizeDashboardSearch } from "../lib/drawer-url"
import { createRootRoute, Outlet } from "@tanstack/react-router"

export const Route = createRootRoute({
  validateSearch: normalizeDashboardSearch,
  component: RootRoute,
})

function RootRoute() {
  const search = Route.useSearch()
  const lineName =
    typeof search.wpline === "string"
      ? search.wpline
      : typeof search.line === "string"
        ? search.line
        : undefined

  return (
    <>
      <Shell>
        <Outlet />
      </Shell>
      <WorkpieceDrawer lineName={lineName} />
      <Toaster position="top-right" />
    </>
  )
}
