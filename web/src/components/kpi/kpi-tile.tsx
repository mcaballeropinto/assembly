import type React from "react"
import { SparkLineChart } from "@tremor/react"
import { Minus, TrendingDown, TrendingUp } from "lucide-react"

import { Card, CardContent, CardHeader } from "../ui/card"
import { cn } from "../../lib/utils"

export type KpiTrendDirection = "up" | "down" | "neutral"

export interface KpiTrend {
  direction: KpiTrendDirection
  value: string
  label?: string
}

export interface KpiSparkline {
  data: number[]
  color?: "emerald" | "amber" | "red" | "zinc" | "blue"
  label?: string
}

export interface KpiTileProps {
  label: string
  value: React.ReactNode
  trend?: KpiTrend
  sparkline?: KpiSparkline
  className?: string
}

const trendClasses: Record<KpiTrendDirection, string> = {
  up: "text-emerald-600 dark:text-emerald-500",
  down: "text-destructive",
  neutral: "text-muted-foreground",
}

const trendIcons = {
  up: TrendingUp,
  down: TrendingDown,
  neutral: Minus,
}

export function KpiTile({
  label,
  value,
  trend,
  sparkline,
  className,
}: KpiTileProps) {
  const hasSparkline = sparkline !== undefined && sparkline.data.length > 0
  const TrendIcon = trend ? trendIcons[trend.direction] : null

  return (
    <Card className={cn("p-4", className)}>
      <CardHeader className="p-0">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="text-2xl font-semibold tracking-tight tabular-nums">
              {value}
            </div>
            {trend ? (
              <div
                className={cn(
                  "flex items-center gap-1 text-xs font-medium",
                  trendClasses[trend.direction],
                )}
              >
                {TrendIcon ? <TrendIcon className="h-3.5 w-3.5" /> : null}
                <span>{trend.value}</span>
                {trend.label ? <span>{trend.label}</span> : null}
              </div>
            ) : null}
          </div>
          {hasSparkline ? (
            <SparkLineChart
              data={sparkline.data.map((point, index) => ({
                index: String(index),
                value: point,
              }))}
              categories={["value"]}
              index="index"
              colors={[sparkline.color ?? "zinc"]}
              className="h-10 w-24 shrink-0"
              showAnimation={false}
              autoMinValue
              aria-label={sparkline.label}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
