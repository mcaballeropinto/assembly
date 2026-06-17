import { z } from "zod";
import type { EmitRecord } from "../emit-manifest";

export const EmitSourceSchema = z.enum([
  "fanout",
  "trigger",
  "cli",
  "release",
  "transition",
  "bootstrap",
  "recovery",
  "improver",
]);

export const EmitRecordSchema = z.object({
  filename: z.string().min(1),
  source: EmitSourceSchema,
  ts: z.string(),
}).strict() satisfies z.ZodType<EmitRecord>;
