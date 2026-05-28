import {
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router"

import { ConnectionChipDemo } from "./dev/connection-chip-demo"
import { ErrorBannerDemo } from "./dev/error-banner-demo"
import { FetchErrorBannerDemo } from "./dev/fetch-error-banner-demo"
import { UsageChipDemo } from "./dev/usage-chip-demo"
import { Route as rootRoute } from "./routes/__root"
import { Route as indexRoute } from "./routes/index"
import { Route as lineRoute } from "./routes/line.$name"
import { Route as lineKanbanRoute } from "./routes/line.$name.kanban"

const connectionChipRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/connection-chip",
  component: ConnectionChipDemo,
})

const usageChipRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/usage-chip",
  component: UsageChipDemo,
})

const errorBannerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/error-banner",
  component: ErrorBannerDemo,
})

const fetchErrorBannerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/fetch-error-banner",
  component: FetchErrorBannerDemo,
})

const dashboardRouteTree = rootRoute.addChildren([
  indexRoute,
  lineRoute.addChildren([lineKanbanRoute]),
  connectionChipRoute,
  usageChipRoute,
  errorBannerRoute,
  fetchErrorBannerRoute,
])

export function createDashboardRouter(options?: { history?: RouterHistory }) {
  const dashboardRouter = createRouter({
    routeTree: dashboardRouteTree,
    history: options?.history,
  })

  const navigate = dashboardRouter.navigate.bind(dashboardRouter) as (
    navigateOptions: unknown,
  ) => ReturnType<typeof dashboardRouter.navigate>

  dashboardRouter.navigate = ((navigateOptions) => {
    if (
      navigateOptions &&
      typeof navigateOptions === "object" &&
      "search" in navigateOptions &&
      !("to" in navigateOptions) &&
      !("from" in navigateOptions)
    ) {
      return navigate({
        ...navigateOptions,
        to: dashboardRouter.state.location.pathname,
      })
    }

    return navigate(navigateOptions)
  }) as typeof dashboardRouter.navigate

  return dashboardRouter
}

export const router = createDashboardRouter()

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
