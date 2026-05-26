import { basename } from "path";

// ─── Branded types ─────────────────────────────────────────────────────

/**
 * Branded type for workpiece IDs.
 * Zero runtime cost — compile-time only discrimination.
 */
export type WorkpieceId = string & { readonly __brand: "WorkpieceId" };

/**
 * Branded type for line names.
 */
export type LineName = string & { readonly __brand: "LineName" };

/**
 * Branded type for station names.
 */
export type StationName = string & { readonly __brand: "StationName" };

/**
 * Branded type for task file basenames.
 */
export type TaskFileName = string & { readonly __brand: "TaskFileName" };

// ─── Error class ───────────────────────────────────────────────────────

export class InvalidTaskFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskFileError";
  }
}

// ─── Constructors ──────────────────────────────────────────────────────

/**
 * Construct a WorkpieceId from a string. Unchecked cast.
 */
export const WorkpieceId = (s: string): WorkpieceId => s as WorkpieceId;

/**
 * Construct a LineName from a string. Unchecked cast.
 */
export const LineName = (s: string): LineName => s as LineName;

/**
 * Construct a StationName from a string. Unchecked cast.
 */
export const StationName = (s: string): StationName => s as StationName;

/**
 * Construct a TaskFileName from a string, validating basename/.json/no-traversal.
 * Throws InvalidTaskFileError if validation fails.
 * Replaces the runtime validateTaskFile guard from held.ts.
 */
export const TaskFileName = (s: string): TaskFileName => {
  const base = basename(s);
  if (
    base !== s ||
    !s.endsWith(".json") ||
    s.includes("..") ||
    s.includes("/") ||
    s.includes("\\")
  ) {
    throw new InvalidTaskFileError(
      `Invalid task file: ${s} (must be a basename ending in .json)`
    );
  }
  return s as TaskFileName;
};

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Type assertion helper for JSON deserialization boundaries.
 * Use this at loadWorkpiece, orchestrator JSON.parse sites, etc.
 * Zero runtime cost — just makes the cast explicit and greppable.
 */
export const asWorkpiece = <T>(raw: unknown): T => raw as T;
