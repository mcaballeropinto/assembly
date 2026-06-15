import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import {
  clampPercent,
  findSoonestReset,
  formatLastUpdate,
  formatResetShort,
} from "@/lib/dashboard-format"

export type UsageBucket = {
  label: string
  utilization: number
  resets_at: string | null
}

export type UsageState = "healthy" | "warn" | "paused" | "unknown"

export type UsageChipProps = {
  state?: UsageState
  buckets: UsageBucket[]
  threshold?: number
  pauseReason?: string
  providerLabel?: string
  checkedAgeMs?: number | null
  className?: string
}

export type ClassifyUsageStateInput = {
  paused?: boolean
  buckets: UsageBucket[]
  ageMs?: number | null
  explicitState?: UsageState
  warnAt?: number
}

const staleUsageMs = 5 * 60 * 1000

export function classifyUsageState({
  paused = false,
  buckets,
  ageMs = 0,
  explicitState,
  warnAt = 50,
}: ClassifyUsageStateInput): UsageState {
  if (explicitState) {
    return explicitState
  }

  if (buckets.length === 0 || ageMs === null || ageMs > staleUsageMs) {
    return "unknown"
  }

  if (paused) {
    return "paused"
  }

  return buckets.some((bucket) => bucket.utilization >= warnAt) ? "warn" : "healthy"
}

const stateDisplay: Record<
  UsageState,
  { label: string; dot: string; text: string; description: string }
> = {
  healthy: {
    label: "Active",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-500",
    description: "Usage is within quota.",
  },
  warn: {
    label: "Elevated",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-500",
    description: "Usage is approaching the warning threshold.",
  },
  paused: {
    label: "Paused",
    dot: "bg-destructive",
    text: "text-destructive",
    description: "Quota use is paused.",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    description: "Usage data is unavailable.",
  },
}

function compactBucketLabel(bucket: UsageBucket): string {
  const label = bucket.label.trim().split(/\s+/)[0] || "Usage"
  return `${label} ${Math.round(clampPercent(bucket.utilization))}%`
}

export function UsageChip({
  state,
  buckets,
  threshold = 75,
  pauseReason,
  providerLabel = "Usage",
  checkedAgeMs = 0,
  className,
}: UsageChipProps) {
  const usageState = classifyUsageState({
    explicitState: state,
    paused: Boolean(pauseReason),
    buckets,
    ageMs: checkedAgeMs,
  })
  const display = stateDisplay[usageState]
  const soonestReset = findSoonestReset(buckets)
  const resetLabel = formatResetShort(soonestReset)
  const compactBuckets = buckets.length > 0 ? buckets.map(compactBucketLabel).join(" / ") : "no buckets"
  const checkedLabel = checkedAgeMs === null ? "not checked" : formatLastUpdate(checkedAgeMs)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-8 max-w-[28rem] justify-start gap-2 px-2.5", className)}
          aria-label={`${providerLabel} ${display.label.toLowerCase()}, ${resetLabel}`}
        >
          <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", display.dot)} />
          <span className={cn("font-medium", display.text)}>{display.label}</span>
          <span className="truncate text-muted-foreground">{compactBuckets}</span>
          <span className="hidden text-muted-foreground sm:inline">{resetLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="end">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium">{providerLabel}</div>
              <div className="text-xs text-muted-foreground">{display.description}</div>
            </div>
            <div className={cn("text-xs font-medium", display.text)}>{display.label}</div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Checked {checkedLabel}</span>
            <span>Visual threshold {threshold}%</span>
            <span>{resetLabel}</span>
          </div>

          {usageState === "paused" && pauseReason ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {pauseReason}
            </div>
          ) : null}

          {buckets.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
              No usage buckets are available from the provider.
            </div>
          ) : (
            <div className="space-y-3">
              {buckets.map((bucket) => {
                const value = clampPercent(bucket.utilization)
                const isOverThreshold = value >= threshold

                return (
                  <div className="space-y-1.5" key={`${bucket.label}-${bucket.resets_at ?? "unknown"}`}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium">{bucket.label}</span>
                      <span className={cn("tabular-nums", isOverThreshold ? "text-destructive" : "text-muted-foreground")}>
                        {Math.round(value)}%
                      </span>
                    </div>
                    <Progress value={value} className={cn(isOverThreshold && "bg-destructive/20")} />
                    <div className="text-xs text-muted-foreground">{formatResetShort(bucket.resets_at)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
