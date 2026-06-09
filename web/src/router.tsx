import {
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"

import App from "@/app"

const routeTree = createRootRoute({
  component: App,
})

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
