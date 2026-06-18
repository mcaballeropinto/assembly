import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type React from "react"
import { createRoot, type Root } from "react-dom/client"

import type { DashboardActivityEvent } from "../../../lib/activity"

const TEST_ROW_HEIGHT = 96

mock.module("../button", () => ({
  Button: ({
    className,
    asChild: _asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => (
    <button className={className} {...props} />
  ),
}))

mock.module("../card", () => ({
  Card: ({
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={className} {...props} />
  ),
}))

mock.module("../command", () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input placeholder={placeholder} />
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: React.ReactNode
    onSelect?: () => void
    value?: string
  }) => (
    <button data-value={value} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

mock.module("../popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({
    className,
    children,
  }: {
    className?: string
    children: React.ReactNode
  }) => <div className={className}>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

mock.module("../scroll-area", () => ({
  ScrollArea: ({
    className,
    viewportRef,
    children,
  }: {
    className?: string
    viewportRef?: React.Ref<HTMLDivElement>
    children: React.ReactNode
  }) => (
    <div className={className} ref={viewportRef}>
      {children}
    </div>
  ),
}))

mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * TEST_ROW_HEIGHT,
    getVirtualItems: () =>
      [0, 1, 2].map((index) => ({
        index,
        key: index,
        start: index * TEST_ROW_HEIGHT,
        size: TEST_ROW_HEIGHT,
      })),
    measureElement: () => undefined,
  }),
}))

const { ActivityFeed } = await import("./activity-feed.tsx?layout-test")

beforeAll(() => {
  try {
    GlobalRegistrator.register()
  } catch {
    // Another test file may already have registered happy-dom.
  }
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

let roots: Root[] = []

afterEach(() => {
  act(() => {
    for (const root of roots) {
      root.unmount()
    }
  })
  roots = []
  document.body.innerHTML = ""
})

function render(element: React.ReactElement) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  act(() => {
    root.render(element)
  })

  return container
}

function createActivityItem(index: number): DashboardActivityEvent {
  const padded = String(index).padStart(3, "0")

  return {
    id: `activity-${padded}`,
    line: `line-with-a-very-long-name-that-must-truncate-${padded}`,
    ts: `2026-06-18T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    event: `station_done_with_extremely_long_event_name_${padded}`,
    station: `station-with-a-very-long-name-that-must-truncate-${padded}`,
    workpiece: `workpiece-${padded}`,
    workpieceFile: `workpiece-with-a-very-long-file-name-that-must-truncate-${padded}.json`,
    detail:
      "This activity detail is intentionally long enough to overflow the dashboard activity row unless it is truncated by the row layout.",
    detailTitle:
      "This activity detail is intentionally long enough to overflow the dashboard activity row unless it is truncated by the row layout.",
    silentSeconds: index,
    filterKey: "station_done",
    tone: "done",
    iconKind: "done",
    raw: {},
  }
}

function renderFeed(items: DashboardActivityEvent[]) {
  return render(
    <ActivityFeed
      items={items}
      selectedFilters={new Set(["station_done"])}
      onSelectedFiltersChange={() => undefined}
    />,
  )
}

describe("ActivityFeed row layout", () => {
  test("uses one stable row height for virtual offsets and row boxes", () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      createActivityItem(index),
    )
    const container = renderFeed(items)

    const virtualRows = Array.from(
      container.querySelectorAll("ol.relative > li"),
    ) as HTMLElement[]
    expect(virtualRows).toHaveLength(3)

    expect(virtualRows.map((row) => row.style.height)).toEqual([
      "96px",
      "96px",
      "96px",
    ])
    expect(virtualRows.map((row) => row.style.transform)).toEqual([
      "translateY(0px)",
      "translateY(96px)",
      "translateY(192px)",
    ])

    for (const row of virtualRows) {
      expect(row.className).toContain("box-border")
      expect(row.className).toContain("overflow-hidden")

      const activityRow = row.querySelector(
        "[data-testid='activity-row']",
      ) as HTMLElement | null
      expect(activityRow).not.toBeNull()
      expect(activityRow?.className).toContain("h-24")
      expect(activityRow?.className).toContain("box-border")
      expect(activityRow?.className).toContain("overflow-hidden")
    }
  })

  test("keeps non-virtual rows height-bounded with truncated long content", () => {
    const items = [createActivityItem(0), createActivityItem(1)]
    const container = renderFeed(items)

    const rows = Array.from(
      container.querySelectorAll("[data-testid='activity-row']"),
    ) as HTMLElement[]

    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain(
      "station_done_with_extremely_long_event_name_000",
    )
    expect(rows[1]?.textContent).toContain(
      "workpiece-with-a-very-long-file-name-that-must-truncate-001.json",
    )

    for (const row of rows) {
      expect(row.className).toContain("h-24")
      expect(row.className).toContain("box-border")
      expect(row.className).toContain("overflow-hidden")
    }

    const details = Array.from(
      container.querySelectorAll("p[title]"),
    ) as HTMLElement[]
    expect(details).toHaveLength(2)
    expect(details.every((detail) => detail.className.includes("truncate"))).toBe(
      true,
    )
  })

  test("preserves the empty state", () => {
    const container = renderFeed([])

    expect(container.textContent).toContain("No matching activity.")
  })
})
