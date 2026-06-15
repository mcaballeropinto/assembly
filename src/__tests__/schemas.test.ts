import { describe, expect, test } from "bun:test";
import {
  EmitRecordSchema,
  EvalFrontmatterSchema,
  FanoutPayloadSchema,
  InboxPayloadSchema,
  RetryStateSchema,
  StationFrontmatterSchema,
  TaskEventSchema,
  WorkpieceSchema,
} from "../schemas";
import { LineName, WorkpieceId } from "../ids";
import { createWorkpiece } from "../workpiece";

describe("boundary schemas", () => {
  test("WorkpieceSchema round-trips a valid workpiece and preserves dynamic keys", () => {
    const raw = JSON.parse(JSON.stringify(createWorkpiece(LineName("test-line"), "do the thing", { a: 1 })));
    raw.extra_station_artifact = { ok: true };
    raw.previous_attempts = [];
    raw._retry_history = {};

    const parsed = WorkpieceSchema.parse(raw);
    expect(parsed.id).toBe(raw.id);
    expect(parsed.line).toBe(LineName("test-line"));
    expect(parsed.stations).toEqual({});
    expect((parsed as any).extra_station_artifact).toEqual({ ok: true });
  });

  test("WorkpieceSchema rejects corrupted workpieces with clear paths", () => {
    const result = WorkpieceSchema.safeParse({
      id: "wp-1",
      line: "line-a",
      task: "missing stations",
      input: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("stations"))).toBe(true);
    }
  });

  test("InboxPayloadSchema and FanoutPayloadSchema are strict", () => {
    const payload = {
      schema_version: 1,
      task: "hello",
      input: { target: "x" },
      source_workpiece_id: "wp-source",
    };
    expect(InboxPayloadSchema.parse(payload).source_workpiece_id).toBe(WorkpieceId("wp-source"));
    expect(FanoutPayloadSchema.parse(payload).task).toBe("hello");
    expect(InboxPayloadSchema.safeParse({ ...payload, typo: true }).success).toBe(false);
  });

  test("station and eval frontmatter validate providers", () => {
    expect(StationFrontmatterSchema.parse({
      provider: "script",
      script: "run.sh",
      reads: ["input"],
      tools: ["Bash"],
    }).provider).toBe("script");
    expect(EvalFrontmatterSchema.parse({ provider: "api", on_fail: "retry", max_retries: 1 }).on_fail).toBe("retry");
    expect(StationFrontmatterSchema.safeParse({ provider: "nonsense" }).success).toBe(false);
  });

  test("retry state, task event, and emit manifest schemas accept golden records", () => {
    expect(RetryStateSchema.parse({
      retry_count: 1,
      max_retries: 3,
      failure_class: "provider",
      in_backoff: true,
      backoff_until: "2026-06-14T00:00:00.000Z",
      exhausted: false,
    }).retry_count).toBe(1);

    expect(TaskEventSchema.parse({
      ts: "2026-06-14T00:00:00.000Z",
      station: "build",
      kind: "lifecycle",
      summary: "Started",
      seq: 1,
    }).kind).toBe("lifecycle");

    expect(EmitRecordSchema.parse({
      filename: "task.json",
      source: "fanout",
      ts: "2026-06-14T00:00:00.000Z",
    }).source).toBe("fanout");
  });

  test("sidecar schemas reject malformed enum and count fields", () => {
    expect(RetryStateSchema.safeParse({
      retry_count: -1,
      max_retries: 3,
      in_backoff: false,
      exhausted: false,
    }).success).toBe(false);
    expect(TaskEventSchema.safeParse({
      ts: "now",
      station: "s",
      kind: "bogus",
      summary: "x",
      seq: 1,
    }).success).toBe(false);
    expect(EmitRecordSchema.safeParse({
      filename: "x.json",
      source: "bogus",
      ts: "now",
    }).success).toBe(false);
  });
});
