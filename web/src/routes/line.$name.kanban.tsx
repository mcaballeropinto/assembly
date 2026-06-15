import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { getLineKanban, releaseHeldTasks } from "@/lib/api";
import { KanbanBoard, KanbanBoardSkeleton } from "@/components/kanban/kanban-board";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Route as lineRoute } from "./line.$name";

export const Route = createRoute({
  getParentRoute: () => lineRoute,
  path: "kanban",
  validateSearch: (search: Record<string, unknown>) => ({
    wp: typeof search.wp === "string" ? search.wp : undefined,
  }),
  component: LineKanbanRoute,
});

function LineKanbanRoute() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/line/$name/kanban" });
  const queryClient = useQueryClient();
  const queryKey = ["line", name, "kanban"] as const;

  const kanban = useQuery({
    queryKey,
    queryFn: () => getLineKanban(name),
    refetchInterval: 3000,
  });

  const releaseAll = useMutation({
    mutationFn: () => releaseHeldTasks(name, { all: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <div className="max-w-screen-2xl mx-auto px-6 lg:px-8 pt-6 pb-12">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Kanban</p>
        </div>
        <Tabs
          value="kanban"
          onValueChange={(value) => {
            if (value === "list") {
              navigate({ to: "/line/$name", params: { name } });
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="kanban">Kanban</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {releaseAll.isError && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {releaseAll.error instanceof Error
            ? releaseAll.error.message
            : "Failed to release held tasks."}
        </div>
      )}

      {kanban.isLoading && <KanbanBoardSkeleton />}

      {kanban.isError && (
        <div className="rounded-lg border p-6 text-sm text-destructive">
          Failed to load kanban:{" "}
          {kanban.error instanceof Error ? kanban.error.message : "Unknown error"}
        </div>
      )}

      {kanban.data && (
        <KanbanBoard
          state={kanban.data}
          onOpenCard={(fileName) => {
            navigate({
              search: { ...search, wp: fileName },
              replace: true,
            });
          }}
          onReleaseAllHeld={() => releaseAll.mutate()}
          isReleasingHeld={releaseAll.isPending}
        />
      )}
    </div>
  );
}
