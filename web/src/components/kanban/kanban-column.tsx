import { useState } from "react";
import { Info, MoreHorizontal } from "lucide-react";
import type { KanbanColumn as ApiKanbanColumn } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  KanbanBoardColumn,
  KanbanBoardColumnList,
} from "@/components/ui/kanban-board/kanban";
import { cn } from "@/lib/utils";
import { KanbanCard } from "./kanban-card";

interface KanbanColumnProps {
  column: ApiKanbanColumn;
  onOpenCard: (fileName: string) => void;
  onReleaseAll?: () => void;
  isReleasing?: boolean;
  now?: number;
}

function statusIcon(column: ApiKanbanColumn): string | null {
  if (column.key === "error") return "\u2715";
  if (column.key === "review") return "!";
  return null;
}

export function KanbanColumn({
  column,
  onOpenCard,
  onReleaseAll,
  isReleasing = false,
  now,
}: KanbanColumnProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const showReleaseAll = column.key === "held" && column.count > 0 && onReleaseAll;
  const wipWarning = column.wipLimit != null && column.count > column.wipLimit;
  const wipError = column.wipLimit != null && column.count > column.wipLimit * 2;
  const icon = statusIcon(column);

  return (
    <KanbanBoardColumn className="w-72 flex-shrink-0 rounded-lg border bg-card py-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        {icon && (
          <span
            className={cn(
              "text-sm font-semibold",
              column.key === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-500"
            )}
            aria-label={column.key}
          >
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{column.title}</span>
        <Badge
          variant="secondary"
          className={cn(
            "shrink-0 text-xs",
            wipError && "bg-destructive text-destructive-foreground",
            wipWarning &&
              !wipError &&
              "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-500"
          )}
        >
          {column.count}
        </Badge>
        {column.retrying_count ? (
          <Badge variant="outline" className="shrink-0 text-[11px] text-amber-700 dark:text-amber-400">
            {"\u21ba"} {column.retrying_count}
          </Badge>
        ) : null}
        {column.exhausted_count ? (
          <Badge variant="outline" className="shrink-0 text-[11px] text-destructive">
            {"\u2717"} {column.exhausted_count}
          </Badge>
        ) : null}
        {column.tooltip && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${column.title} info`}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>{column.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {showReleaseAll && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-7 w-7 shrink-0"
                  aria-label="Held column actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    setConfirmOpen(true);
                  }}
                >
                  Release all
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Release all held tasks?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will release {column.count} held task{column.count === 1 ? "" : "s"}.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isReleasing}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={isReleasing}
                    onClick={(event) => {
                      event.preventDefault();
                      onReleaseAll?.();
                      if (!isReleasing) setConfirmOpen(false);
                    }}
                  >
                    {isReleasing ? "Releasing..." : "Release all"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>

      <KanbanBoardColumnList className="min-h-0 flex-1 overflow-y-auto p-2">
        {column.cards.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            {column.key === "held" ? "No held tasks" : "No items"}
          </div>
        ) : (
          column.cards.map((card) => (
            <KanbanCard key={card.fileName} card={card} onOpen={onOpenCard} now={now} />
          ))
        )}
      </KanbanBoardColumnList>
    </KanbanBoardColumn>
  );
}
