import {
  createRoute,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"

import App from "@/app"
import { ConnectionChipDemo } from "@/dev/connection-chip-demo"
import { ErrorBannerDemo } from "@/dev/error-banner-demo"
import { FetchErrorBannerDemo } from "@/dev/fetch-error-banner-demo"
import { UsageChipDemo } from "@/dev/usage-chip-demo"

const rootRoute = createRootRoute({
  component: App,
})

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

const routeTree = rootRoute.addChildren([
  connectionChipRoute,
  usageChipRoute,
  errorBannerRoute,
  fetchErrorBannerRoute,
])

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
