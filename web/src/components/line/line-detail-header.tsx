import { Badge } from "../ui/badge"
import { Card } from "../ui/card"
import { formatRelativeTime } from "../../lib/dashboard-format"
import type { ApiLineStateResponse } from "../../lib/api"

export function LineDetailHeader({
  state,
}: {
  state: Extract<ApiLineStateResponse, { line: string }>
}) {
  const healthState = state.health?.state ?? "unknown"

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {state.line}
          </h1>
          {state.description ? (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {state.description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={healthState === "errors" ? "destructive" : "secondary"}>
            {healthState}
          </Badge>
          <Badge variant="outline">{formatRelativeTime(state.timestamp)}</Badge>
        </div>
      </div>
      {state.health?.detail ? (
        <p className="mt-3 text-sm text-muted-foreground">{state.health.detail}</p>
      ) : null}
    </Card>
  )
}
