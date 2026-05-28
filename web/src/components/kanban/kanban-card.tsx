import { useNavigate } from "@tanstack/react-router";
import type { KanbanCard, KanbanCardState } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  card: KanbanCard;
  lineName: string;
}

// State icon mapping (matching global-dashboard.ts:2714)
const stateIcons: Record<KanbanCardState, string> = {
  held: "\u23f8",        // ⏸
  waiting: "\u2026",     // …
  running: "\u21bb",     // ↻
  evaluating: "\u25d0",  // ◐
  retrying: "\u21ba",    // ↺
  routed: "\u2192",      // →
  done: "\u2713",        // ✓
  failed: "\u2717",      // ✗
  escalated: "\u26a0",   // ⚠
};

// State color classes (matching CSS at global-dashboard.ts:1318-1327)
const stateColorClasses: Record<KanbanCardState, string> = {
  running: "text-emerald-600 dark:text-emerald-500 animate-pulse",
  evaluating: "text-blue-600 dark:text-blue-500",
  retrying: "text-amber-600 dark:text-amber-500",
  waiting: "text-muted-foreground",
  held: "text-blue-500",
  routed: "text-emerald-500",
  done: "text-emerald-600 dark:text-emerald-500",
  failed: "text-destructive",
  escalated: "text-amber-600 dark:text-amber-500",
};

// Build duration label matching global-dashboard.ts:2758
function buildDurationLabel(card: KanbanCard): string {
  // Done/failed cards show finished duration
  if (card.finished_at && card.duration_ms !== null && card.duration_ms !== undefined) {
    const sec = Math.floor(card.duration_ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  }

  // In-flight cards show elapsed time
  if (card.totalElapsedMs !== null && card.totalElapsedMs !== undefined) {
    const sec = Math.floor(card.totalElapsedMs / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  }

  // Held/waiting cards show time since entered column
  if (card.enteredColumnAt) {
    const enteredMs = new Date(card.enteredColumnAt).getTime();
    const ageMs = Date.now() - enteredMs;
    const min = Math.floor(ageMs / 60000);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  }

  return "";
}

// Check if card is stuck (in inbox/held > 15min)
function isStuck(card: KanbanCard): boolean {
  if (!card.enteredColumnAt) return false;
  if (card.column !== "inbox" && card.column !== "held") return false;
  const enteredMs = new Date(card.enteredColumnAt).getTime();
  const ageMs = Date.now() - enteredMs;
  return ageMs > 15 * 60 * 1000;
}

export function KanbanCardComponent({ card, lineName }: KanbanCardProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate({
      to: `/line/${lineName}/kanban`,
      search: { wp: card.fileName },
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleClick();
    }
  };

  const durationLabel = buildDurationLabel(card);
  const stateIcon = stateIcons[card.state] || "\u2026";
  const stateColor = stateColorClasses[card.state] || "text-muted-foreground";
  const stuck = isStuck(card);
  const isFailed = card.state === "failed";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 cursor-pointer hover:border-primary/50 transition-colors",
        isFailed && "border-l-[3px] border-l-destructive",
        stuck && !isFailed && "border-l-[3px] border-l-amber-500"
      )}
      tabIndex={0}
      role="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Head row: ID chip + state icon */}
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {card.id}
        </Badge>
        <span className={cn("text-base", stateColor)} aria-label={card.state}>
          {stateIcon}
        </span>
      </div>

      {/* Title */}
      <div className="text-sm font-medium leading-5 line-clamp-2 mt-1">
        {card.title}
      </div>

      {/* Preview */}
      {card.preview && (
        <div className="text-xs text-muted-foreground line-clamp-2 mt-1">
          {card.preview}
        </div>
      )}

      {/* Meta row: duration + retry chip + cost */}
      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
        {durationLabel && <span>{durationLabel}</span>}
        {card.retries && card.retries > 0 && (
          <Badge variant="outline" className="text-amber-600 dark:text-amber-500">
            ↺ {card.retries}
          </Badge>
        )}
        {card.costUsd !== undefined && card.costUsd !== null && card.costUsd > 0 && (
          <span>
            {card.costUsd < 0.01
              ? `$${(card.costUsd * 100).toFixed(1)}¢`
              : card.costUsd < 0.1
              ? `$${card.costUsd.toFixed(3)}`
              : `$${card.costUsd.toFixed(2)}`}
          </span>
        )}
      </div>
    </div>
  );
}
