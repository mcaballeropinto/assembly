import { useMemo, useRef, useState, type ComponentType } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Filter,
  GitBranch,
  Inbox,
  RotateCcw,
  ShieldAlert,
  Zap,
} from "lucide-react"

import { Button } from "../button"
import { Card } from "../card"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../popover"
import { ScrollArea } from "../scroll-area"
import {
  ACTIVITY_FILTERS,
  type ActivityFilterKey,
  type DashboardActivityEvent,
} from "../../../lib/activity"
import { cn } from "../../../lib/utils"

interface ActivityFeedProps {
  items: DashboardActivityEvent[]
  selectedFilters: Set<ActivityFilterKey>
  onSelectedFiltersChange: (next: Set<ActivityFilterKey>) => void
  className?: string
  title?: string
  totalItems?: number
  onOpenWorkpiece?: (lineName: string, fileName: string) => void
}

export function ActivityFeed({
  items,
  selectedFilters,
  onSelectedFiltersChange,
  className,
  title = "Activity",
  totalItems,
  onOpenWorkpiece,
}: ActivityFeedProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const shouldVirtualize = items.length > 100
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 8,
    enabled: shouldVirtualize,
  })

  return (
    <Card className={cn("w-full p-6", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {totalItems === undefined
              ? items.length
              : `${items.length} of ${totalItems}`}
          </p>
        </div>
        <ActivityFilterCombobox
          selectedFilters={selectedFilters}
          onSelectedFiltersChange={onSelectedFiltersChange}
        />
      </div>

      <ScrollArea className="mt-4 h-[480px]" viewportRef={parentRef}>
        {items.length === 0 ? (
          <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
            No matching activity.
          </div>
        ) : shouldVirtualize ? (
          <ol
            className="relative"
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index]
              if (!item) return null

              return (
                <li
                  key={item.id}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <ActivityRow item={item} onOpenWorkpiece={onOpenWorkpiece} />
                </li>
              )
            })}
          </ol>
        ) : (
          <ol>
            {items.map((item) => (
              <li key={item.id}>
                <ActivityRow item={item} onOpenWorkpiece={onOpenWorkpiece} />
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
    </Card>
  )
}

interface ActivityFilterComboboxProps {
  selectedFilters: Set<ActivityFilterKey>
  onSelectedFiltersChange: (next: Set<ActivityFilterKey>) => void
}

function ActivityFilterCombobox({
  selectedFilters,
  onSelectedFiltersChange,
}: ActivityFilterComboboxProps) {
  const [open, setOpen] = useState(false)
  const selectedCount = selectedFilters.size
  const allSelected = selectedCount === ACTIVITY_FILTERS.length

  const label = useMemo(() => {
    if (allSelected) return "All events"
    if (selectedCount === 0) return "No events"
    return `${selectedCount} events`
  }, [allSelected, selectedCount])

  const toggleFilter = (key: ActivityFilterKey) => {
    const next = new Set(selectedFilters)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    onSelectedFiltersChange(next)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0">
          <Filter className="h-4 w-4" />
          <span className="max-w-24 truncate">{label}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Filter events..." />
          <CommandList>
            <CommandEmpty>No event types found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all"
                onSelect={() =>
                  onSelectedFiltersChange(
                    new Set(ACTIVITY_FILTERS.map((filter) => filter.key)),
                  )
                }
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    allSelected ? "opacity-100" : "opacity-0",
                  )}
                />
                All
              </CommandItem>
              <CommandItem
                value="clear"
                onSelect={() => onSelectedFiltersChange(new Set())}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    selectedCount === 0 ? "opacity-100" : "opacity-0",
                  )}
                />
                Clear
              </CommandItem>
            </CommandGroup>
            <CommandGroup>
              {ACTIVITY_FILTERS.map((filter) => (
                <CommandItem
                  key={filter.key}
                  value={filter.key}
                  onSelect={() => toggleFilter(filter.key)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selectedFilters.has(filter.key)
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                  {filter.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ActivityRow({
  item,
  onOpenWorkpiece,
}: {
  item: DashboardActivityEvent
  onOpenWorkpiece?: (lineName: string, fileName: string) => void
}) {
  const Icon = iconForEvent(item)
  const time = formatTime(item.ts)
  const clickable = Boolean(item.workpieceFile && onOpenWorkpiece)
  const Element = clickable ? "button" : "div"

  return (
    <Element
      type={clickable ? "button" : undefined}
      className="flex min-h-20 w-full items-start gap-3 border-b py-3 text-left last:border-0"
      aria-label={`${item.event} on ${item.line}`}
      onClick={
        clickable
          ? () => onOpenWorkpiece?.(item.line, item.workpieceFile!)
          : undefined
      }
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border bg-background",
          iconToneClass(item),
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{item.event}</span>
          {item.station && (
            <span className="max-w-36 truncate rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
              {item.station}
            </span>
          )}
          <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
            {item.line}
          </span>
          <time
            className="ml-auto text-xs tabular-nums text-muted-foreground"
            dateTime={item.ts}
          >
            {time}
          </time>
        </div>
        {item.detail && (
          <p
            title={item.detailTitle}
            className="mt-1 truncate text-sm text-muted-foreground"
          >
            {item.detail}
          </p>
        )}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          {item.workpieceFile && (
            <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {item.workpieceFile}
            </span>
          )}
          {item.silentSeconds !== undefined && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  silentClass(item.silentSeconds),
                )}
              />
              {item.silentSeconds}s silent
            </span>
          )}
        </div>
      </div>
    </Element>
  )
}

function iconForEvent(
  item: DashboardActivityEvent,
): ComponentType<{ className?: string }> {
  if (item.event === "routed" || item.event === "queued") return GitBranch
  if (item.iconKind === "done") return CheckCircle2
  if (item.iconKind === "retry") return RotateCcw
  if (item.iconKind === "error") return AlertTriangle
  if (item.iconKind === "routed") return ArrowRight
  if (item.iconKind === "escalated") return ShieldAlert
  if (item.iconKind === "task_received") return Inbox
  if (item.iconKind === "trigger") return Zap
  return Activity
}

function iconToneClass(item: DashboardActivityEvent): string {
  if (item.tone === "done") return "text-emerald-600"
  if (item.tone === "retry" || item.tone === "escalated") {
    return "text-amber-600"
  }
  if (item.tone === "error") return "text-destructive"
  if (item.tone === "routed") return "text-blue-600"
  if (item.tone === "trigger") return "text-violet-600"
  return "text-muted-foreground"
}

function silentClass(silentSeconds: number): string {
  if (silentSeconds < 90) return "bg-emerald-500"
  if (silentSeconds < 300) return "bg-amber-500"
  return "bg-destructive"
}

function formatTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}
