import { describe, expect, mock, test } from "bun:test"
import { createMemoryHistory } from "@tanstack/react-router"

import {
  closeWorkpieceSearch,
  openWorkpieceSearch,
} from "../lib/drawer-url"

mock.module("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}))

async function createTestRouter(initialEntry = "/") {
  const { createDashboardRouter } = await import("../router")
  const history = createMemoryHistory({
    initialEntries: [initialEntry],
  })

  return createDashboardRouter({ history })
}

describe("dashboard router drawer search params", () => {
  test("round-trips drawer open, navigation, and close", async () => {
    const router = await createTestRouter("/")

    await router.load()
    await router.navigate({
      to: "/",
      search: (prev) => openWorkpieceSearch(prev, "foo.json"),
    })

    expect(router.state.location.href).toBe("/?wp=foo.json")

    await router.navigate({
      to: "/line/$name",
      params: { name: "assembly-dev" },
      search: (prev) => prev,
    })

    expect(router.state.location.href).toBe("/line/assembly-dev?wp=foo.json")

    await router.navigate({
      search: (prev) => closeWorkpieceSearch(prev),
    })

    expect(router.state.location.href).toBe("/line/assembly-dev")
  })

  test("preserves unrelated search params while opening and closing", async () => {
    const router = await createTestRouter("/?tab=activity")

    await router.load()
    await router.navigate({
      to: "/",
      search: (prev) => openWorkpieceSearch(prev, "foo.json"),
    })

    expect(router.state.location.href).toBe("/?tab=activity&wp=foo.json")

    await router.navigate({
      to: "/line/$name",
      params: { name: "assembly-dev" },
      search: (prev) => prev,
    })

    expect(router.state.location.href).toBe(
      "/line/assembly-dev?tab=activity&wp=foo.json",
    )

    await router.navigate({
      search: (prev) => closeWorkpieceSearch(prev),
    })

    expect(router.state.location.href).toBe("/line/assembly-dev?tab=activity")
  })
})
