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
  test("renders the overview breadcrumb without placeholder badges", async () => {
    const screen = renderHeader("/")

    await waitFor(() => {
      expect(screen.container.textContent).toContain("Overview")
      expect(screen.container.textContent).not.toContain("TODO")
    })

    screen.unmount()
  })

  test("uses full-width header gutters without a max-width cap", async () => {
    const screen = renderHeader("/")

    await waitFor(() => {
      const inner = screen.container.querySelector("header > div")

      expect(inner?.className).toContain("w-full")
      expect(inner?.className).toContain("px-4")
      expect(inner?.className).toContain("sm:px-6")
      expect(inner?.className).toContain("lg:px-8")
      expect(inner?.className).toContain("2xl:px-10")
      expect(inner?.className).not.toContain("max-w-screen-2xl")
      expect(inner?.className).not.toContain("mx-auto")
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
