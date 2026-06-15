import type { ApiStateResponse } from '@/lib/api';

export type ActivityFilterKey =
  | 'station_done'
  | 'retry'
  | 'error'
  | 'routed'
  | 'escalated'
  | 'task_received'
  | 'task_done'
  | 'trigger';

export type ActivityTone = 'default' | 'done' | 'retry' | 'error' | 'routed' | 'escalated' | 'trigger';

export type ActivityIconKind =
  | 'done'
  | 'retry'
  | 'error'
  | 'routed'
  | 'escalated'
  | 'task_received'
  | 'trigger'
  | 'activity';

export interface ActivityFilterDefinition {
  key: ActivityFilterKey;
  label: string;
}

export interface DashboardActivityEvent {
  id: string;
  line: string;
  ts: string;
  event: string;
  station?: string;
  workpiece?: string;
  workpieceFile?: string;
  detail: string;
  detailTitle?: string;
  source?: string;
  target?: string;
  reason?: string;
  childLive?: boolean;
  silentSeconds?: number;
  filterKey: ActivityFilterKey | null;
  tone: ActivityTone;
  iconKind: ActivityIconKind;
  raw: Record<string, unknown>;
}

export const ACTIVITY_FILTERS: ActivityFilterDefinition[] = [
  { key: 'station_done', label: 'Done' },
  { key: 'retry', label: 'Retry' },
  { key: 'error', label: 'Error' },
  { key: 'routed', label: 'Routed' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'task_received', label: 'Received' },
  { key: 'task_done', label: 'Task done' },
  { key: 'trigger', label: 'Trigger' },
];

const FILTER_KEYS = ACTIVITY_FILTERS.map((filter) => filter.key);

export function activityFilterKey(event: string): ActivityFilterKey | null {
  if (event === 'station_done') return 'station_done';
  if (event === 'task_done') return 'task_done';
  if (event === 'retry' || event === 'retry_manual') return 'retry';
  if (event.includes('error') || event === 'error_bucket') return 'error';
  if (event === 'routed' || event === 'queued') return 'routed';
  if (event === 'escalated') return 'escalated';
  if (event === 'task_received') return 'task_received';
  if (event === 'trigger_fired' || event === 'trigger_skipped') return 'trigger';
  return null;
}

export function normalizeActivity(state: ApiStateResponse): DashboardActivityEvent[] {
  const rows: DashboardActivityEvent[] = [];

  for (const line of state.lines) {
    if (!line.state || !Array.isArray(line.state.activity)) continue;

    line.state.activity.forEach((entry, index) => {
      if (!isRecord(entry)) return;

      const event = stringField(entry.event);
      const ts = stringField(entry.ts);
      if (!event || !ts) return;

      const workpiece = stringField(entry.workpiece);
      const source = stringField(entry.source);
      const target = stringField(entry.target);
      const reason = stringField(entry.reason);
      const detail = deriveDetail(entry, event, source, target, reason, workpiece);
      const filterKey = activityFilterKey(event);

      rows.push({
        id: [ts, line.name, event, workpiece || stringField(entry.station) || index].join('-'),
        line: line.name,
        ts,
        event,
        station: stringField(entry.station),
        workpiece,
        workpieceFile: workpiece ? `${workpiece}.json` : undefined,
        detail,
        detailTitle: detail || undefined,
        source,
        target,
        reason,
        childLive: booleanField(entry.child_live),
        silentSeconds: numberField(entry.silent_s),
        filterKey,
        tone: toneForFilter(filterKey),
        iconKind: iconKindForFilter(filterKey),
        raw: entry,
      });
    });
  }

  return rows.sort((a, b) => b.ts.localeCompare(a.ts));
}

export function filterActivity(
  items: DashboardActivityEvent[],
  selectedKeys: Set<ActivityFilterKey>
): DashboardActivityEvent[] {
  const allSelected = selectedKeys.size === ACTIVITY_FILTERS.length;

  return items.filter((item) => {
    if (!item.filterKey) return allSelected;
    return selectedKeys.has(item.filterKey);
  });
}

export function parseActivitySearch(raw: string | null | undefined): Set<ActivityFilterKey> {
  if (raw == null) return new Set(FILTER_KEYS);
  if (raw === '') return new Set();

  const requested = new Set(raw.split(',').filter(Boolean));
  return new Set(FILTER_KEYS.filter((key) => requested.has(key)));
}

export function serializeActivitySearch(selectedKeys: Set<ActivityFilterKey>): string | undefined {
  if (selectedKeys.size === ACTIVITY_FILTERS.length) return undefined;
  if (selectedKeys.size === 0) return '';
  return FILTER_KEYS.filter((key) => selectedKeys.has(key)).join(',');
}

function deriveDetail(
  entry: Record<string, unknown>,
  event: string,
  source: string | undefined,
  target: string | undefined,
  reason: string | undefined,
  workpiece: string | undefined
): string {
  const summary = stringField(entry.summary);
  if (summary) return summary;
  const task = stringField(entry.task);
  if (task) return task;
  const error = stringField(entry.error);
  if (error) return error;
  if (workpiece) return workpiece;
  if (event === 'trigger_fired' && source && target) return `${source} -> ${target}`;
  if (event === 'trigger_skipped' && target && reason) return `${target}: ${reason}`;
  return '';
}

function toneForFilter(filterKey: ActivityFilterKey | null): ActivityTone {
  if (!filterKey) return 'default';
  if (filterKey === 'station_done' || filterKey === 'task_done') return 'done';
  if (filterKey === 'retry') return 'retry';
  if (filterKey === 'error') return 'error';
  if (filterKey === 'routed') return 'routed';
  if (filterKey === 'escalated') return 'escalated';
  if (filterKey === 'trigger') return 'trigger';
  return 'default';
}

function iconKindForFilter(filterKey: ActivityFilterKey | null): ActivityIconKind {
  if (!filterKey) return 'activity';
  if (filterKey === 'station_done' || filterKey === 'task_done') return 'done';
  if (filterKey === 'task_received') return 'task_received';
  return filterKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
