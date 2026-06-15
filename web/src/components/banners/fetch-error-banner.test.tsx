import { describe, expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

mock.module("lucide-react", () => ({
  RefreshCw: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
}))

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

const { FetchErrorBanner } = await import("./fetch-error-banner")

describe("FetchErrorBanner", () => {
  test("renders empty markup without an error", () => {
    expect(renderToStaticMarkup(<FetchErrorBanner error={null} onRetry={() => {}} />)).toBe("")
  })

  test("renders string and Error messages", () => {
    expect(
      renderToStaticMarkup(<FetchErrorBanner error="Network unavailable" onRetry={() => {}} />)
    ).toContain("Network unavailable")
    expect(
      renderToStaticMarkup(<FetchErrorBanner error={new Error("Timeout")} onRetry={() => {}} />)
    ).toContain("Timeout")
  })

  test("renders amber classes", () => {
    const markup = renderToStaticMarkup(<FetchErrorBanner error="Failed" onRetry={() => {}} />)

    expect(markup).toContain("border-amber-200")
    expect(markup).toContain("bg-amber-50")
    expect(markup).toContain("text-amber-900")
  })

  test("exposes retry callback and retrying state", () => {
    let retried = false
    const element = FetchErrorBanner({
      error: "Failed",
      onRetry: () => {
        retried = true
      },
      isRetrying: true,
    }) as React.ReactElement
    const button = element.props.children[1]

    button.props.onClick()

    expect(retried).toBe(true)
    expect(button.props.disabled).toBe(true)
    expect(renderToStaticMarkup(element)).toContain("Retrying")
  })
})
