import { UsageChip } from "@/components/chips/usage-chip"
import { AppShell } from "@/components/shell/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  mockUsageHealthy,
  mockUsagePaused,
  mockUsageUnknown,
  mockUsageWarn,
} from "@/lib/dashboard-mock-data"

export function UsageChipDemo() {
  return (
    <AppShell>
      <Card className="max-w-4xl">
        <CardHeader>
          <CardTitle>Usage chip</CardTitle>
          <CardDescription>Healthy, elevated, paused, and unknown quota states.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <UsageChip {...mockUsageHealthy} />
          <UsageChip {...mockUsageWarn} />
          <UsageChip {...mockUsagePaused} />
          <UsageChip {...mockUsageUnknown} />
        </CardContent>
      </Card>
    </AppShell>
  )
}
