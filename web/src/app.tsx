import { Outlet, useRouterState, useSearch } from "@tanstack/react-router"

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
            {hasWorkpieceParam
              ? lineName
                ? "Drawer parameters detected."
                : "Cannot open workpiece drawer: missing line context."
              : "No workpiece selected."}
          </div>
        </CardContent>
      </Card>

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
