import {
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "fs";
import { resolve } from "path";
import { recordEmit } from "./emit-manifest";
import { InvalidTaskFileError, TaskFileName } from './ids';
import { InboxPayloadSchema } from "./schemas/inbox-payload";

// Re-export InvalidTaskFileError for backward compatibility
export { InvalidTaskFileError };

// ─── Types ─────────────────────────────────────────────────────────

export interface HeldTask {
  /** Basename, e.g. "task-1776568940274.json" */
  fileName: TaskFileName;
  /** Filename without .json extension, used for aria-label */
  id: string;
  /** Raw task text from JSON, truncated to 200 chars */
  task: string;
  /** ISO string from file mtime, or null */
  enqueued_at: string | null;
}

export interface ReleaseResult {
  released: string[];
  skipped: string[];
  errors: { file: string; message: string }[];
}

// ─── Helpers ───────────────────────────────────────────────────────

function heldDir(linePath: string): string {
  return resolve(linePath, "queues", "held");
}

function inboxDir(linePath: string): string {
  return resolve(linePath, "queues", "inbox");
}

// ─── listHeld ──────────────────────────────────────────────────────

/**
 * Return all held tasks for a line, sorted ascending by mtime.
 * Returns [] if the held/ directory does not exist.
 */
export function listHeld(linePath: string): HeldTask[] {
  const dir = heldDir(linePath);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const tasks: HeldTask[] = [];
  for (const fileName of files) {
    const filePath = resolve(dir, fileName);
    let taskText = "";
    try {
      const parsed = InboxPayloadSchema.safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      taskText = parsed.success ? parsed.data.task : `schema_violation: ${fileName}`;
    } catch {
      taskText = `schema_violation: ${fileName}`;
    }

    const mtime = Bun.file(filePath).lastModified;
    const enqueued_at = mtime ? new Date(mtime).toISOString() : null;

    tasks.push({
      fileName: TaskFileName(fileName), // Re-validate for defense-in-depth
      id: fileName.replace(/\.json$/, ""),
      task: String(taskText).slice(0, 200),
      enqueued_at,
    });
  }

  // Sort ascending by mtime (oldest first)
  tasks.sort((a, b) => {
    const at = a.enqueued_at ? new Date(a.enqueued_at).getTime() : 0;
    const bt = b.enqueued_at ? new Date(b.enqueued_at).getTime() : 0;
    return at - bt;
  });

  return tasks;
}

// ─── releaseHeldTasks ──────────────────────────────────────────────

/**
 * Move held tasks to the inbox. Idempotent: missing files go to skipped.
 * Throws InvalidTaskFileError for bad opts or unsafe file names.
 */
export function releaseHeldTasks(
  linePath: string,
  opts: { file?: string; all?: boolean }
): ReleaseResult {
  const result: ReleaseResult = { released: [], skipped: [], errors: [] };

  if (!opts.file && !opts.all) {
    throw new InvalidTaskFileError("Must provide file or all");
  }

  const held = heldDir(linePath);
  const inbox = inboxDir(linePath);

  // Ensure inbox exists (auto-create)
  mkdirSync(inbox, { recursive: true });

  if (opts.file) {
    const validated = TaskFileName(opts.file); // Validate and brand
    _releaseOne(held, inbox, validated, result);
  } else if (opts.all) {
    let files: string[] = [];
    if (existsSync(held)) {
      try {
        files = readdirSync(held).filter((f) => f.endsWith(".json"));
      } catch {
        files = [];
      }
    }
    for (const file of files) {
      _releaseOne(held, inbox, file, result);
    }
  }

  return result;
}

function _releaseOne(
  held: string,
  inbox: string,
  file: string,
  result: ReleaseResult
): void {
  const src = resolve(held, file);
  const dst = resolve(inbox, file);

  if (!existsSync(src)) {
    result.skipped.push(file);
    return;
  }

  try {
    // Producer-allowlist BEFORE the rename makes the file visible in
    // the watched inbox dir. watchFolder fires on appearance; if
    // recordEmit ran after renameSync, the watcher could race in and
    // quarantine the released task as producer_unknown.
    recordEmit(inbox, file, "release");
    renameSync(src, dst);
    result.released.push(file);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // File was claimed concurrently
      result.skipped.push(file);
    } else {
      result.errors.push({ file, message: (err as Error).message });
    }
  }
}
