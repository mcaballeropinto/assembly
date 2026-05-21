import { basename, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dismissFilenames } from "./error-dismiss";
import { recordEmit } from "./emit-manifest";

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
    id: newId,
    line: raw.line,
    task: raw.task ?? "",
    input: raw.input ?? {},
    stations: {},
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
