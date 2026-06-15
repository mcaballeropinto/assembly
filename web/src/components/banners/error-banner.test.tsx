import { describe, expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

mock.module("@/components/ui/alert", () => ({
  Alert: ({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: string }) => (
    <div role="alert" className={`${variant ?? ""} ${className ?? ""}`} {...props} />
  ),
  AlertTitle: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h5 {...props} />,
  AlertDescription: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}))

mock.module("@/components/ui/button", () => ({
  Button: ({ className, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button className={className} {...props} />
  ),
}))

mock.module("@/lib/utils", () => ({
  cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(" "),
}))

const { ErrorBanner } = await import("./error-banner")
type DashboardErrorBannerItem = import("./error-banner").DashboardErrorBannerItem

const warning: DashboardErrorBannerItem = {
  fileName: "FANOUT-1.json",
  lineName: "assembly-dev",
  task: "Render dashboard",
  severity: "warning",
  failed: [{ station: "develop", error: "Bun test failed" }],
}

describe("ErrorBanner", () => {
  test("renders empty markup when there are no visible errors", () => {
    expect(renderToStaticMarkup(<ErrorBanner errors={[]} />)).toBe("")
    expect(renderToStaticMarkup(<ErrorBanner errors={[{ ...warning, severity: "suppressed" }]} />)).toBe("")
  })

  test("renders a single error", () => {
    const markup = renderToStaticMarkup(<ErrorBanner errors={[warning]} />)

    expect(markup).toContain("Active error")
    expect(markup).toContain("assembly-dev / FANOUT-1.json")
    expect(markup).toContain("Render dashboard")
    expect(markup).toContain("develop: Bun test failed")
  })

  test("collapses multiple errors behind +N more", () => {
    const markup = renderToStaticMarkup(
      <ErrorBanner
        errors={[
          warning,
          { fileName: "FANOUT-2.json", message: "Second failure", severity: "warning" },
          { fileName: "FANOUT-3.json", message: "Third failure", severity: "critical" },
        ]}
      />
    )

    expect(markup).toContain("Active errors")
    expect(markup).toContain("+2 more")
  })

  test("dismisses all visible file names", () => {
    let dismissed: string[] = []
    const element = ErrorBanner({
      errors: [
        warning,
        { fileName: "hidden.json", severity: "suppressed" },
        { fileName: "visible.json", message: "Visible", severity: "critical" },
      ],
      onDismiss: (fileNames) => {
        dismissed = fileNames
      },
    })

    const button = (element as React.ReactElement).props.children[1]
    button.props.onClick()

    expect(dismissed).toEqual(["FANOUT-1.json", "visible.json"])
  })

  test("applies critical left-bar accent", () => {
    const markup = renderToStaticMarkup(
      <ErrorBanner errors={[{ ...warning, severity: "critical" }]} />
    )

    expect(markup).toContain("before:left-0")
    expect(markup).toContain("before:w-1")
    expect(markup).toContain("before:bg-destructive")
  })
})
