// Vendored from ReUI Radix timeline component docs, retrieved 2026-06-09; do not edit without noting upstream.
import * as React from "react"

import { cn } from "@/lib/utils"

type TimelineContextValue = {
  orientation: "horizontal" | "vertical"
  value: number
  onValueChange?: (value: number) => void
}

const TimelineContext = React.createContext<TimelineContextValue | null>(null)
const TimelineItemContext = React.createContext<{ step: number } | null>(null)

function useTimeline() {
  const context = React.useContext(TimelineContext)
  if (!context) {
    throw new Error("Timeline components must be used within Timeline")
  }

  return context
}

function useTimelineItem() {
  const context = React.useContext(TimelineItemContext)
  if (!context) {
    throw new Error("Timeline item components must be used within TimelineItem")
  }

  return context
}

export type TimelineProps = React.HTMLAttributes<HTMLDivElement> & {
  defaultValue?: number
  onValueChange?: (value: number) => void
  orientation?: "horizontal" | "vertical"
  value?: number
}

export function Timeline({
  className,
  defaultValue = 1,
  onValueChange,
  orientation = "vertical",
  value,
  ...props
}: TimelineProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue)
  const activeValue = value ?? internalValue

  const handleValueChange = React.useCallback(
    (nextValue: number) => {
      if (value === undefined) {
        setInternalValue(nextValue)
      }
      onValueChange?.(nextValue)
    },
    [onValueChange, value]
  )

  const contextValue = React.useMemo(
    () => ({
      orientation,
      value: activeValue,
      onValueChange: handleValueChange,
    }),
    [activeValue, handleValueChange, orientation]
  )

  return (
    <TimelineContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex",
          orientation === "vertical" ? "flex-col" : "flex-row",
          className
        )}
        data-orientation={orientation}
        {...props}
      />
    </TimelineContext.Provider>
  )
}

export type TimelineItemProps = React.HTMLAttributes<HTMLDivElement> & {
  step: number
}

export function TimelineItem({
  className,
  step,
  ...props
}: TimelineItemProps) {
  const { onValueChange, orientation } = useTimeline()

  return (
    <TimelineItemContext.Provider value={{ step }}>
      <div
        className={cn(
          "relative flex gap-4",
          orientation === "vertical" ? "pb-8 last:pb-0" : "min-w-32 flex-1",
          className
        )}
        data-step={step}
        onClick={() => onValueChange?.(step)}
        {...props}
      />
    </TimelineItemContext.Provider>
  )
}

export function TimelineDate({
  className,
  ...props
}: React.HTMLAttributes<HTMLTimeElement>) {
  return (
    <time
      className={cn("text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

export function TimelineHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-1", className)} {...props} />
}

export function TimelineIndicator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { value } = useTimeline()
  const { step } = useTimelineItem()
  const active = step <= value

  return (
    <div
      className={cn(
        "z-10 flex size-4 shrink-0 items-center justify-center rounded-full border bg-background",
        active ? "border-primary bg-primary" : "border-border",
        className
      )}
      data-active={active}
      {...props}
    />
  )
}

export function TimelineSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { orientation } = useTimeline()

  return (
    <div
      className={cn(
        "absolute bg-border",
        orientation === "vertical"
          ? "bottom-0 left-2 top-4 w-px"
          : "left-4 right-0 top-2 h-px",
        className
      )}
      {...props}
    />
  )
}

export function TimelineTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-medium", className)} {...props} />
}

export function TimelineContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-w-0 flex-1 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}
