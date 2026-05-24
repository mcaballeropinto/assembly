import { resolve } from "path";
import type { Workpiece, StationResult, StationEnvelope, TokenUsage, FailureClass } from "./types";
import { CURRENT_WORKPIECE_VERSION, validateWorkpieceVersion } from './schemas/workpiece';

// Process-local counter so a fanout batch hitting createWorkpiece in the same
// millisecond still gets distinct ids. ISO-millisecond alone collides whenever
// the line-inbox watcher drains 30+ files back-to-back.
let _wpSeq = 0;

/**
 * Create a fresh workpiece for a new run.
 */
export function createWorkpiece(
  lineName: string,
  task: string,
  input: Record<string, unknown> = {}
): Workpiece {
  const now = new Date();
  const seq = (_wpSeq++ & 0xfff).toString(16).padStart(3, "0");
  const id = `run_${now.toISOString().replace(/[:.]/g, "-")}_${seq}`;

  return {
    id,
    schema_version: CURRENT_WORKPIECE_VERSION,
    line: lineName,
    task,
    input,
    stations: {},
  };
}

/**
 * Write a station's envelope into the workpiece.
 * The runner calls this — stations never touch the workpiece directly.
 */
export function writeStation(
  workpiece: Workpiece,
  stationName: string,
  envelope: StationEnvelope,
  meta: {
    model: string;
    tokens: TokenUsage;
    cost_usd: number;
    started_at: string;
    finished_at: string;
  }
): Workpiece {
  const result: StationResult = {
    status: "done",
    summary: envelope.summary,
    content: envelope.content,
    data: envelope.data,
    started_at: meta.started_at,
    finished_at: meta.finished_at,
    model: meta.model,
    tokens: meta.tokens,
    cost_usd: meta.cost_usd,
  };

  // Drain any accumulated retry history into previous_attempts
  const history = workpiece._retry_history?.[stationName];
  if (history && history.length > 0) {
    result.previous_attempts = history;
  }

  const updated: Workpiece = {
    ...workpiece,
    stations: {
      ...workpiece.stations,
      [stationName]: result,
    },
  };

  // Clear consumed retry history scratch
  if (updated._retry_history?.[stationName]) {
    delete updated._retry_history[stationName];
    if (Object.keys(updated._retry_history).length === 0) {
      delete updated._retry_history;
    }
  }

  return updated;
}

/**
 * Mark a station as failed.
 */
export function failStation(
  workpiece: Workpiece,
  stationName: string,
  error: string,
  meta: {
    model: string;
    tokens: TokenUsage;
    started_at: string;
    finished_at: string;
  },
  failureClass: FailureClass = "unknown"
): Workpiece {
  const result: StationResult = {
    status: "failed",
    summary: `Failed: ${error}`,
    data: { error },
    started_at: meta.started_at,
    finished_at: meta.finished_at,
    model: meta.model,
    tokens: meta.tokens,
    cost_usd: 0,
    failure_class: failureClass,
  };

  // Drain any accumulated retry history into previous_attempts
  const history = workpiece._retry_history?.[stationName];
  if (history && history.length > 0) {
    result.previous_attempts = history;
  }

  const updated: Workpiece = {
    ...workpiece,
    stations: {
      ...workpiece.stations,
      [stationName]: result,
    },
  };

  // Clear consumed retry history scratch
  if (updated._retry_history?.[stationName]) {
    delete updated._retry_history[stationName];
    if (Object.keys(updated._retry_history).length === 0) {
      delete updated._retry_history;
    }
  }

  return updated;
}

/**
 * Mark a station as escalated (needs human review).
 */
export function escalateStation(
  workpiece: Workpiece,
  stationName: string,
  feedback: string,
  meta: {
    model: string;
    tokens: TokenUsage;
    cost_usd: number;
    started_at: string;
    finished_at: string;
  }
): Workpiece {
  const result: StationResult = {
    status: "escalated",
    summary: `Escalated: ${feedback.slice(0, 200)}`,
    data: { escalation_reason: feedback },
    started_at: meta.started_at,
    finished_at: meta.finished_at,
    model: meta.model,
    tokens: meta.tokens,
    cost_usd: meta.cost_usd,
  };

  return {
    ...workpiece,
    stations: {
      ...workpiece.stations,
      [stationName]: result,
    },
  };
}

/**
 * Save workpiece to disk (checkpoint).
 */
export async function saveWorkpiece(
  workpiece: Workpiece,
  runDir: string
): Promise<void> {
  const path = resolve(runDir, "workpiece.json");
  await Bun.write(path, JSON.stringify(workpiece, null, 2));
}

/**
 * Load workpiece from disk (for resume).
 */
export async function loadWorkpiece(path: string): Promise<Workpiece> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Workpiece not found at ${path}`);
  }
  const raw = JSON.parse(await file.text()) as Record<string, unknown>;
  validateWorkpieceVersion(raw);
  return raw as unknown as Workpiece;
}

/**
 * Get a run directory path for a new run.
 */
export function getRunDir(runsDir: string, workpiece: Workpiece): string {
  return resolve(runsDir, `${workpiece.id}-${workpiece.line}`);
}
