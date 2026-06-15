import { z } from "zod";
import type { RetryState } from "../retry-state";
import { FailureClassSchema } from "./workpiece";

export const RetryStateSchema = z.object({
  retry_count: z.number().int().nonnegative(),
  max_retries: z.number().int().nonnegative(),
  failure_class: FailureClassSchema.optional(),
  in_backoff: z.boolean(),
  backoff_until: z.string().optional(),
  exhausted: z.boolean(),
}).strict() satisfies z.ZodType<RetryState>;
