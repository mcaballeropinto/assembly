import { z } from "zod";
import type { StationMeta, TaskEvent } from "../task-events";

export const TaskEventKindSchema = z.enum([
  "message",
  "tool_call",
  "tool_result",
  "heartbeat",
  "lifecycle",
]);

export const TaskEventSchema = z.object({
  ts: z.string(),
  station: z.string(),
  kind: TaskEventKindSchema,
  summary: z.string(),
  detail: z.unknown().optional(),
  seq: z.number().int().nonnegative(),
}).strict() satisfies z.ZodType<TaskEvent>;

export const StationMetaSchema = z.object({
  name: z.string(),
  status: z.enum(["running", "ok", "error", "aborted", "timeout"]),
  started_at: z.string(),
  finished_at: z.string().optional(),
  event_count: z.number().int().nonnegative(),
  last_ts: z.string(),
}).strict() satisfies z.ZodType<StationMeta>;

export const TaskEventIndexSchema = z.object({
  stations: z.array(StationMetaSchema),
  updated_at: z.string().optional(),
}).strict();
