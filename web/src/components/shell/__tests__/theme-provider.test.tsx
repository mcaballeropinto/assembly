import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react-dom/test-utils"
import { createRoot } from "react-dom/client"
import { useTheme } from "next-themes"
import type { ReactNode } from "react"

import { ThemeProvider } from "../theme-provider"

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}

function render(ui: ReactNode) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(ui)
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

afterEach(() => {
  document.body.innerHTML = ""
  document.documentElement.className = ""
  localStorage.clear()
})

describe("ThemeProvider", () => {
  test("defaults to system and stores theme under the dashboard key", async () => {
    function ThemeProbe() {
      const { setTheme, theme } = useTheme()

      return (
        <button type="button" onClick={() => setTheme("dark")}>
          {theme}
        </button>
      )
    }

    const screen = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.container.textContent).toContain("system")
    })

    const button = screen.container.querySelector("button")
    expect(button).not.toBeNull()

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    await waitFor(() => {
      expect(localStorage.getItem("assembly-dashboard-theme")).toBe("dark")
      expect(document.documentElement.classList.contains("dark")).toBe(true)
    })

    screen.unmount()
  })
})
