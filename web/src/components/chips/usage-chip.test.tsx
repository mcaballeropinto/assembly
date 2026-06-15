import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type React from "react"
import { createRoot, type Root } from "react-dom/client"

mock.module("@/components/ui/button", () => ({
  Button: ({ className, asChild: _asChild, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => (
    <button className={className} {...props} />
  ),
}))

mock.module("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ className, children }: { className?: string; children: React.ReactNode }) => (
    <div className={className}>{children}</div>
  ),
}))

mock.module("@/components/ui/progress", () => ({
  Progress: ({ value, className }: { value?: number | null; className?: string }) => (
    <div className={className} role="progressbar" aria-valuenow={value ?? 0} />
  ),
}))

mock.module("@/lib/utils", () => ({
  cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(" "),
}))

mock.module("@/lib/dashboard-format", () => ({
  clampPercent: (value: number) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)),
  findSoonestReset: (buckets: Array<{ resets_at: string | null }>) =>
    buckets
      .map((bucket) => bucket.resets_at)
      .filter(Boolean)
      .sort()[0] ?? null,
  formatLastUpdate: (ms: number | null) => (ms === null ? "not checked" : "30s ago"),
  formatResetShort: (iso: string | null) => (iso ? "resets 45m" : "reset unknown"),
}))

const { UsageChip, classifyUsageState } = await import("./usage-chip")
type UsageBucket = import("./usage-chip").UsageBucket

beforeAll(() => {
  GlobalRegistrator.register()
})

let roots: Root[] = []

afterEach(() => {
  for (const root of roots) {
    root.unmount()
  }
  roots = []
  document.body.innerHTML = ""
})

function render(element: React.ReactElement) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  root.render(element)
  return container
}

async function openUsageChip(container: HTMLElement) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  const trigger = container.querySelector("button")
  trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const buckets: UsageBucket[] = [
  { label: "Hourly tokens", utilization: 25, resets_at: new Date(Date.now() + 45 * 60_000).toISOString() },
  { label: "Daily tokens", utilization: 82, resets_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString() },
]

describe("classifyUsageState", () => {
  test("honors explicit state", () => {
    expect(classifyUsageState({ explicitState: "paused", buckets })).toBe("paused")
  })

  test("returns unknown for empty or stale data", () => {
    expect(classifyUsageState({ buckets: [] })).toBe("unknown")
    expect(classifyUsageState({ buckets, ageMs: 10 * 60_000 })).toBe("unknown")
  })

  test("returns paused and warn states", () => {
    expect(classifyUsageState({ buckets, paused: true })).toBe("paused")
    expect(classifyUsageState({ buckets, warnAt: 80 })).toBe("warn")
  })
})

describe("UsageChip", () => {
  test("renders compact state and opens w-96 popover content", async () => {
    const container = render(<UsageChip buckets={buckets} providerLabel="Codex" checkedAgeMs={30_000} />)

    await openUsageChip(container)

    expect(container.textContent).toContain("Elevated")
    expect(container.textContent).toContain("Hourly 25%")
    expect(document.body.innerHTML).toContain("w-96")
    expect(document.body.textContent).toContain("Codex")
    expect(document.body.textContent).toContain("Daily tokens")
    expect(document.body.textContent).toContain("82%")
    expect(document.body.textContent).toContain("resets")
  })

  test("renders paused pause reason", async () => {
    const container = render(
      <UsageChip state="paused" buckets={buckets} pauseReason="Provider pause window is active." />
    )

    await openUsageChip(container)

    expect(document.body.textContent).toContain("Paused")
    expect(document.body.textContent).toContain("Provider pause window is active.")
  })

  test("renders unknown empty state", async () => {
    const container = render(<UsageChip buckets={[]} checkedAgeMs={null} />)

    await openUsageChip(container)

    expect(container.textContent).toContain("Unknown")
    expect(document.body.textContent).toContain("No usage buckets are available")
  })
})
