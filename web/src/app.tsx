import * as React from "react"
import { Outlet, useRouterState } from "@tanstack/react-router"

import { ErrorBanner } from "./components/banners/error-banner"
import { FetchErrorBanner } from "./components/banners/fetch-error-banner"
import { WorkpieceDrawer } from "./components/drawer/workpiece-drawer"
import { AppShell } from "./components/shell/app-shell"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import {
  mockBannerErrors,
  mockFetchError,
  noopDismiss,
  noopRetry,
} from "./lib/dashboard-mock-data"

function readDrawerParams() {
  const params = new URLSearchParams(window.location.search)
  return {
    fileName: params.get("wp") ?? "",
    lineName: params.get("wpline") ?? params.get("line") ?? "",
  }
}

export default function App() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const [drawerParams, setDrawerParams] = React.useState(readDrawerParams)
  const open = pathname === "/" && Boolean(drawerParams.fileName && drawerParams.lineName)

  React.useEffect(() => {
    const onPopState = () => setDrawerParams(readDrawerParams())
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) return
    const url = new URL(window.location.href)
    url.searchParams.delete("wp")
    url.searchParams.delete("wpline")
    window.history.pushState({}, "", url)
    setDrawerParams(readDrawerParams())
  }

  if (pathname !== "/") {
    return <Outlet />
  }

  return (
    <AppShell>
      <div className="space-y-3">
        <ErrorBanner errors={mockBannerErrors} onDismiss={noopDismiss} />
        <FetchErrorBanner error={mockFetchError} onRetry={noopRetry} />
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Chrome primitive mock wiring</CardTitle>
          <CardDescription>
            Header chips, page banners, and drawer content are rendered from dashboard wiring.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            {open ? "Drawer parameters detected." : "No workpiece selected."}
          </div>
        </CardContent>
      </Card>
      {open ? (
        <WorkpieceDrawer
          lineName={drawerParams.lineName}
          fileName={drawerParams.fileName}
          open={open}
          onOpenChange={handleOpenChange}
        />
      ) : null}
    </AppShell>
  )
}
