import { describe, expect, mock, test } from "bun:test"

mock.module("./app", () => ({
  default: () => null,
}))

mock.module("./dev/connection-chip-demo", () => ({
  ConnectionChipDemo: () => null,
}))

mock.module("./dev/usage-chip-demo", () => ({
  UsageChipDemo: () => null,
}))

mock.module("./dev/error-banner-demo", () => ({
  ErrorBannerDemo: () => null,
}))

mock.module("./dev/fetch-error-banner-demo", () => ({
  FetchErrorBannerDemo: () => null,
}))

const { router } = await import("./router")

describe("dashboard dev routes", () => {
  test("registers primitive demo routes", () => {
    expect(Object.keys(router.routesByPath)).toContain("/dev/connection-chip")
    expect(Object.keys(router.routesByPath)).toContain("/dev/usage-chip")
    expect(Object.keys(router.routesByPath)).toContain("/dev/error-banner")
    expect(Object.keys(router.routesByPath)).toContain("/dev/fetch-error-banner")
  })
})
