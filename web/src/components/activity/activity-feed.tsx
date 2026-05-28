import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ActivityEntry } from '@/lib/api';
import { getEventIcon } from './event-icons';

interface ActivityFeedProps {
  entries: ActivityEntry[];
  onWorkpieceClick?: (line: string, fileName: string) => void;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

function getDetail(entry: ActivityEntry): string {
  if (entry.summary) return entry.summary;
  if (entry.task) return entry.task;
  if (entry.error) return entry.error;
  if (entry.event === 'trigger_fired' && entry.source && entry.target) {
    return `${entry.source} → ${entry.target}`;
  }
  if (entry.event === 'trigger_skipped' && entry.target && entry.reason) {
    return `${entry.target}: ${entry.reason}`;
  }
  return '';
}

function getSilentIndicatorColor(silent_s: number): string {
  if (silent_s < 90) return 'bg-emerald-500';
  if (silent_s < 300) return 'bg-amber-500';
  return 'bg-red-500';
}

interface ActivityRowProps {
  entry: ActivityEntry;
  onWorkpieceClick?: (line: string, fileName: string) => void;
}

function ActivityRow({ entry, onWorkpieceClick }: ActivityRowProps) {
  const { icon: Icon, className: iconCls } = getEventIcon(entry.event);
  const detail = getDetail(entry);
  const truncatedDetail = detail.length > 100 ? detail.slice(0, 100) + '…' : detail;

  const handleWorkpieceClick = () => {
    if (entry.workpiece && entry._line && onWorkpieceClick) {
      onWorkpieceClick(entry._line, entry.workpiece + '.json');
    }
  };

  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-0">
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', iconCls)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-muted-foreground">{formatTime(entry.ts)}</span>
          {entry._line && (
            <Badge variant="outline" className="text-xs">
              {entry._line}
            </Badge>
          )}
          <span className="text-sm font-medium">
            {entry.event}
            {entry.station && ` [${entry.station}]`}
          </span>
        </div>
        {truncatedDetail && (
          <p
            className={cn(
              'text-sm text-muted-foreground truncate',
              entry.workpiece && entry._line && onWorkpieceClick && 'cursor-pointer hover:text-foreground'
            )}
            onClick={entry.workpiece && entry._line && onWorkpieceClick ? handleWorkpieceClick : undefined}
          >
            {truncatedDetail}
          </p>
        )}
        {entry.event === 'station_heartbeat' && entry.child_live !== undefined && (
          <div className="flex items-center gap-1.5 mt-1">
            <div
              className={cn(
                'h-2 w-2 rounded-full',
                getSilentIndicatorColor(entry.silent_s || 0)
              )}
            />
            <span className="text-xs text-muted-foreground">
              {entry.silent_s !== undefined ? `${entry.silent_s}s` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ActivityFeed({ entries, onWorkpieceClick }: ActivityFeedProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Use virtualizer when row count > 100
  const shouldVirtualize = entries.length > 100;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    enabled: shouldVirtualize,
  });

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="p-6 pb-3">
          <CardTitle className="text-base font-semibold">Activity</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="p-6 pb-3">
        <CardTitle className="text-base font-semibold">Activity</CardTitle>
      </CardHeader>
      <CardContent className="p-6 pt-0">
        <ScrollArea className="h-[480px]">
          <div ref={parentRef} className="h-full w-full">
            {shouldVirtualize ? (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => (
                  <div
                    key={virtualRow.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <ActivityRow entry={entries[virtualRow.index]} onWorkpieceClick={onWorkpieceClick} />
                  </div>
                ))}
              </div>
            ) : (
              entries.map((entry, index) => (
                <ActivityRow key={`${entry.ts}-${index}`} entry={entry} onWorkpieceClick={onWorkpieceClick} />
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
