import type { ReactNode } from "react";
import type { KanbanCard as ApiKanbanCard, KanbanCardState } from "../../lib/api";
import { KanbanBoardCard } from "../ui/kanban-board/kanban";
import { cn } from "../../lib/utils";

interface KanbanCardProps {
  card: ApiKanbanCard;
  onOpen: (fileName: string) => void;
  now?: number;
}

const stateIcons: Record<KanbanCardState, string> = {
  held: "\u23f8",
  waiting: "\u2026",
  running: "\u21bb",
  evaluating: "\u25d0",
  retrying: "\u21ba",
  routed: "\u2192",
  done: "\u2713",
  failed: "\u2717",
  escalated: "\u26a0",
};

const stateClasses: Record<KanbanCardState, string> = {
  held: "text-blue-500",
  waiting: "text-muted-foreground",
  running: "text-emerald-600 dark:text-emerald-500",
  evaluating: "text-blue-600 dark:text-blue-500",
  retrying: "text-amber-600 dark:text-amber-500",
  routed: "text-emerald-500",
  done: "text-emerald-600 dark:text-emerald-500",
  failed: "text-destructive",
  escalated: "text-amber-600 dark:text-amber-500",
};

function formatElapsedShort(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const ms = Math.max(0, now - new Date(iso).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m${remainSeconds > 0 ? ` ${remainSeconds}s` : ""}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h${remainMinutes > 0 ? ` ${remainMinutes}m` : ""}`;
}

export function buildCardDurationLabel(card: ApiKanbanCard, now = Date.now()): string {
  if (card.column === "done" && card.duration_ms != null) {
    return formatDuration(card.duration_ms);
  }
  if (card.lane === "processing" && card.stationStartedAt) {
    return `${formatElapsedShort(card.stationStartedAt, now)} in ${card.station ?? "?"}`;
  }
  if (card.lane === "inbox" && card.station && card.enteredColumnAt) {
    return `${formatElapsedShort(card.enteredColumnAt, now)} waiting`;
  }
  if (card.lane === "output" && card.enteredColumnAt) {
    return `${formatElapsedShort(card.enteredColumnAt, now)} routed`;
  }
  if ((card.column === "inbox" || card.column === "held") && card.enteredColumnAt) {
    return `${formatElapsedShort(card.enteredColumnAt, now)} queued`;
  }
  if (card.enteredColumnAt) {
    return `${formatElapsedShort(card.enteredColumnAt, now)} queued`;
  }
  return "\u2014";
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
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        className
      )}
    >
      {children}
    </span>
  );
}

function retryCount(card: ApiKanbanCard): number {
  return card.retry?.retry_count ?? card.retries ?? 0;
}

function retryLabel(card: ApiKanbanCard): string | null {
  const count = retryCount(card);
  if (count <= 0) return null;
  if (card.retry?.max_retries) return `${count}/${card.retry.max_retries}`;
  return String(count);
}

export function KanbanCard({ card, onOpen, now }: KanbanCardProps) {
  const retry = retryLabel(card);
  const duration = buildCardDurationLabel(card, now);
  const isFailed = card.state === "failed" || card.outcome === "failed" || card.retry?.exhausted;
  const inBackoff = Boolean(card.retry?.in_backoff && !card.retry?.exhausted);

  return (
    <KanbanBoardCard
      data={{ id: card.fileName }}
      isDragDisabled={true}
      role="button"
      tabIndex={0}
      title={`${card.id}\u2014${card.title}`}
      className={cn(
        "space-y-2 text-left hover:border-primary/50",
        isFailed && "border-destructive",
        inBackoff && "border-amber-500 border-dashed"
      )}
      onClick={() => onOpen(card.fileName)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(card.fileName);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-5 line-clamp-2">
          {card.title || card.id}
        </h3>
        <span className={cn("shrink-0 text-base", stateClasses[card.state])} aria-label={card.state}>
          {stateIcons[card.state] ?? "\u2026"}
        </span>
      </div>

      {card.preview && (
        <p className="text-xs leading-5 text-muted-foreground line-clamp-2">{card.preview}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Chip className="max-w-full truncate font-mono text-[11px]">
          {card.id}
        </Chip>
        {retry && (
          <Chip
            className={cn(
              "text-[11px] text-amber-700 dark:text-amber-400",
              card.retry?.exhausted && "border-destructive text-destructive"
            )}
          >
            {"\u21ba"} {retry}
          </Chip>
        )}
        <span>{duration}</span>
      </div>
    </KanbanBoardCard>
  );
}
