import { useQuery } from "@tanstack/react-query"

import { Card } from "../ui/card"
import { fetchFlowMetrics } from "../../lib/api"

export function FlowMetrics({ lineName }: { lineName: string }) {
  const metrics = useQuery({
    queryKey: ["line", lineName, "flow-metrics"],
    queryFn: () => fetchFlowMetrics(lineName),
  })

  return (
    <Card className="p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold">Flow Metrics</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Throughput, cycle time, wait time, and success rate.
        </p>
      </div>
      {metrics.isLoading ? (
        <div className="grid gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-24 rounded-md bg-muted" />
          ))}
        </div>
      ) : metrics.isError ? (
        <p className="text-sm text-destructive">
          {metrics.error instanceof Error ? metrics.error.message : "Failed to load flow metrics."}
        </p>
      ) : metrics.data?.tiles.length ? (
        <div className="grid gap-3 md:grid-cols-5">
          {metrics.data.tiles.map((tile) => (
            <div key={tile.label} className="rounded-md border p-3" title={tile.explanation}>
              <div className="text-xs text-muted-foreground">{tile.label}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{tile.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {tile.unit}
                {tile.delta == null ? "" : ` · ${tile.delta > 0 ? "+" : ""}${tile.delta}%`}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No data yet. Metrics appear after the first workpiece completes.
        </p>
      )}
    </Card>
  )
}
