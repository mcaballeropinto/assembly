import { useState } from "react";
import { Info, MoreHorizontal } from "lucide-react";
import type { KanbanColumn, StationFreshness, StationStatus, StationTooltipMeta } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useReleaseAllHeld } from "./use-kanban-query";
import { cn } from "@/lib/utils";

interface KanbanColumnHeaderProps {
  column: KanbanColumn;
  lineName: string;
}

interface KanbanStationGroupHeaderProps {
  stationName: string;
  totalCount: number;
  freshness?: StationFreshness;
  stationStatus?: StationStatus;
  stationMeta?: StationTooltipMeta;
  retryingCount: number;
  exhaustedCount: number;
}

// Station status dot color classes
const statusDotColors: Record<string, string> = {
  running: "text-emerald-600 dark:text-emerald-500",
  idle: "text-muted-foreground",
  blocked: "text-amber-600 dark:text-amber-500",
  errored: "text-destructive",
};

// Station freshness color classes
const freshnessColors: Record<string, string> = {
  fresh: "text-emerald-600 dark:text-emerald-500",
  stale: "text-amber-600 dark:text-amber-500",
  disconnected: "text-destructive",
  completed: "text-muted-foreground",
};

export function KanbanColumnHeader({ column, lineName }: KanbanColumnHeaderProps) {
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const releaseAllMutation = useReleaseAllHeld(lineName);

  const handleReleaseAll = () => {
    releaseAllMutation.mutate(undefined, {
      onSuccess: () => {
        setShowReleaseDialog(false);
      },
    });
  };

  // WIP limit warning
  const wipWarning = column.wipLimit && column.count > column.wipLimit;
  const wipError = column.wipLimit && column.count > column.wipLimit * 2;

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b">
      {/* Title */}
      <span className="text-sm font-semibold">{column.title}</span>

      {/* Count badge */}
      <Badge
        variant="secondary"
        className={cn(
          "text-xs",
          wipError && "bg-destructive text-destructive-foreground",
          wipWarning && !wipError && "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-500"
        )}
      >
        {column.count}
        {column.wipLimit && ` / ${column.wipLimit}`}
      </Badge>

      {/* Retry indicators */}
      {column.retrying_count !== undefined && column.retrying_count > 0 && (
        <span className="text-xs text-amber-600 dark:text-amber-500">
          ↻ {column.retrying_count}
        </span>
      )}
      {column.exhausted_count !== undefined && column.exhausted_count > 0 && (
        <span className="text-xs text-destructive">✗ {column.exhausted_count}</span>
      )}

      {/* Tooltip */}
      {column.tooltip && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs max-w-xs">{column.tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Actions menu (held column only) */}
      {column.key === "held" && column.count > 0 && (
        <>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setShowReleaseDialog(true)}>
                  Release all ({column.count})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <AlertDialog open={showReleaseDialog} onOpenChange={setShowReleaseDialog}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Release all held tasks?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will release {column.count} held task{column.count !== 1 ? "s" : ""} to
                  the inbox for processing.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleReleaseAll}
                  disabled={releaseAllMutation.isPending}
                >
                  {releaseAllMutation.isPending ? "Releasing..." : "Release all"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

export function KanbanStationGroupHeader({
  stationName,
  totalCount,
  freshness,
  stationStatus,
  stationMeta,
  retryingCount,
  exhaustedCount,
}: KanbanStationGroupHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b">
      {/* Station status dot */}
      {stationStatus && (
        <span
          className={cn(
            "text-base",
            statusDotColors[stationStatus.state] || "text-muted-foreground"
          )}
          aria-label={stationStatus.label}
        >
          {stationStatus.icon}
        </span>
      )}

      {/* Station name */}
      <span className="text-sm font-semibold">{stationName}</span>

      {/* Freshness indicator */}
      {freshness && freshness.state !== "completed" && (
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            freshnessColors[freshness.state] || "text-muted-foreground"
          )}
          style={{
            backgroundColor: "currentColor",
          }}
          aria-label={freshness.label}
        />
      )}

      {/* Count */}
      <Badge variant="secondary" className="text-xs">
        {totalCount}
      </Badge>

      {/* Retry indicators */}
      {retryingCount > 0 && (
        <span className="text-xs text-amber-600 dark:text-amber-500">↻ {retryingCount}</span>
      )}
      {exhaustedCount > 0 && (
        <span className="text-xs text-destructive">✗ {exhaustedCount}</span>
      )}

      {/* Station meta tooltip */}
      {stationMeta?.description && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <div className="space-y-1">
                <p className="text-xs font-medium">{stationMeta.description}</p>
                {stationMeta.provider && (
                  <p className="text-xs text-muted-foreground">
                    Provider: {stationMeta.provider}
                  </p>
                )}
                {stationMeta.model && (
                  <p className="text-xs text-muted-foreground">Model: {stationMeta.model}</p>
                )}
                {stationMeta.timeout && (
                  <p className="text-xs text-muted-foreground">
                    Timeout: {stationMeta.timeout}s
                  </p>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
