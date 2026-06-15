import { Outlet, createRoute, useNavigate } from "@tanstack/react-router"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
        <Tabs
          value="list"
          onValueChange={value => {
            if (value === "kanban") {
              void navigate({
                to: "/line/$name/kanban",
                params: { name },
                search: { wp: undefined },
              })
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="kanban">Kanban</TabsTrigger>
          </TabsList>
        </Tabs>
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
