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
    { label: "Lines", value: `${totals.linesRunning}/${totals.lines}` },
    { label: "Inbox", value: totals.totalInbox.toLocaleString() },
    { label: "Done", value: totals.totalDone.toLocaleString() },
    { label: "Errors", value: totals.totalErrors.toLocaleString() },
    { label: "Review", value: totals.totalReview.toLocaleString() },
    { label: "Cost", value: formatUsd(totals.totalCostUsd) },
    {
      label: "Throughput 24h",
      value: totals.totalThroughput24h.toLocaleString(),
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
      className={cn("grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4", className)}
    >
      {items.map((item) => (
        <KpiTile key={item.label} {...item} />
      ))}
    </section>
  )
}
