import { createRoute, useParams } from "@tanstack/react-router";
import { Route as lineRoute } from "./line.$name";
import { useKanbanQuery } from "../components/kanban/use-kanban-query";
import { KanbanBoard, KanbanBoardSkeleton } from "../components/kanban/kanban-board";

export const Route = createRoute({
  getParentRoute: () => lineRoute,
  path: "kanban",
  component: LineKanbanPage,
});

function LineKanbanPage() {
  const { name } = useParams({ from: "/line/$name/kanban" });
  const { data, isLoading, isError, error } = useKanbanQuery(name);

  if (isLoading) {
    return <KanbanBoardSkeleton />;
  }

  if (isError) {
    return (
      <div className="p-6 border rounded-lg">
        <p className="text-destructive">
          Failed to load kanban: {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return <KanbanBoard kanbanState={data} lineName={name} />;
}
