import { describe, expect, test } from 'bun:test';
import type { ApiStateResponse } from '../lib/api';
import {
  ACTIVITY_FILTERS,
  activityFilterKey,
  filterActivity,
  normalizeActivity,
  parseActivitySearch,
  serializeActivitySearch,
  type ActivityFilterKey,
} from '../lib/activity';

const allKeys = ACTIVITY_FILTERS.map((filter) => filter.key);

describe('activityFilterKey', () => {
  test('maps legacy and current event names', () => {
    expect(activityFilterKey('station_done')).toBe('station_done');
    expect(activityFilterKey('task_done')).toBe('task_done');
    expect(activityFilterKey('retry')).toBe('retry');
    expect(activityFilterKey('retry_manual')).toBe('retry');
    expect(activityFilterKey('error_bucket')).toBe('error');
    expect(activityFilterKey('station_error')).toBe('error');
    expect(activityFilterKey('routed')).toBe('routed');
    expect(activityFilterKey('queued')).toBe('routed');
    expect(activityFilterKey('escalated')).toBe('escalated');
    expect(activityFilterKey('task_received')).toBe('task_received');
    expect(activityFilterKey('trigger_fired')).toBe('trigger');
    expect(activityFilterKey('trigger_skipped')).toBe('trigger');
    expect(activityFilterKey('station_heartbeat')).toBeNull();
  });
});

describe('activity search serialization', () => {
  test('missing param selects every filter and serializes to undefined', () => {
    const parsed = parseActivitySearch(undefined);
    expect([...parsed]).toEqual(allKeys);
    expect(serializeActivitySearch(parsed)).toBeUndefined();
  });

  test('empty param selects no filters and serializes to empty string', () => {
    const parsed = parseActivitySearch('');
    expect([...parsed]).toEqual([]);
    expect(serializeActivitySearch(parsed)).toBe('');
  });

  test('partial and invalid params serialize in filter order', () => {
    const parsed = parseActivitySearch('trigger,nope,error,error');
    expect([...parsed]).toEqual(['error', 'trigger']);
    expect(serializeActivitySearch(parsed)).toBe('error,trigger');
  });
});

describe('normalizeActivity', () => {
  test('merges lines, sorts descending, derives details, and skips malformed entries', () => {
    const rows = normalizeActivity(stateFixture());

    expect(rows.map((row) => row.event)).toEqual([
      'trigger_skipped',
      'station_done',
      'trigger_fired',
      'station_heartbeat',
      'retry_manual',
    ]);
    expect(rows[0].detail).toBe('deploy: disabled');
    expect(rows[1].line).toBe('assembly-dev');
    expect(rows[1].workpieceFile).toBe('wp-2.json');
    expect(rows[2].detail).toBe('inbox -> develop');
    expect(rows[3].silentSeconds).toBe(91);
    expect(rows[4].filterKey).toBe('retry');
  });
});

describe('filterActivity', () => {
  test('applies selected filter keys and grouped aliases', () => {
    const rows = normalizeActivity(stateFixture());
    const retryOnly = filterActivity(rows, new Set<ActivityFilterKey>(['retry']));
    expect(retryOnly.map((row) => row.event)).toEqual(['retry_manual']);

    const triggerOnly = filterActivity(rows, new Set<ActivityFilterKey>(['trigger']));
    expect(triggerOnly.map((row) => row.event)).toEqual(['trigger_skipped', 'trigger_fired']);
  });

  test('keeps unmatched events only when all filters are active', () => {
    const rows = normalizeActivity(stateFixture());
    const all = filterActivity(rows, new Set<ActivityFilterKey>(allKeys));
    expect(all.some((row) => row.event === 'station_heartbeat')).toBe(true);

    const none = filterActivity(rows, new Set<ActivityFilterKey>());
    expect(none).toEqual([]);
  });
});

function stateFixture(): ApiStateResponse {
  return {
    timestamp: '2026-06-15T05:00:00.000Z',
    version: 'test',
    totals: {
      lines: 3,
      linesRunning: 2,
      linesErrored: 0,
      totalInbox: 0,
      totalDone: 0,
      totalErrors: 0,
      totalReview: 0,
      totalCostUsd: 0,
      totalThroughput1h: 0,
      totalThroughput24h: 0,
    },
    lines: [
      {
        name: 'assembly-dev',
        path: '/tmp/assembly-dev',
        status: 'running',
        startedAt: '2026-06-15T04:00:00.000Z',
        state: minimalLineState([
          { ts: '2026-06-15T04:00:00.000Z', event: 'retry_manual', workpiece: 'wp-1' },
          {
            ts: '2026-06-15T04:03:00.000Z',
            event: 'station_done',
            station: 'develop',
            workpiece: 'wp-2',
            summary: 'implemented',
          },
          null,
          'bad',
          { event: 'missing_ts' },
        ]),
      },
      {
        name: 'operator',
        path: '/tmp/operator',
        status: 'running',
        startedAt: '2026-06-15T04:00:00.000Z',
        state: minimalLineState([
          {
            ts: '2026-06-15T04:02:00.000Z',
            event: 'trigger_fired',
            source: 'inbox',
            target: 'develop',
          },
          {
            ts: '2026-06-15T04:04:00.000Z',
            event: 'trigger_skipped',
            target: 'deploy',
            reason: 'disabled',
          },
          {
            ts: '2026-06-15T04:01:00.000Z',
            event: 'station_heartbeat',
            station: 'review',
            child_live: true,
            silent_s: 91,
          },
        ]),
      },
      {
        name: 'null-state',
        path: '/tmp/null',
        status: 'running',
        startedAt: '2026-06-15T04:00:00.000Z',
        state: null,
      },
    ],
  };
}

function minimalLineState(activity: unknown[]): NonNullable<ApiStateResponse['lines'][number]['state']> {
  return {
    line: 'test',
    sequence: [],
    lineQueue: { inbox: 0, done: 0, error: 0, errorActive: 0, review: 0 },
    held: [],
    sections: {},
    pipelineTotalMs: null,
    activity,
    completed: [],
    errors: [],
    errorsDismissed: [],
    timestamp: '2026-06-15T05:00:00.000Z',
  };
}
