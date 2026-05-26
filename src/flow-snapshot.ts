import { resolve } from "path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { getLineQueueState, getSectionQueueState } from "./queue";
import type { StationName } from "./ids";

export interface FlowSectionCounts {
  inbox: number;
  processing: number;
  output: number;
}

export interface FlowSnapshot {
  ts: string; // ISO 8601
  line: { inbox: number; done: number; error: number; errorActive: number; review: number };
  sections: Record<string, FlowSectionCounts>;
}

export const DEFAULT_FLOW_INTERVAL_MS = 60_000;

export function flowFilePath(linePath: string): string {
  return resolve(linePath, "queues", "flow.jsonl");
}

export function takeSnapshot(linePath: string, sequence: StationName[]): FlowSnapshot {
  const line = getLineQueueState(linePath);
  const sections: Record<string, FlowSectionCounts> = {};
  for (const name of sequence) {
    const stationDir = resolve(linePath, "stations", name);
    sections[name] = getSectionQueueState(stationDir);
  }
  return { ts: new Date().toISOString(), line, sections };
}

export function appendSnapshot(linePath: string, snap: FlowSnapshot): void {
  const queuesDir = resolve(linePath, "queues");
  if (!existsSync(queuesDir)) mkdirSync(queuesDir, { recursive: true });
  appendFileSync(flowFilePath(linePath), JSON.stringify(snap) + "\n");
}

export interface StartFlowWriterOptions {
  intervalMs?: number;
  onError?: (err: Error) => void;
}

export function startFlowSnapshotWriter(
  linePath: string,
  sequence: StationName[],
  opts: StartFlowWriterOptions = {}
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? envIntervalMs() ?? DEFAULT_FLOW_INTERVAL_MS;
  function tick() {
    try {
      appendSnapshot(linePath, takeSnapshot(linePath, sequence));
    } catch (err) {
      opts.onError?.(err as Error);
    }
  }
  tick(); // write t0 immediately so charts aren't empty on fresh lines
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}

function envIntervalMs(): number | undefined {
  const v = process.env.ASSEMBLY_FLOW_SNAPSHOT_MS;
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ReadFlowOptions {
  hours?: number; // window size; default 24
  maxPoints?: number; // cap; default 200 — uniformly downsample if exceeded
  now?: number; // injectable clock for tests (ms)
}

export function readFlowHistory(
  linePath: string,
  opts: ReadFlowOptions = {}
): { snapshots: FlowSnapshot[]; total: number } {
  const path = flowFilePath(linePath);
  if (!existsSync(path)) return { snapshots: [], total: 0 };
  const now = opts.now ?? Date.now();
  const hours = opts.hours ?? 24;
  const maxPoints = opts.maxPoints ?? 200;
  const cutoff = now - hours * 3600 * 1000;

  const raw = readFileSync(path, "utf-8").split("\n");
  const filtered: FlowSnapshot[] = [];
  for (const line of raw) {
    if (!line) continue;
    try {
      const snap = JSON.parse(line) as FlowSnapshot;
      if (!snap.ts) continue;
      if (new Date(snap.ts).getTime() >= cutoff) filtered.push(snap);
    } catch {
      /* skip malformed line */
    }
  }

  const total = filtered.length;
  if (total <= maxPoints) return { snapshots: filtered, total };
  const step = Math.ceil(total / maxPoints);
  const sampled: FlowSnapshot[] = [];
  for (let i = 0; i < total; i += step) sampled.push(filtered[i]);
  // Always include the newest point so the chart's right edge matches current state.
  if (sampled[sampled.length - 1] !== filtered[total - 1]) sampled.push(filtered[total - 1]);
  return { snapshots: sampled, total };
}
