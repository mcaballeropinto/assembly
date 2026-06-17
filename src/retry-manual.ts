import { basename, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dismissFilenames } from "./error-dismiss";
import { recordEmit } from "./emit-manifest";
import { WorkpieceId, LineName, StationName } from "./ids";
import type { StationResult, Workpiece } from "./types";

export class InvalidRetryFileNameError extends Error {
  constructor(fileName: string) {
    super(`Invalid fileName: ${fileName}`);
    this.name = "InvalidRetryFileNameError";
  }
}

export class ErrorFileNotFoundError extends Error {
  constructor(fileName: string) {
    super(`Error workpiece not found: ${fileName}`);
    this.name = "ErrorFileNotFoundError";
  }
}

export class ReviewFileNotFoundError extends Error {
  constructor(fileName: string) {
    super(`Review workpiece not found: ${fileName}`);
    this.name = "ReviewFileNotFoundError";
  }
}

export class ReviewRetryTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRetryTargetError";
  }
}

function assertValidBasename(fileName: string): void {
  const base = basename(fileName);
  if (
    base !== fileName ||
    !fileName.endsWith(".json") ||
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new InvalidRetryFileNameError(fileName);
  }
}

/**
 * Copy an errored workpiece back into the line inbox under a fresh id/filename
 * so it runs again from the first station, and auto-dismiss the original so it
 * disappears from the active Errored list while staying on disk for audit.
 */
export function retryErroredWorkpiece(
  linePath: string,
  fileName: string
): { newId: string; newFileName: string; originalId: string | null } {
  assertValidBasename(fileName);

  const errorPath = resolve(linePath, "queues", "error", fileName);
  if (!existsSync(errorPath)) {
    throw new ErrorFileNotFoundError(fileName);
  }

  const raw = JSON.parse(readFileSync(errorPath, "utf-8")) as {
    id?: string;
    line?: string;
    task?: string;
    input?: Record<string, unknown>;
  };

  const now = new Date();
  const suffix = Math.random().toString(36).slice(2, 8);
  const newId = `run_${now.toISOString().replace(/[:.]/g, "-")}_${suffix}`;
  const newFileName = `${newId}.json`;

  const copy = {
    id: WorkpieceId(newId),
    line: LineName(raw.line as string),
    task: raw.task ?? "",
    input: raw.input ?? {},
    stations: {} as Record<StationName, StationResult>,
    parent_run_id: raw.id ?? null,
  };

  const inboxDir = resolve(linePath, "queues", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  // Producer-allowlist BEFORE the file appears in the watched dir.
  // watchFolder fires on file creation; if recordEmit runs after
  // writeFileSync, the watcher can race in and quarantine the file as
  // producer_unknown before the allowlist entry exists (observed
  // 2026-05-21 00:58:51 — 1ms race window).
  recordEmit(inboxDir, newFileName, "release");
  writeFileSync(
    resolve(inboxDir, newFileName),
    JSON.stringify(copy, null, 2)
  );

  dismissFilenames(linePath, [fileName]);

  return { newId, newFileName, originalId: raw.id ?? null };
}

function findEscalatedStation(workpiece: Workpiece, requested?: string): StationName {
  if (requested) {
    const station = StationName(requested);
    if (workpiece.stations?.[station]?.status !== "escalated") {
      throw new ReviewRetryTargetError(`Station "${requested}" is not escalated on this workpiece`);
    }
    return station;
  }

  const match = Object.entries(workpiece.stations ?? {})
    .find(([, result]) => result?.status === "escalated");
  if (!match) {
    throw new ReviewRetryTargetError("No escalated station found on review workpiece");
  }
  return StationName(match[0]);
}

function preserveAttempt(workpiece: Workpiece, station: StationName): Workpiece {
  const current = workpiece.stations[station];
  if (!current) return workpiece;
  const { previous_attempts: previousAttempts, ...flatCurrent } = current;
  const attempts = Array.isArray(previousAttempts) ? previousAttempts : [];
  return {
    ...workpiece,
    stations: {
      ...workpiece.stations,
      [station]: {
        ...current,
        previous_attempts: [...attempts, flatCurrent],
      },
    },
  };
}

/**
 * Requeue a review/escalated workpiece at the station that escalated it,
 * preserving the full eval feedback in previous_attempts so scripted stations
 * can retry with the actionable failure text.
 */
export function retryReviewWorkpiece(
  linePath: string,
  fileName: string,
  stationName?: string
): { fileName: string; station: string; originalId: string | null } {
  assertValidBasename(fileName);

  const reviewPath = resolve(linePath, "queues", "review", fileName);
  if (!existsSync(reviewPath)) {
    throw new ReviewFileNotFoundError(fileName);
  }

  const raw = JSON.parse(readFileSync(reviewPath, "utf-8")) as Workpiece;
  const station = findEscalatedStation(raw, stationName);
  const copy = preserveAttempt({
    ...raw,
    input: {
      ...(raw.input ?? {}),
      review_retry: {
        retried_at: new Date().toISOString(),
        station,
      },
    },
  }, station);

  const inboxDir = resolve(linePath, "stations", station, "queue", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  recordEmit(inboxDir, fileName, "release");
  writeFileSync(resolve(inboxDir, fileName), JSON.stringify(copy, null, 2));
  const retriedDir = resolve(linePath, "queues", "review", ".retried");
  mkdirSync(retriedDir, { recursive: true });
  renameSync(reviewPath, resolve(retriedDir, fileName));

  return { fileName, station, originalId: raw.id ?? null };
}
