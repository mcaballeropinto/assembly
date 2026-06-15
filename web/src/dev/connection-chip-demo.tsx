import { ConnectionChip } from "@/components/chips/connection-chip"
import { AppShell } from "@/components/shell/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { mockConnectionStates } from "@/lib/dashboard-mock-data"

export function ConnectionChipDemo() {
  return (
    <AppShell>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Connection chip</CardTitle>
          <CardDescription>Live, stale, and disconnected states.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <ConnectionChip {...mockConnectionStates.live} />
          <ConnectionChip {...mockConnectionStates.stale} />
          <ConnectionChip {...mockConnectionStates.disconnected} />
        </CardContent>
      </Card>
    </AppShell>
  )
}
