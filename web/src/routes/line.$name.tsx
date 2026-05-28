import { Outlet, createRoute, useNavigate, useParams } from "@tanstack/react-router"

import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs"
import { Route as rootRoute } from "./__root"

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/line/$name",
  component: LineDetailRoute,
})

function LineDetailRoute() {
  const { name } = useParams({ from: "/line/$name" })
  const navigate = useNavigate()
  const activeTab = window.location.pathname.endsWith("/kanban") ? "kanban" : "list"

  const handleTabChange = (value: string) => {
    if (value === "kanban") {
      void navigate({ to: `/line/${name}/kanban` })
      return
    }

    void navigate({ to: `/line/${name}` })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Line detail</p>
        </div>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="kanban">Kanban</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {activeTab === "kanban" ? (
        <Outlet />
      ) : (
        <div className="rounded-lg border p-6 text-sm text-muted-foreground">
          List view is not implemented yet.
        </div>
      )}
    </div>
  )
}
