import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
import {
  retryErroredWorkpiece,
  retryReviewWorkpiece,
  InvalidRetryFileNameError,
  ErrorFileNotFoundError,
  ReviewFileNotFoundError,
} from "../retry-manual";
import { readDismissed } from "../error-dismiss";

const TEMP_DIR = resolve("/tmp", `assembly-test-retry-manual-${Date.now()}`);
const LINE_DIR = resolve(TEMP_DIR, "line");
const ERROR_DIR = resolve(LINE_DIR, "queues", "error");
const REVIEW_DIR = resolve(LINE_DIR, "queues", "review");
const INBOX_DIR = resolve(LINE_DIR, "queues", "inbox");

function seedErrorFile(fileName: string, id: string) {
  mkdirSync(ERROR_DIR, { recursive: true });
  writeFileSync(
    resolve(ERROR_DIR, fileName),
    JSON.stringify({
      id,
      line: "retry-test-line",
      task: "Do the thing",
      input: { foo: "bar" },
      stations: {
        plan: {
          summary: "boom",
          status: "failed",
          started_at: "2026-04-01T10:00:00Z",
          finished_at: "2026-04-01T10:00:10Z",
          model: "sonnet",
          tokens: { in: 100, out: 50 },
          cost_usd: 0.002,
        },
      },
    })
  );
}

function seedReviewFile(fileName: string, id: string) {
  mkdirSync(REVIEW_DIR, { recursive: true });
  writeFileSync(
    resolve(REVIEW_DIR, fileName),
    JSON.stringify({
      id,
      line: "retry-test-line",
      task: "Do the reviewed thing",
      input: { foo: "review" },
      stations: {
        plan: {
          summary: "planned",
          status: "done",
          started_at: "2026-04-01T10:00:00Z",
          finished_at: "2026-04-01T10:00:10Z",
          model: "sonnet",
          tokens: { in: 100, out: 50 },
          cost_usd: 0.002,
        },
        develop: {
          summary: "Escalated: tests failed",
          status: "escalated",
          data: { escalation_reason: "Tests failed in develop worktree" },
          eval: {
            pass: false,
            feedback: "Tests failed in develop worktree",
            action: "retry",
          },
          started_at: "2026-04-01T10:00:10Z",
          finished_at: "2026-04-01T10:00:20Z",
          model: "script",
          tokens: { in: 0, out: 0 },
          cost_usd: 0,
        },
      },
    })
  );
}

beforeEach(() => {
  try {
    rmSync(LINE_DIR, { recursive: true, force: true });
  } catch {}
  mkdirSync(INBOX_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

describe("retryErroredWorkpiece", () => {
  test("copies task/input to fresh inbox file and dismisses original", () => {
    seedErrorFile("wp-err-1.json", "run-old-1");

    const { newId, newFileName, originalId } = retryErroredWorkpiece(
      LINE_DIR,
      "wp-err-1.json"
    );

    expect(originalId).toBe("run-old-1");
    expect(newFileName).toBe(newId + ".json");
    expect(newId).toMatch(/^run_/);

    const inboxPath = resolve(INBOX_DIR, newFileName);
    expect(existsSync(inboxPath)).toBe(true);

    const written = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(written.id).toBe(newId);
    expect(written.task).toBe("Do the thing");
    expect(written.input).toEqual({ foo: "bar" });
    expect(written.stations).toEqual({});
    expect(written.parent_run_id).toBe("run-old-1");

    // Original still on disk
    expect(existsSync(resolve(ERROR_DIR, "wp-err-1.json"))).toBe(true);

    // Original auto-dismissed
    const dismissed = readDismissed(LINE_DIR);
    expect(Object.keys(dismissed)).toContain("wp-err-1.json");
  });

  test("preserves distinct ids across retries", () => {
    seedErrorFile("wp-err-2.json", "run-old-2");
    const first = retryErroredWorkpiece(LINE_DIR, "wp-err-2.json");

    // Re-seed so the source exists again for a second retry
    seedErrorFile("wp-err-3.json", "run-old-3");
    const second = retryErroredWorkpiece(LINE_DIR, "wp-err-3.json");

    expect(first.newId).not.toBe(second.newId);
    const inboxFiles = readdirSync(INBOX_DIR).filter((f) => f.endsWith(".json"));
    expect(inboxFiles).toContain(first.newFileName);
    expect(inboxFiles).toContain(second.newFileName);
  });

  test("rejects path traversal", () => {
    expect(() =>
      retryErroredWorkpiece(LINE_DIR, "../evil.json")
    ).toThrow(InvalidRetryFileNameError);
  });

  test("rejects non-json extension", () => {
    expect(() =>
      retryErroredWorkpiece(LINE_DIR, "task-1.txt")
    ).toThrow(InvalidRetryFileNameError);
  });

  test("rejects subpath", () => {
    expect(() =>
      retryErroredWorkpiece(LINE_DIR, "subdir/task.json")
    ).toThrow(InvalidRetryFileNameError);
  });

  test("throws ErrorFileNotFoundError when source missing", () => {
    mkdirSync(ERROR_DIR, { recursive: true });
    expect(() =>
      retryErroredWorkpiece(LINE_DIR, "nope.json")
    ).toThrow(ErrorFileNotFoundError);
  });
});

describe("retryReviewWorkpiece", () => {
  test("moves review workpiece to escalated station inbox and preserves feedback", () => {
    seedReviewFile("wp-review-1.json", "run-review-1");

    const result = retryReviewWorkpiece(LINE_DIR, "wp-review-1.json");

    expect(result.originalId).toBe("run-review-1");
    expect(result.station).toBe("develop");

    const inboxPath = resolve(LINE_DIR, "stations", "develop", "queue", "inbox", "wp-review-1.json");
    expect(existsSync(inboxPath)).toBe(true);
    const written = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(written.input.review_retry.station).toBe("develop");
    expect(written.stations.develop.previous_attempts).toHaveLength(1);
    expect(written.stations.develop.previous_attempts[0].eval.feedback).toContain("Tests failed");

    expect(existsSync(resolve(REVIEW_DIR, "wp-review-1.json"))).toBe(false);
    expect(existsSync(resolve(REVIEW_DIR, ".retried", "wp-review-1.json"))).toBe(true);
  });

  test("throws ReviewFileNotFoundError when review source missing", () => {
    expect(() =>
      retryReviewWorkpiece(LINE_DIR, "missing-review.json")
    ).toThrow(ReviewFileNotFoundError);
  });
});
