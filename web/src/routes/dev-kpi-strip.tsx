import { KpiStrip } from "../components/kpi/kpi-strip"
import type { KpiTileProps } from "../components/kpi/kpi-tile"

const items: KpiTileProps[] = [
  { label: "Inbox", value: "14", trend: { direction: "neutral", value: "flat" } },
  {
    label: "Running",
    value: "5",
    trend: { direction: "up", value: "+2" },
    sparkline: { data: [1, 2, 2, 3, 4, 5, 5], color: "emerald" },
  },
  {
    label: "Blocked",
    value: "2",
    trend: { direction: "down", value: "-1" },
    sparkline: { data: [5, 4, 4, 3, 3, 2, 2], color: "amber" },
  },
  { label: "Errored", value: "1", trend: { direction: "neutral", value: "same" } },
  {
    label: "Done",
    value: "86",
    trend: { direction: "up", value: "+12%" },
    sparkline: { data: [40, 44, 48, 57, 63, 72, 86], color: "blue" },
  },
  { label: "Reviews", value: "7" },
  {
    label: "Cost",
    value: "$4.82",
    trend: { direction: "down", value: "-8%" },
    sparkline: { data: [7, 6.8, 6.2, 5.7, 5.3, 4.9, 4.82], color: "zinc" },
  },
]

export function DevKpiStripRoute() {
  return (
    <main className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-screen-2xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">KPI Strip</h1>
        <KpiStrip items={items} />
      </div>
    </main>
  )
}
