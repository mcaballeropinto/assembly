import { createRoute } from "@tanstack/react-router"

import { Route as rootRoute } from "./__root"

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewRoute,
})

function OverviewRoute() {
  return <h1 className="text-xl font-semibold">Overview placeholder</h1>
}
