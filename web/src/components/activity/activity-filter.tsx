import { useState } from 'react';
import { Check, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { ActivityEntry } from '@/lib/api';

export interface FilterType {
  key: string;
  label: string;
  matchFn: (event: string) => boolean;
}

export const FILTER_TYPES: FilterType[] = [
  { key: 'station_done', label: 'Done', matchFn: (e) => e === 'station_done' },
  { key: 'retry', label: 'Retry', matchFn: (e) => e === 'retry' },
  { key: 'error', label: 'Error', matchFn: (e) => e.includes('error') || e === 'error_bucket' },
  { key: 'routed', label: 'Routed', matchFn: (e) => e === 'routed' || e === 'queued' },
  { key: 'escalated', label: 'Escalated', matchFn: (e) => e === 'escalated' },
  { key: 'task_received', label: 'Received', matchFn: (e) => e === 'task_received' },
  { key: 'task_done', label: 'Task Done', matchFn: (e) => e === 'task_done' },
  { key: 'trigger', label: 'Trigger', matchFn: (e) => e === 'trigger_fired' || e === 'trigger_skipped' },
];

export function filterActivity(entries: ActivityEntry[], activeKeys: Set<string>): ActivityEntry[] {
  // If all filters are active, return all entries
  if (activeKeys.size === FILTER_TYPES.length) {
    return entries;
  }

  // Get active filter functions
  const activeFilters = FILTER_TYPES.filter((ft) => activeKeys.has(ft.key));

  // Return entries that match at least one active filter
  return entries.filter((entry) => activeFilters.some((ft) => ft.matchFn(entry.event)));
}

export function readFiltersFromURL(): Set<string> {
  const params = new URLSearchParams(window.location.search);
  const eventsParam = params.get('events');

  if (!eventsParam) {
    // No param means all filters are active (default state)
    return new Set(FILTER_TYPES.map((ft) => ft.key));
  }

  return new Set(eventsParam.split(',').filter(Boolean));
}

export function writeFiltersToURL(keys: Set<string>): void {
  const url = new URL(window.location.href);
  const params = url.searchParams;

  if (keys.size === FILTER_TYPES.length) {
    // All selected = clean URL (remove param)
    params.delete('events');
  } else {
    params.set('events', Array.from(keys).join(','));
  }

  window.history.replaceState({}, '', url.toString());
}

interface ActivityFilterProps {
  selectedKeys: Set<string>;
  onSelectionChange: (keys: Set<string>) => void;
}

export function ActivityFilter({ selectedKeys, onSelectionChange }: ActivityFilterProps) {
  const [open, setOpen] = useState(false);

  const toggleFilter = (key: string) => {
    const newKeys = new Set(selectedKeys);
    if (newKeys.has(key)) {
      newKeys.delete(key);
    } else {
      newKeys.add(key);
    }
    onSelectionChange(newKeys);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1">
          <Filter className="h-3.5 w-3.5" />
          Filter
          {selectedKeys.size < FILTER_TYPES.length && (
            <Badge variant="secondary" className="ml-1 rounded-full px-1.5 text-xs">
              {selectedKeys.size}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Filter events..." />
          <CommandList>
            <CommandEmpty>No event type found.</CommandEmpty>
            <CommandGroup>
              {FILTER_TYPES.map((ft) => (
                <CommandItem key={ft.key} onSelect={() => toggleFilter(ft.key)}>
                  <div
                    className={cn(
                      'mr-2 flex h-4 w-4 items-center justify-center rounded-sm border',
                      selectedKeys.has(ft.key)
                        ? 'bg-primary text-primary-foreground'
                        : 'opacity-50'
                    )}
                  >
                    {selectedKeys.has(ft.key) && <Check className="h-3 w-3" />}
                  </div>
                  {ft.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
