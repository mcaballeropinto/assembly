import type { StationEnvelope, StationConfig, EvalResult } from "./types";

/**
 * Parse and validate a station's raw LLM response into a StationEnvelope.
 */
export function parseEnvelope(raw: string): StationEnvelope {
  const cleaned = raw.trim();

  // Strategy 1: Try parsing as-is (already clean JSON)
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Strategy 2: Extract JSON from markdown code fences (```json ... ```)
    // Handles preamble text before the fence (common with claude -p)
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through to strategy 3
      }
    }

    // Strategy 3: Find the first { and last } — extract the JSON object
    if (!parsed) {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } catch {
          // All strategies failed
        }
      }
    }

    if (!parsed) {
      throw new EnvelopeError(
        `Response is not valid JSON:\n${raw.substring(0, 200)}...`
      );
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError("Response must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // summary is required
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    throw new EnvelopeError(
      'Response must include a non-empty "summary" string field'
    );
  }

  const envelope: StationEnvelope = {
    summary: obj.summary,
  };

  // content is optional, must be string
  if (obj.content !== undefined) {
    if (typeof obj.content !== "string") {
      throw new EnvelopeError('"content" must be a string');
    }
    envelope.content = obj.content;
  }

  // data is optional, must be object
  if (obj.data !== undefined) {
    if (
      typeof obj.data !== "object" ||
      obj.data === null ||
      Array.isArray(obj.data)
    ) {
      throw new EnvelopeError('"data" must be an object');
    }
    envelope.data = obj.data as Record<string, unknown>;
  }

  return envelope;
}

/**
 * Resolve a dotted path (`data.scored_items`) against an envelope.
 * Returns { found: true, value } if the path resolves to a defined, non-null
 * value; { found: false } otherwise. Paths must start with `summary`,
 * `content`, or `data` to match StationEnvelope.
 *
 * Does NOT understand `[]` — call `expandArrayPath` first if the path may
 * iterate over an array.
 */
function resolvePath(
  envelope: StationEnvelope,
  path: string
): { found: boolean; value?: unknown } {
  const parts = path.split(".");
  const head = parts[0];
  let cursor: unknown;
  if (head === "summary") cursor = envelope.summary;
  else if (head === "content") cursor = envelope.content;
  else if (head === "data") cursor = envelope.data;
  else return { found: false };

  if (cursor === undefined || cursor === null) return { found: false };

  for (let i = 1; i < parts.length; i++) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return { found: false };
    }
    const next = (cursor as Record<string, unknown>)[parts[i]];
    if (next === undefined || next === null) return { found: false };
    cursor = next;
  }
  return { found: true, value: cursor };
}

/**
 * Expand a path containing `[]` into per-element concrete paths.
 *
 * Example:
 *   "data.scored_items[].tier"
 *   →  ["data.scored_items.0.tier", "data.scored_items.1.tier", ...]
 *
 * Plain paths (no `[]`) are returned unchanged. If an array segment doesn't
 * resolve to an array, returns the original path so the type check at that
 * point flags it. Supports nested `[]`.
 */
function expandArrayPath(envelope: StationEnvelope, path: string): string[] {
  const idx = path.indexOf("[]");
  if (idx === -1) return [path];
  const head = path.slice(0, idx); // segment before []
  const tail = path.slice(idx + 2); // segment after [] (may start with ".")
  const arr = resolveIndexedPath(envelope, head);
  if (!arr.found || !Array.isArray(arr.value)) return [path];
  const expanded: string[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const concrete = `${head}.${i}${tail}`;
    expanded.push(...expandArrayPath(envelope, concrete));
  }
  return expanded;
}

/**
 * Like resolvePath but understands numeric segments as array indices.
 */
function resolveIndexedPath(
  envelope: StationEnvelope,
  path: string
): { found: boolean; value?: unknown } {
  const parts = path.split(".");
  const head = parts[0];
  let cursor: unknown;
  if (head === "summary") cursor = envelope.summary;
  else if (head === "content") cursor = envelope.content;
  else if (head === "data") cursor = envelope.data;
  else return { found: false };

  if (cursor === undefined || cursor === null) return { found: false };

  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (Array.isArray(cursor)) {
      const n = Number(seg);
      if (!Number.isInteger(n) || n < 0 || n >= cursor.length) return { found: false };
      cursor = cursor[n];
    } else if (typeof cursor === "object" && cursor !== null) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return { found: false };
    }
    if (cursor === undefined || cursor === null) return { found: false };
  }
  return { found: true, value: cursor };
}

/**
 * Check a value's runtime type against a schema type string.
 * Supports: "string", "number", "boolean", "object", "array".
 */
function typeMatches(value: unknown, typeStr: string): boolean {
  if (typeStr === "array") return Array.isArray(value);
  if (typeStr === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === typeStr;
}

/**
 * Apply a schema spec to a single resolved value. Returns a list of violations.
 *
 * Spec accepts: type, minItems, enum, minimum, maximum.
 * Bare-string specs (e.g. `"array"`) are treated as `{ type: "array" }`.
 */
function checkValue(value: unknown, spec: unknown, path: string): string[] {
  const out: string[] = [];
  const typeStr =
    typeof spec === "string" ? spec : (spec as { type?: string })?.type;
  if (typeStr && !typeMatches(value, typeStr)) {
    const actual = Array.isArray(value) ? "array" : typeof value;
    out.push(`Field ${path}: expected ${typeStr}, got ${actual}`);
    return out; // type mismatch — skip downstream checks
  }
  const obj = (typeof spec === "object" && spec !== null ? spec : {}) as {
    minItems?: number;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
  };
  if (obj.minItems !== undefined && Array.isArray(value) && value.length < obj.minItems) {
    out.push(`Field ${path}: expected array of >= ${obj.minItems} items, got ${value.length}`);
  }
  if (obj.enum && Array.isArray(obj.enum) && !obj.enum.includes(value as never)) {
    out.push(
      `Field ${path}: expected one of [${obj.enum
        .map((v) => JSON.stringify(v))
        .join(", ")}], got ${JSON.stringify(value)}`
    );
  }
  if (typeof value === "number") {
    if (obj.minimum !== undefined && value < obj.minimum) {
      out.push(`Field ${path}: expected >= ${obj.minimum}, got ${value}`);
    }
    if (obj.maximum !== undefined && value > obj.maximum) {
      out.push(`Field ${path}: expected <= ${obj.maximum}, got ${value}`);
    }
  }
  return out;
}

/**
 * Validate an envelope against optional guardrails from AGENT.md.
 *
 * Supported frontmatter shape:
 * ```yaml
 * guardrails:
 *   output:
 *     required: [data.scored_items]       # dotted paths resolve against envelope
 *     forbidden: [data.enriched_items]         # paths that must NOT be set — catches adjacent-task drift
 *     schema:
 *       data:
 *         scored_items: array             # string → type check only (back-compat)
 *         next_step: { type: string, minItems: 1 } # or object form
 *       data.scored_items: { type: array, minItems: 1 } # dotted path also allowed
 * ```
 *
 * Returns a list of human-readable error strings. Empty list = envelope passes.
 */
export function validateGuardrails(
  envelope: StationEnvelope,
  station: StationConfig
): string[] {
  const errors: string[] = [];
  const guardrails = station.guardrails?.output;

  if (!guardrails) return errors;

  // Required paths — must resolve to a defined, non-null value.
  if (guardrails.required) {
    for (const path of guardrails.required) {
      if (path === "summary") continue; // always required by parseEnvelope
      const hit = resolvePath(envelope, path);
      if (!hit.found) {
        errors.push(`Missing required field: ${path}`);
      }
    }
  }

  // Forbidden paths — MUST NOT resolve. Use to block adjacent-task drift
  // (e.g. a score station accidentally emitting `data.enriched_items`).
  const forbidden = (guardrails as any).forbidden as string[] | undefined;
  if (forbidden) {
    for (const path of forbidden) {
      const hit = resolvePath(envelope, path);
      if (hit.found) {
        errors.push(`Forbidden field present: ${path}`);
      }
    }
  }

  // Schema type checks. Two forms:
  //   1. flat: schema.data.<key> = "array" | { type: "array", minItems: 1 }
  //   2. dotted: schema.<dotted-path> = ...
  if (guardrails.schema) {
    const entries: [string, unknown][] = [];
    const rawSchema = guardrails.schema as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawSchema)) {
      if (key === "data" && value && typeof value === "object" && !Array.isArray(value)) {
        // Flat form: expand each sub-key into `data.<sub>`.
        for (const [sub, t] of Object.entries(value as Record<string, unknown>)) {
          entries.push([`data.${sub}`, t]);
        }
      } else {
        // Dotted form — use as-is.
        entries.push([key, value]);
      }
    }

    for (const [path, spec] of entries) {
      // Expand `[]` segments to per-element concrete paths. For paths without
      // `[]`, this returns [path] unchanged.
      const concretePaths = path.includes("[]")
        ? expandArrayPath(envelope, path)
        : [path];
      for (const concrete of concretePaths) {
        const hit = concrete.includes(".") && /\.\d+(\.|$)/.test(concrete)
          ? resolveIndexedPath(envelope, concrete)
          : resolvePath(envelope, concrete);
        if (!hit.found) continue; // required-ness is enforced by `required`, not here
        const violations = checkValue(hit.value, spec, concrete);
        errors.push(...violations);
      }
    }
  }

  return errors;
}

/**
 * Build a repair prompt when the first attempt fails.
 *
 * Seed order: rawResponse (envelope-file text) → fallbackText (salvaged stream
 * text) → empty form ("no output captured"). Seed is quoted up to 2000 chars.
 */
export function buildRepairPrompt(
  rawResponse: string,
  error: string,
  fallbackText?: string
): string {
  const seed = rawResponse || fallbackText || "";
  const body = seed
    ? `Your previous response was not in the expected format. Error: ${error}\n\nHere is the text you produced:\n${seed.substring(0, 2000)}`
    : `Your previous session finished without producing the required JSON output. Error: ${error}`;
  return `${body}\n\nRespond now with ONLY valid JSON containing at minimum:\n{\n  "summary": "one-line description of what you produced"\n}\n\nOptionally include "content" (string) and/or "data" (object). Write the JSON directly — do not wrap in prose, do not use code fences, and do not call tools.`;
}

/**
 * Build a repair prompt for a guardrail (shape-violation) failure.
 *
 * Different from `buildRepairPrompt` in two ways: the JSON was valid — the
 * shape was wrong — so we don't lecture about JSON formatting, we quote the
 * schema contract instead. Also shows all violations at once so the model can
 * fix them in one pass rather than cascading retries.
 */
export function buildGuardrailRepairPrompt(
  rawEnvelope: string,
  errors: string[],
  guardrails: { required?: string[]; forbidden?: string[]; schema?: Record<string, unknown> } | undefined
): string {
  const violations = errors.map((e) => `  - ${e}`).join("\n");
  const expected: string[] = [];
  if (guardrails?.required?.length) {
    expected.push(`Required fields: ${guardrails.required.join(", ")}`);
  }
  if (guardrails?.forbidden?.length) {
    expected.push(`Forbidden fields (do NOT emit these): ${guardrails.forbidden.join(", ")}`);
  }
  if (guardrails?.schema) {
    expected.push(`Schema: ${JSON.stringify(guardrails.schema)}`);
  }
  const expectedBlock = expected.length ? `\n\nSchema contract:\n${expected.map((e) => `  - ${e}`).join("\n")}` : "";
  const quoted = rawEnvelope ? `\n\nHere is the JSON you produced:\n${rawEnvelope.substring(0, 2000)}` : "";
  return [
    `Your previous response was valid JSON but violated the station's output schema.`,
    `Violations:\n${violations}`,
    expectedBlock.trim(),
    quoted.trim(),
    `Respond now with ONLY the corrected JSON. Fix every violation listed above — do not drop fields you already produced that are not part of the violations, and do not emit forbidden fields. Write the JSON directly — no prose, no code fences, no tool calls.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Parse an eval response into an EvalResult.
 * Reuses the same JSON extraction strategies as parseEnvelope.
 */
export function parseEvalResponse(raw: string): EvalResult {
  const cleaned = raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {}
    }

    if (!parsed) {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } catch {}
      }
    }

    if (!parsed) {
      throw new EnvelopeError(
        `Eval response is not valid JSON:\n${raw.substring(0, 200)}...`
      );
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError("Eval response must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.pass !== "boolean") {
    throw new EnvelopeError('Eval response must include a boolean "pass" field');
  }

  if (typeof obj.feedback !== "string" || obj.feedback.trim() === "") {
    throw new EnvelopeError(
      'Eval response must include a non-empty "feedback" string'
    );
  }

  const result: EvalResult = {
    pass: obj.pass,
    feedback: obj.feedback,
  };

  if (typeof obj.score === "number") {
    result.score = obj.score;
  }

  if (obj.action === "retry" || obj.action === "escalate") {
    result.action = obj.action;
  }

  return result;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/**
 * Thrown when `validateGuardrails` produced errors and the repair path was
 * unable to fix them. Classified as `failure_class: "guardrail"` by the
 * orchestrator, which picks a shorter retry budget — re-running the station
 * is unlikely to help if Haiku-repair already failed.
 */
export class GuardrailError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Guardrail validation failed: ${violations.join("; ")}`);
    this.name = "GuardrailError";
    this.violations = violations;
  }
}
