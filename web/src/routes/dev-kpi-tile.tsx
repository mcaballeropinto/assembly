import { KpiTile } from "../components/kpi/kpi-tile"

export function DevKpiTileRoute() {
  return (
    <main className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-screen-2xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">KPI Tile</h1>
        <div className="grid gap-4 md:grid-cols-3">
          <KpiTile label="Queued" value="42" />
          <KpiTile
            label="Throughput"
            value="128"
            trend={{ direction: "up", value: "+18%", label: "vs last hour" }}
            sparkline={{ data: [18, 22, 21, 28, 33, 38, 44], color: "emerald" }}
          />
          <KpiTile
            label="Errors"
            value="3"
            trend={{ direction: "down", value: "-2", label: "active" }}
            sparkline={{ data: [9, 8, 8, 6, 5, 4, 3], color: "red" }}
          />
        </div>
      </div>
    </main>
  )
}
