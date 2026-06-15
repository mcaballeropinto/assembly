import { type ReactNode, useState } from "react";
import { Info, MoreHorizontal } from "lucide-react";
import type { KanbanColumn as ApiKanbanColumn } from "../../lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  KanbanBoardColumn,
  KanbanBoardColumnList,
} from "../ui/kanban-board/kanban";
import { cn } from "../../lib/utils";
import { KanbanCard } from "./kanban-card";

interface KanbanColumnProps {
  column: ApiKanbanColumn;
  onOpenCard: (fileName: string) => void;
  onReleaseAll?: () => void;
  onReleaseHeld?: (fileName: string) => void;
  onRetryWorkpiece?: (fileName: string) => void;
  onDismissError?: (fileName: string) => void;
  isReleasing?: boolean;
  isRetrying?: boolean;
  isDismissing?: boolean;
  now?: number;
}

function statusIcon(column: ApiKanbanColumn): string | null {
  if (column.key === "error") return "\u2715";
  if (column.key === "review") return "!";
  return null;
}

function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        className
      )}
    >
      {children}
    </span>
  );
}

export function KanbanColumn({
  column,
  onOpenCard,
  onReleaseAll,
  onReleaseHeld,
  onRetryWorkpiece,
  onDismissError,
  isReleasing = false,
  isRetrying = false,
  isDismissing = false,
  now,
}: KanbanColumnProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
        <Chip
          className={cn(
            "border-transparent bg-secondary text-secondary-foreground text-xs",
            wipError && "bg-destructive text-destructive-foreground",
            wipWarning &&
              !wipError &&
              "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-500"
          )}
        >
          {column.count}
        </Chip>
        {column.retrying_count ? (
          <Chip className="text-[11px] text-amber-700 dark:text-amber-400">
            {"\u21ba"} {column.retrying_count}
          </Chip>
        ) : null}
        {column.exhausted_count ? (
          <Chip className="text-[11px] text-destructive">
            {"\u2717"} {column.exhausted_count}
          </Chip>
        ) : null}
        {column.tooltip && (
          <button
            type="button"
            aria-label={`${column.title} info`}
            title={column.tooltip}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <Info className="h-4 w-4" />
          </button>
        )}
        {showReleaseAll && (
          <>
            <div className="relative ml-auto">
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
                aria-label="Held column actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              <div
                role="menu"
                className={cn(
                  "absolute right-0 z-50 mt-1 min-w-32 rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
                  !menuOpen && "sr-only"
                )}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmOpen(true);
                  }}
                >
                  Release all
                </button>
              </div>
            </div>

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
            <KanbanCard
              key={card.fileName}
              card={card}
              onOpen={onOpenCard}
              onReleaseHeld={onReleaseHeld}
              onRetryWorkpiece={onRetryWorkpiece}
              onDismissError={onDismissError}
              isReleasing={isReleasing}
              isRetrying={isRetrying}
              isDismissing={isDismissing}
              now={now}
            />
          ))
        )}
      </KanbanBoardColumnList>
    </KanbanBoardColumn>
  );
}
