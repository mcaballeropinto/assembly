import type { ApiStateTotals } from "../../lib/api"
import type { KpiTileProps } from "./kpi-tile"

import { cn } from "../../lib/utils"
import { KpiTile } from "./kpi-tile"

export interface KpiStripProps {
  totals: ApiStateTotals
  className?: string
}

export function buildKpiItems(totals: ApiStateTotals): KpiTileProps[] {
  return [
    { label: "Lines", value: totals.lines.toLocaleString() },
    { label: "Running", value: totals.linesRunning.toLocaleString() },
    { label: "Incoming", value: totals.totalInbox.toLocaleString() },
    { label: "Done", value: totals.totalDone.toLocaleString() },
    { label: "Errors", value: totals.totalErrors.toLocaleString() },
    { label: "Review", value: totals.totalReview.toLocaleString() },
    { label: "Recent Cost", value: formatUsd(totals.totalCostUsd) },
    {
      label: "Throughput",
      value: `${totals.totalThroughput1h.toLocaleString()}/hr · ${totals.totalThroughput24h.toLocaleString()}/day`,
    },
  ]
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00"

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value)
}

export function KpiStrip({ totals, className }: KpiStripProps) {
  const items = buildKpiItems(totals)

  return (
    <section
      className={cn("grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-4", className)}
    >
      {items.map((item) => (
        <KpiTile key={item.label} {...item} />
      ))}
    </section>
  )
}
