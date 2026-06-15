import { Outlet, useSearch } from "@tanstack/react-router"

import { WorkpieceDrawer } from "./components/drawer/workpiece-drawer"
import { Shell } from "./components/shell/shell"

export function App() {
  const search = useSearch({ strict: false }) as {
    wp?: unknown
    wpline?: unknown
    line?: unknown
  }
  const lineName =
    typeof search.wpline === "string" && search.wpline.length > 0
      ? search.wpline
      : typeof search.line === "string" && search.line.length > 0
        ? search.line
        : undefined

  return (
    <>
      <Shell>
        <Outlet />
        {search.wp && !lineName ? (
          <span className="sr-only">missing line</span>
        ) : null}
      </Shell>
      <WorkpieceDrawer lineName={lineName} />
    </>
  )
}

export default App
