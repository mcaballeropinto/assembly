import { WorkpieceDrawerPlaceholder } from "../components/drawer/workpiece-drawer-placeholder"
import { Shell } from "../components/shell/shell"
import { normalizeDashboardSearch } from "../lib/drawer-url"
import { createRootRoute, Outlet } from "@tanstack/react-router"

export const Route = createRootRoute({
  validateSearch: normalizeDashboardSearch,
  component: RootRoute,
})

function RootRoute() {
  const search = Route.useSearch()

  return (
    <>
      <Shell>
        <Outlet />
      </Shell>
      <WorkpieceDrawerPlaceholder search={search} />
    </>
  )
}
