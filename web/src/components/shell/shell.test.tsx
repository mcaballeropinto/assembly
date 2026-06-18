import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

import { Shell } from "./shell"

describe("Shell", () => {
  test("renders full-width main gutters without a centered max-width cap", () => {
    const markup = renderToString(
      createElement(Shell, null, createElement("span", null, "Overview")),
    )

    expect(markup).toContain("<main")
    expect(markup).toContain("w-full")
    expect(markup).toContain("px-4")
    expect(markup).toContain("sm:px-6")
    expect(markup).toContain("lg:px-8")
    expect(markup).toContain("2xl:px-10")
    expect(markup).not.toContain("max-w-screen-2xl")
    expect(markup).not.toContain("mx-auto")
  })
})
