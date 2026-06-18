import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { Button } from "../ui/button"
import { Card } from "../ui/card"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { fetchLineHistory } from "../../lib/api"
import { formatDuration, formatTaskPreview } from "../../lib/dashboard-format"
import { historyQueryDefaults } from "../../lib/line-detail"

export function HistoryTable({
  lineName,
  onOpenWorkpiece,
}: {
  lineName: string
  onOpenWorkpiece: (fileName: string) => void
}) {
  const defaults = historyQueryDefaults()
  const [expanded, setExpanded] = useState(false)
  const [limit, setLimit] = useState(defaults.limit)
  const [includeErrors, setIncludeErrors] = useState(false)
  const include: Array<"done" | "error"> = includeErrors ? ["done", "error"] : ["done"]
  const history = useQuery({
    queryKey: ["line", lineName, "history", limit, include.join(",")],
    queryFn: () => fetchLineHistory(lineName, { limit, include }),
    enabled: expanded,
  })

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">History</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Recent runs with per-station durations.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Hide" : "Load history"}
        </Button>
      </div>
      {expanded ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={includeErrors ? "done,error" : "done"} onValueChange={(value) => setIncludeErrors(value === "done,error")}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="done">Done only</SelectItem>
                <SelectItem value="done,error">Done + errors</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="w-24"
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(event) => setLimit(Math.max(1, Math.min(50, Number(event.target.value) || 10)))}
              aria-label="History limit"
            />
          </div>
          {history.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading history...</p>
          ) : history.isError ? (
            <p className="text-sm text-destructive">
              {history.error instanceof Error ? history.error.message : "Failed to load history."}
            </p>
          ) : history.data ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Run</th>
                    <th className="py-2 pr-3 font-medium">Task</th>
                    <th className="py-2 pr-3 font-medium">Total</th>
                    {history.data.sequence.map((station) => (
                      <th key={station} className="py-2 pr-3 font-medium">{station}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.data.runs.map((run) => (
                    <tr key={run.fileName} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <button type="button" className="font-medium text-primary hover:underline" onClick={() => onOpenWorkpiece(run.fileName)}>
                          {run.id}
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{formatTaskPreview(run.task, 60)}</td>
                      <td className="py-2 pr-3 tabular-nums">{formatDuration(run.duration_ms)}</td>
                      {history.data.sequence.map((station) => (
                        <td key={`${run.fileName}-${station}`} className="py-2 pr-3 tabular-nums">
                          {formatDuration(run.stations[station]?.duration_ms)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
