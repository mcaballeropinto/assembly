import { Info } from "lucide-react";
import type { KanbanColumn as ApiKanbanColumn, KanbanState } from "../../lib/api";
import {
  KanbanBoard as KanbanBoardPrimitive,
  KanbanBoardProvider,
} from "../ui/kanban-board/kanban";
import { cn } from "../../lib/utils";
import { KanbanColumn } from "./kanban-column";

interface KanbanBoardProps {
  state: KanbanState;
  onOpenCard: (fileName: string) => void;
  onReleaseAllHeld: () => void;
  isReleasingHeld?: boolean;
  now?: number;
}

type OrderedGroup =
  | { type: "column"; column: ApiKanbanColumn }
  | { type: "station"; station: string };

function groupColumns(columns: ApiKanbanColumn[]) {
  const ordered: OrderedGroup[] = [];
  const stationLanes = new Map<string, ApiKanbanColumn[]>();

  for (const column of columns) {
    if (!column.station) {
      ordered.push({ type: "column", column });
      continue;
    }

    if (!stationLanes.has(column.station)) {
      stationLanes.set(column.station, []);
      ordered.push({ type: "station", station: column.station });
    }
    stationLanes.get(column.station)?.push(column);
  }

  return { ordered, stationLanes };
}

function retryChip(count: number, exhausted = false) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
        exhausted ? "text-destructive" : "text-amber-700 dark:text-amber-400"
      )}
    >
      {exhausted ? "\u2717" : "\u21ba"} {count}
    </span>
  );
}

export function KanbanBoard({
  state,
  onOpenCard,
  onReleaseAllHeld,
  isReleasingHeld = false,
  now,
}: KanbanBoardProps) {
  const { ordered, stationLanes } = groupColumns(state.columns);

  return (
    <KanbanBoardProvider>
      <KanbanBoardPrimitive className="min-h-[28rem]">
        {ordered.map((group) => {
          if (group.type === "column") {
            return (
              <KanbanColumn
                key={group.column.key}
                column={group.column}
                onOpenCard={onOpenCard}
                onReleaseAll={group.column.key === "held" ? onReleaseAllHeld : undefined}
                isReleasing={isReleasingHeld}
                now={now}
              />
            );
          }

          const lanes = stationLanes.get(group.station) ?? [];
          const count = lanes.reduce((sum, lane) => sum + lane.count, 0);
          const retrying = lanes.reduce((sum, lane) => sum + (lane.retrying_count ?? 0), 0);
          const exhausted = lanes.reduce((sum, lane) => sum + (lane.exhausted_count ?? 0), 0);
          const status = state.stationStatuses?.[group.station];
          const meta = state.stationMeta?.[group.station];

          return (
            <section
              key={group.station}
              className="flex w-[56rem] flex-shrink-0 flex-col rounded-lg border bg-card"
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b">
                {status && (
                  <span className="text-sm" aria-label={status.label}>
                    {status.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {group.station}
                </span>
                <span className="inline-flex shrink-0 items-center rounded-full border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                  {count}
                </span>
                {retryChip(retrying)}
                {retryChip(exhausted, true)}
                {meta?.description && (
                  <button
                    type="button"
                    aria-label={`${group.station} info`}
                    title={[
                      meta.description,
                      meta.provider ? `Provider: ${meta.provider}` : "",
                      meta.model ? `Model: ${meta.model}` : "",
                      meta.timeout ? `Timeout: ${meta.timeout}s` : "",
                    ].filter(Boolean).join("\n")}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 p-3">
                {lanes.map((lane) => (
                  <KanbanColumn
                    key={lane.key}
                    column={lane}
                    onOpenCard={onOpenCard}
                    now={now}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </KanbanBoardPrimitive>
    </KanbanBoardProvider>
  );
}

export function KanbanBoardSkeleton() {
  return (
    <div className="flex min-h-[28rem] gap-4 overflow-x-auto pb-4">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="w-72 flex-shrink-0 rounded-lg border bg-card">
          <div className="p-3 border-b">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2 p-2">
            <div className="h-24 w-full animate-pulse rounded bg-muted" />
            <div className="h-20 w-full animate-pulse rounded bg-muted" />
            <div className="h-28 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
