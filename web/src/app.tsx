import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ErrorBanner } from "@/components/banners/error-banner"
import { FetchErrorBanner } from "@/components/banners/fetch-error-banner"
import {
  mockBannerErrors,
  mockConnectionStates,
  mockFetchError,
  mockUsageWarn,
  noopDismiss,
  noopRetry,
} from "@/lib/dashboard-mock-data"
import { Header } from "./components/shell/header"
import { Sidebar } from "./components/shell/sidebar"

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header connection={mockConnectionStates.live} usage={mockUsageWarn} />
      <div className="flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-screen-2xl px-6 pb-12 pt-6 lg:px-8">
            <div className="space-y-8">
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
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
