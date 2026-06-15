import { KpiStrip } from "../components/kpi/kpi-strip"
import type { ApiStateTotals } from "../lib/api"

const totals: ApiStateTotals = {
  lines: 7,
  linesRunning: 5,
  linesErrored: 1,
  totalInbox: 14,
  totalDone: 86,
  totalErrors: 1,
  totalReview: 7,
  totalCostUsd: 4.82,
  totalThroughput1h: 6,
  totalThroughput24h: 28,
}

export function DevKpiStripRoute() {
  return (
    <main className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-screen-2xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">KPI Strip</h1>
        <KpiStrip totals={totals} />
      </div>
    </main>
  )
}
