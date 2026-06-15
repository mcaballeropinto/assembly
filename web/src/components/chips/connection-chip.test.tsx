import { describe, expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

mock.module("@/components/ui/badge", () => ({
  Badge: ({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: string }) => (
    <div className={`${variant ?? ""} ${className ?? ""}`} {...props} />
  ),
}))

mock.module("@/lib/utils", () => ({
  cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(" "),
}))

mock.module("@/lib/dashboard-format", () => ({
  formatLastUpdate: (ms: number | null) => {
    if (ms === null) {
      return "not connected"
    }
    return ms >= 60_000 ? "1m ago" : "just now"
  },
}))

const { ConnectionChip } = await import("./connection-chip")
type ConnectionChipState = import("./connection-chip").ConnectionChipState

describe("ConnectionChip", () => {
  test.each([
    ["live", "Live", "bg-emerald-500", "text-emerald-600"] as const,
    ["stale", "Stale", "bg-amber-500", "text-amber-600"] as const,
    ["disconnected", "Disconnected", "bg-destructive", "text-destructive"] as const,
  ])("renders %s state labels and classes", (state: ConnectionChipState, label, dotClass, textClass) => {
    const markup = renderToStaticMarkup(<ConnectionChip state={state} lastUpdateMs={65_000} />)

    expect(markup).toContain(label)
    expect(markup).toContain("1m ago")
    expect(markup).toContain(dotClass)
    expect(markup).toContain(textClass)
    expect(markup).toContain(`Connection ${state}`)
  })

  test("renders not connected for a null last update", () => {
    const markup = renderToStaticMarkup(<ConnectionChip state="disconnected" lastUpdateMs={null} />)

    expect(markup).toContain("not connected")
  })
})
