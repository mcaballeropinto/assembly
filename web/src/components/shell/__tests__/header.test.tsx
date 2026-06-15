import { afterEach, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { act } from "react-dom/test-utils"
import { createRoot } from "react-dom/client"

mock.module("../../ui/badge", () => {
  return {
    Badge({ variant, ...props }: { variant?: string }) {
      return <div data-variant={variant} {...props} />
    },
  }
})

const { Header } = await import("../header")

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

async function waitFor(assertion: () => void) {
  let error: unknown

  for (let index = 0; index < 20; index += 1) {
    try {
      assertion()
      return
    } catch (caught) {
      error = caught
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  throw error
}

describe("Header", () => {
  test("renders the overview breadcrumb and placeholder badges", async () => {
    const screen = renderHeader("/")

    await waitFor(() => {
      expect(screen.container.textContent).toContain("Overview")
      expect(screen.container.textContent).toContain("TODO connection")
      expect(screen.container.textContent).toContain("TODO usage")
      expect(screen.container.textContent).toContain("TODO theme")
    })

    screen.unmount()
  })

  test("renders a line breadcrumb from the pathname", async () => {
    const screen = renderHeader("/line/assembly-dev")

    await waitFor(() => {
      expect(screen.container.textContent).toContain("Line: assembly-dev")
    })

    screen.unmount()
  })
})
