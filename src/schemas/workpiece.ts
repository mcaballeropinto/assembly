import { z } from "zod";
import type { Workpiece, TokenUsage, EvalResult, StationRounds, StationEnvelope, StationResult, FailureClass } from "../types";
import { LineName, StationName, WorkpieceId } from "../types";

export const CURRENT_WORKPIECE_VERSION = 1 as const;
export const SUPPORTED_WORKPIECE_VERSIONS = [1] as const;

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    public readonly got: number,
    public readonly supported: readonly number[]
  ) {
    super(`unsupported_schema_version: got=${got} supported=[${supported.join(',')}]`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export function validateWorkpieceVersion(raw: Record<string, unknown>): Record<string, unknown> {
  // Default missing schema_version to 1 for back-compat
  if (raw.schema_version === undefined || raw.schema_version === null) {
    raw.schema_version = 1;
    return raw;
  }

  // Reject non-numeric versions
  if (typeof raw.schema_version !== 'number') {
    throw new UnsupportedSchemaVersionError(NaN, SUPPORTED_WORKPIECE_VERSIONS);
  }

  // Reject unsupported versions
  if (!(SUPPORTED_WORKPIECE_VERSIONS as readonly number[]).includes(raw.schema_version)) {
    throw new UnsupportedSchemaVersionError(raw.schema_version, SUPPORTED_WORKPIECE_VERSIONS);
  }

  return raw;
}

export function stampWorkpieceVersion<T extends Record<string, unknown>>(
  obj: T
): T & { schema_version: number } {
  return { ...obj, schema_version: CURRENT_WORKPIECE_VERSION };
}

const WorkpieceVersionSchema = z.preprocess((value) => {
  const raw = { schema_version: value } as Record<string, unknown>;
  validateWorkpieceVersion(raw);
  return raw.schema_version;
}, z.literal(CURRENT_WORKPIECE_VERSION));

export const TokenUsageSchema = z.object({
  in: z.number(),
  out: z.number(),
  cache_read: z.number().optional(),
  cache_creation: z.number().optional(),
}) satisfies z.ZodType<TokenUsage>;

export const EvalResultSchema = z.object({
  pass: z.boolean(),
  feedback: z.string(),
  score: z.number().optional(),
  action: z.enum(["retry", "escalate"]).optional(),
}) satisfies z.ZodType<EvalResult>;

export const StationRoundsSchema = z.object({
  turns: z.number(),
  tools: z.record(z.number()),
}) satisfies z.ZodType<StationRounds>;

export const StationEnvelopeSchema = z.object({
  summary: z.string(),
  content: z.string().optional(),
  data: z.record(z.unknown()).optional(),
}) satisfies z.ZodType<StationEnvelope>;

export const FailureClassSchema = z.enum([
  "envelope",
  "crash",
  "timeout",
  "guardrail",
  "provider",
  "aborted",
  "unknown",
]) satisfies z.ZodType<FailureClass>;

const StationResultBaseSchema = StationEnvelopeSchema.extend({
  status: z.enum(["done", "failed", "skipped", "escalated"]),
  started_at: z.string(),
  finished_at: z.string(),
  model: z.string(),
  tokens: TokenUsageSchema,
  cost_usd: z.number(),
  eval: EvalResultSchema.extend({
    tokens: TokenUsageSchema.optional(),
    cost_usd: z.number().optional(),
  }).optional(),
  failure_class: FailureClassSchema.optional(),
  rounds: StationRoundsSchema.optional(),
});

export const StationResultSchema: z.ZodType<StationResult> = StationResultBaseSchema.extend({
  previous_attempts: z.array(StationResultBaseSchema).optional(),
});

const StationNameKeySchema = z.string().transform((s) => StationName(s));

export const WorkpieceSchema = z.object({
  id: z.string().transform((s) => WorkpieceId(s)),
  schema_version: WorkpieceVersionSchema.optional().default(CURRENT_WORKPIECE_VERSION),
  line: z.string().transform((s) => LineName(s)),
  task: z.string(),
  input: z.record(z.unknown()),
  taskKey: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  stations: z.record(StationNameKeySchema, StationResultSchema),
  totals: z.object({
    tokens: TokenUsageSchema,
    cost_usd: z.number(),
  }).optional(),
  _retry_history: z.record(StationNameKeySchema, z.array(StationResultBaseSchema)).optional(),
  _pending_eval_feedback: z.object({
    station: z.string(),
    feedback: z.string(),
    attempt: z.number(),
  }).optional(),
}).passthrough() satisfies z.ZodType<Workpiece>;

export type ParsedWorkpiece = z.infer<typeof WorkpieceSchema>;
