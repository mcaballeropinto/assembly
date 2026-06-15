import { Outlet, createRoute, useNavigate } from "@tanstack/react-router"

import { Route as rootRoute } from "./__root"

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/line/$name",
  component: LineRoute,
})

function LineRoute() {
  const { name } = Route.useParams()
  const navigate = useNavigate({ from: "/line/$name" })

  if (window.location.pathname.endsWith("/kanban")) {
    return <Outlet />
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-6 pb-12 pt-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">List</p>
        </div>
        <div
          role="tablist"
          aria-label="Line view"
          className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground"
        >
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md bg-background px-3 py-1 text-sm font-medium text-foreground shadow-sm"
          >
            List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all hover:text-foreground"
            onClick={() => {
              void navigate({
                to: "/line/$name/kanban",
                params: { name },
                search: { wp: undefined },
              })
            }}
          >
            Kanban
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <h3 className="text-base font-semibold">List panel pending</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          The shadcn list view will be ported in a later phase. Use the Kanban tab for the
          Phase 7 filesystem-backed board.
        </p>
      </div>
    </div>
  )
}
