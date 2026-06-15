import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { act } from "react-dom/test-utils"
import { createRoot } from "react-dom/client"

import { Header } from "../header"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}

function renderHeader(pathname: string) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const routeTree = createRootRoute({ component: Header })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [pathname] }),
  })

  act(() => {
    root.render(<RouterProvider router={router} />)
  })

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("Header", () => {
  test("renders the overview breadcrumb and placeholder badges", () => {
    const screen = renderHeader("/")

    expect(screen.container.textContent).toContain("Overview")
    expect(screen.container.textContent).toContain("TODO connection")
    expect(screen.container.textContent).toContain("TODO usage")
    expect(screen.container.textContent).toContain("TODO theme")

    screen.unmount()
  })

  test("renders a line breadcrumb from the pathname", () => {
    const screen = renderHeader("/line/assembly-dev")

    expect(screen.container.textContent).toContain("Line: assembly-dev")

    screen.unmount()
  })
})
