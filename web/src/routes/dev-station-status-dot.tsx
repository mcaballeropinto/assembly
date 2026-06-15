import type { StationStatusState } from "../../../src/dashboard-api"

import { StationStatusDot } from "../components/chips/station-status-dot"

const states: StationStatusState[] = ["running", "idle", "blocked", "errored", "muted"]

export function DevStationStatusDotRoute() {
  return (
    <main className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-screen-2xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">Station Status Dot</h1>
        <div className="space-y-3">
          {states.map((state) => (
            <div key={state} className="flex items-center gap-3 text-sm capitalize">
              <StationStatusDot state={state} label={`${state} station status`} />
              <span>{state}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
