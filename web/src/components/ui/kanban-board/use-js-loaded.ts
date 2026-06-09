// Vendored from janhesters/shadcn-kanban-board ea1261c; do not edit without noting upstream.
import { useEffect, useState } from "react"

export function useJsLoaded() {
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (
      document.readyState === "complete" ||
      document.readyState === "interactive"
    ) {
      setLoaded(true)
      return
    }

    const onReady = () => setLoaded(true)
    document.addEventListener("DOMContentLoaded", onReady)
    window.addEventListener("load", onReady)

    return () => {
      document.removeEventListener("DOMContentLoaded", onReady)
      window.removeEventListener("load", onReady)
    }
  }, [])

  return loaded
}
