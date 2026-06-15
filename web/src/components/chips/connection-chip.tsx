import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatLastUpdate } from "@/lib/dashboard-format"

export type ConnectionChipState = "live" | "stale" | "disconnected"

export type ConnectionChipProps = {
  state: ConnectionChipState
  lastUpdateMs: number | null
  className?: string
}

const stateClasses: Record<ConnectionChipState, { dot: string; text: string }> = {
  live: {
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-500",
  },
  stale: {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-500",
  },
  disconnected: {
    dot: "bg-destructive",
    text: "text-destructive",
  },
}

function formatStateLabel(state: ConnectionChipState): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

export function ConnectionChip({ state, lastUpdateMs, className }: ConnectionChipProps) {
  const lastUpdateLabel = formatLastUpdate(lastUpdateMs)
  const label = formatStateLabel(state)
  const classes = stateClasses[state]

  return (
    <Badge
      variant="outline"
      className={cn("gap-2 whitespace-nowrap px-2.5 py-1 font-medium", className)}
      aria-label={`Connection ${state}, ${lastUpdateLabel}`}
    >
      <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", classes.dot)} />
      <span className={classes.text}>{label}</span>
      <span className="text-muted-foreground">{lastUpdateLabel}</span>
    </Badge>
  )
}
