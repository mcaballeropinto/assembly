import type { StationStatusState } from "../../../../src/dashboard-api"

import { cn } from "../../lib/utils"

export interface StationStatusDotProps {
  state: StationStatusState
  label?: string
  className?: string
}

const statusClasses: Record<StationStatusState, string> = {
  running: "bg-emerald-600 dark:bg-emerald-500",
  idle: "bg-muted-foreground",
  blocked: "bg-amber-600 dark:bg-amber-500",
  errored: "bg-destructive",
  muted: "bg-muted-foreground/35",
}

export function StationStatusDot({
  state,
  label,
  className,
}: StationStatusDotProps) {
  return (
    <span
      role="img"
      aria-label={label ?? `Station status: ${state}`}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        statusClasses[state],
        className,
      )}
    />
  )
}
