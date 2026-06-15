import { z } from "zod";
import type { EvalConfig, StationConfig } from "../types";

const ProviderSchema = z.enum(["api", "claude-code", "claude-code-cached", "codex", "pi", "script"]);

const GuardrailOutputSchema = z.object({
  required: z.array(z.string()).optional(),
  forbidden: z.array(z.string()).optional(),
  schema: z.record(z.unknown()).optional(),
}).passthrough();

export const StationFrontmatterSchema = z.object({
  description: z.string().optional(),
  reads: z.array(z.string()).optional(),
  provider: ProviderSchema.optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  script: z.string().optional(),
  cwd: z.string().optional(),
  guardrails: z.object({
    output: GuardrailOutputSchema.optional(),
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<Partial<Omit<StationConfig, "name" | "dir" | "prompt" | "eval" | "memory" | "memoryDir">>>;

export const EvalFrontmatterSchema = z.object({
  provider: ProviderSchema.optional(),
  model: z.string().optional(),
  on_fail: z.enum(["retry", "fail", "warn"]).optional(),
  max_retries: z.number().int().nonnegative().optional(),
  script: z.string().optional(),
}).passthrough() satisfies z.ZodType<Partial<Omit<EvalConfig, "prompt">>>;

export type StationFrontmatter = z.infer<typeof StationFrontmatterSchema>;
export type EvalFrontmatter = z.infer<typeof EvalFrontmatterSchema>;
