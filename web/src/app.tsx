import { Outlet, useRouterState } from "@tanstack/react-router"

import { ErrorBanner } from "./components/banners/error-banner"
import { FetchErrorBanner } from "./components/banners/fetch-error-banner"
import { AppShell } from "./components/shell/app-shell"
import { Button } from "./components/ui/button"
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

export default function App() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

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
            Header chips and page banners are rendered from mock data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button>It works</Button>
        </CardContent>
      </Card>
    </AppShell>
  )
}
