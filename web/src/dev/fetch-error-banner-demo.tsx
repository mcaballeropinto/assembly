import { FetchErrorBanner } from "@/components/banners/fetch-error-banner"
import { AppShell } from "@/components/shell/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { mockFetchError, noopRetry } from "@/lib/dashboard-mock-data"

export function FetchErrorBannerDemo() {
  return (
    <AppShell>
      <Card>
        <CardHeader>
          <CardTitle>Fetch error banner</CardTitle>
          <CardDescription>String, Error object, retrying, and hidden states.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FetchErrorBanner error={mockFetchError} onRetry={noopRetry} />
          <FetchErrorBanner error={new Error("Usage endpoint timed out")} onRetry={noopRetry} />
          <FetchErrorBanner error="Retry already in flight" onRetry={noopRetry} isRetrying />
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Null error renders no banner below:
            <FetchErrorBanner error={null} onRetry={noopRetry} />
          </div>
        </CardContent>
      </Card>
    </AppShell>
  )
}
