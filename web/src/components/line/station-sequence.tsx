import { Badge } from "../ui/badge"
import { Card } from "../ui/card"
import { cn } from "../../lib/utils"
import type { StationSequenceRow } from "../../lib/line-detail"

export function StationSequence({ rows }: { rows: StationSequenceRow[] }) {
  return (
    <Card className="p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold">Station Sequence</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Queue depth, processing state, and freshness for each station.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <div key={row.name} className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-sm font-medium">{row.name}</div>
              <Badge variant={row.state === "running" ? "default" : "secondary"}>
                {row.state}
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              <Metric label="In" value={row.inbox} />
              <Metric label="Run" value={row.processing} />
              <Metric label="Out" value={row.output} />
              <Metric label="Done" value={row.doneTotal} />
            </div>
            <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  "size-2 rounded-full",
                  row.state === "running"
                    ? "bg-emerald-500"
                    : row.state === "queued"
                      ? "bg-amber-500"
                      : "bg-muted-foreground",
                )}
              />
              <span className="truncate">
                {row.progress ?? row.freshnessLabel ?? "No recent progress"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-muted px-2 py-1">
      <div className="font-medium tabular-nums">{value}</div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  )
}
