import { ErrorBanner } from "../components/banners/error-banner"
import { AppShell } from "../components/shell/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { mockBannerErrors, noopDismiss } from "../lib/dashboard-mock-data"

export function ErrorBannerDemo() {
  const [critical, warning] = mockBannerErrors

  return (
    <AppShell>
      <Card>
        <CardHeader>
          <CardTitle>Error banner</CardTitle>
          <CardDescription>Empty, single warning, single critical, and collapsed multi-error states.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Empty state renders no banner below:
            <ErrorBanner errors={[]} />
          </div>
          <ErrorBanner errors={[warning]} onDismiss={noopDismiss} />
          <ErrorBanner errors={[critical]} onDismiss={noopDismiss} />
          <ErrorBanner errors={mockBannerErrors} onDismiss={noopDismiss} />
        </CardContent>
      </Card>
    </AppShell>
  )
}
