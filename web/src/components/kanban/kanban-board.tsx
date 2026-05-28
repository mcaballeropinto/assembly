import type { KanbanState, KanbanColumn } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { KanbanColumnHeader, KanbanStationGroupHeader } from "./kanban-column-header";
import { KanbanCardComponent } from "./kanban-card";

interface KanbanBoardProps {
  kanbanState: KanbanState;
  lineName: string;
}

interface StationGroup {
  stationName: string;
  lanes: KanbanColumn[];
}

// Group columns by station
function groupColumnsByStation(columns: KanbanColumn[]): {
  standalone: KanbanColumn[];
  stationGroups: StationGroup[];
} {
  const standalone: KanbanColumn[] = [];
  const stationMap = new Map<string, KanbanColumn[]>();

  for (const col of columns) {
    if (col.station) {
      const existing = stationMap.get(col.station) || [];
      existing.push(col);
      stationMap.set(col.station, existing);
    } else {
      standalone.push(col);
    }
  }

  const stationGroups: StationGroup[] = [];
  for (const [stationName, lanes] of stationMap.entries()) {
    stationGroups.push({ stationName, lanes });
  }

  return { standalone, stationGroups };
}

export function KanbanBoard({ kanbanState, lineName }: KanbanBoardProps) {
  const { standalone, stationGroups } = groupColumnsByStation(kanbanState.columns);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 min-h-[400px]">
      {/* Standalone columns (held, inbox, done, error, review) */}
      {standalone.map((col) => (
        <div key={col.key} className="flex-shrink-0 w-[280px] rounded-lg border bg-card">
          <KanbanColumnHeader column={col} lineName={lineName} />
          <ScrollArea className="max-h-[600px]">
            <div className="p-2 space-y-2">
              {col.cards.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  {col.key === "held" ? "No held tasks" : "No items"}
                </div>
              ) : (
                col.cards.map((card) => (
                  <KanbanCardComponent key={card.fileName} card={card} lineName={lineName} />
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      ))}

      {/* Station groups */}
      {stationGroups.map((group) => {
        const totalCount = group.lanes.reduce((sum, lane) => sum + lane.count, 0);
        const retryingCount = group.lanes.reduce(
          (sum, lane) => sum + (lane.retrying_count || 0),
          0
        );
        const exhaustedCount = group.lanes.reduce(
          (sum, lane) => sum + (lane.exhausted_count || 0),
          0
        );

        const freshness = kanbanState.stationFreshness?.[group.stationName];
        const stationStatus = kanbanState.stationStatuses?.[group.stationName];
        const stationMeta = kanbanState.stationMeta?.[group.stationName];

        return (
          <div key={group.stationName} className="flex-shrink-0 w-[320px] rounded-lg border bg-card">
            <KanbanStationGroupHeader
              stationName={group.stationName}
              totalCount={totalCount}
              freshness={freshness}
              stationStatus={stationStatus}
              stationMeta={stationMeta}
              retryingCount={retryingCount}
              exhaustedCount={exhaustedCount}
            />

            {/* Three lane sub-sections */}
            {group.lanes.map((lane, idx) => (
              <div key={lane.key} className={idx < group.lanes.length - 1 ? "border-b" : ""}>
                {/* Lane label */}
                <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
                  <span>{lane.title}</span>
                  <span>{lane.count}</span>
                </div>

                {/* Lane cards */}
                <ScrollArea className="max-h-[200px]">
                  <div className="px-2 pb-2 space-y-2">
                    {lane.cards.length === 0 ? (
                      <div className="text-center text-xs text-muted-foreground py-2">
                        Empty
                      </div>
                    ) : (
                      lane.cards.map((card) => (
                        <KanbanCardComponent
                          key={card.fileName}
                          card={card}
                          lineName={lineName}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function KanbanBoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4 min-h-[400px]">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex-shrink-0 w-[280px] rounded-lg border bg-card">
          <div className="p-3 border-b">
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="p-2 space-y-2">
            {[...Array(3)].map((_, j) => (
              <Skeleton key={j} className="h-24 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
