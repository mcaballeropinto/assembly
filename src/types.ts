import { WorkpieceId, LineName, StationName } from './ids';
export { WorkpieceId, LineName, StationName };

// === The Standard Envelope ===
// Every station returns this. No exceptions.

export interface StationEnvelope {
  summary: string; // required — one-line description
  content?: string; // optional — full text output
  data?: Record<string, unknown>; // optional — structured fields
}

// === Eval Result ===
// Returned by the evaluation step when EVAL.md exists.

export interface EvalResult {
  pass: boolean;
  feedback: string;
  score?: number;
  action?: "retry" | "escalate";
}

// === On Complete Triggers ===
// Defines downstream line triggers when a line's workpiece completes.

export interface OnCompleteTarget {
  target?: LineName;                   // target line name (directory name under lines/)
  /**
   * Dot-notation workpiece path that resolves to the target line name at
   * trigger time (e.g. "input.target_line"). Wins over `target` when set.
   * Lets one upstream line route to different downstream lines on a
   * per-task basis (e.g. a shared scraper line routing back to one of several
   * downstream enrichment lines based on the source category).
   */
  target_path?: string;
  pass?: Record<string, string>;       // workpiece field paths -> input keys
  condition?: string;                  // optional: only trigger if this workpiece field is truthy
  /**
   * When set, emit ONE downstream task per element of the resolved array.
   *
   *   over: dot-notation path on the workpiece (e.g. "validate.data.qualifying_items")
   *   as:   downstream input key. Each task receives `input[as] = [element]`
   *         (singleton array, so downstream contracts that expect an array still work).
   *
   * `pass` mappings are also applied to every emitted task (resolved from the
   * source workpiece, not from the element). Use this to forward shared
   * context like a run id alongside the per-element payload.
   */
  fanout?: {
    over: string;
    as: string;
  };
}

// === Cost Tracking ===

export interface TokenUsage {
  in: number;
  out: number;
  cache_read?: number;      // cache_read_input_tokens from CLI
  cache_creation?: number;  // cache_creation_input_tokens from CLI
}

export interface CostBreakdown {
  tokens: TokenUsage;
  cost_usd: number; // total cost for this unit
}

// === Workpiece ===
// The thing being built. Accumulates station results.

export type FailureClass =
  | "envelope"    // EnvelopeError even after in-station repair
  | "crash"       // worker process exited non-zero / killed
  | "timeout"     // station-level idle/wall-clock timeout fired
  | "guardrail"   // envelope parsed but failed guardrail validation
  | "provider"    // upstream API error (rate limit, auth, model down)
  | "aborted"     // worker terminated by a graceful daemon shutdown
  | "unknown";    // pre-classification default (legacy workpieces)

// Re-export RetryState from retry-state.ts for convenience
export type { RetryState } from "./retry-state";

export interface RetryPolicy {
  maxRetries: number;
  backoff: number[]; // seconds between retries, indexed by attempt number
}

export type RetryPolicyMap = Record<FailureClass, RetryPolicy>;

export interface StationRounds {
  turns: number;
  tools: Record<string, number>;
}

export interface StationResult extends StationEnvelope {
  status: "done" | "failed" | "skipped" | "escalated";
  started_at: string;
  finished_at: string;
  model: string;
  tokens: TokenUsage;
  cost_usd: number;
  eval?: EvalResult & { tokens?: TokenUsage; cost_usd?: number };
  failure_class?: FailureClass; // set when status === "failed"
  rounds?: StationRounds;
  /**
   * Prior failed attempts at this station, chronological (earliest first).
   * Empty/undefined when the first attempt succeeded. Each entry is a full
   * StationResult but its own `previous_attempts` field is not populated
   * (flat — no recursion).
   */
  previous_attempts?: Omit<StationResult, "previous_attempts">[];
}

export interface Workpiece {
  id: WorkpieceId;
  schema_version?: number;
  line: LineName;
  task: string;
  input: Record<string, unknown>;
  /**
   * Optional user-assigned key that names this task for dependency
   * references. When set at enqueue time, the workpiece is stored as
   * `<taskKey>.json` so other tasks can reference it via `dependsOn`
   * without parsing the file.
   */
  taskKey?: string;
  /**
   * Task keys (matching another workpiece's `taskKey` or its base filename
   * without `.json`) that must appear in `queues/done/` before this
   * workpiece is eligible to be claimed from a station inbox.
   */
  dependsOn?: string[];
  stations: Record<StationName, StationResult>;
  totals?: {
    tokens: TokenUsage;
    cost_usd: number;
  };
  /** Orchestrator scratch: accumulated prior attempts awaiting consumption by writeStation. */
  _retry_history?: Record<StationName, Omit<StationResult, "previous_attempts">[]>;
  /**
   * Runner scratch: eval feedback from the prior attempt of a script station,
   * written into the temp workpiece the next attempt reads. Scripts use this
   * to thread test output / eval critique into their inner agent prompt.
   * Cleared once the station emits its final envelope.
   */
  _pending_eval_feedback?: {
    station: StationName;
    feedback: string;
    attempt: number;
  };
}

// === Provider Types ===

export type Provider = "api" | "claude-code" | "claude-code-cached" | "codex" | "pi" | "script";

/**
 * Abstract model tiers. Stations declare a tier (or a concrete model id) in
 * `model:`; each provider maps the tier to its own concrete model at dispatch
 * time (see resolveModelForProvider in llm.ts). This keeps station configs
 * provider-agnostic — the same station runs on claude-code or codex without
 * hardcoding `sonnet` / `gpt-5.5`.
 *   - "cheap"     → the provider's everyday workhorse model
 *   - "reasoning" → the provider's strongest model
 */
export type ModelTier = "cheap" | "reasoning";

// === Station Config (from AGENT.md frontmatter and line.yaml overrides) ===

export interface StationConfig {
  name: StationName; // derived from folder name
  dir: string; // station directory path
  description?: string; // station description; line.yaml overrides AGENT.md frontmatter
  reads?: string[]; // what this station needs
  provider?: Provider; // "claude-code" | "claude-code-cached" | "codex" | "script"
  model?: string; // model tier ("cheap" | "reasoning") or a concrete model id
  tools?: string[]; // tools this agent can use (for claude-code/pi)
  script?: string; // script filename for script provider (relative to station dir)
  /**
   * Override the cwd the provider runs in. Default is a per-task scratch dir
   * under /tmp/assembly-scratch-* — safe for stations that produce work from
   * scratch. Stations that need to *read* a known codebase (e.g. assembly-dev's
   * `plan`) should pin cwd to the repo so cwd-relative tools like Glob find
   * the right files. Absolute path only.
   */
  cwd?: string;
  guardrails?: {
    output?: {
      /** Dotted paths that must resolve to a defined, non-null value. */
      required?: string[];
      /** Dotted paths that must NOT be set — catches adjacent-task drift. */
      forbidden?: string[];
      /**
       * Type / value checks per path. Two equivalent forms for the path:
       *   flat:   { data: { scored_items: "array" } }
       *   dotted: { "data.scored_items": { type: "array", minItems: 1 } }
       *
       * Path syntax also supports `[]` to validate every element of an array,
       * e.g. `"data.scored_items[].tier": { enum: ["a","b","c"] }`.
       *
       * Spec object accepts:
       *   - type: "string" | "number" | "boolean" | "object" | "array"
       *   - minItems: array length lower bound
       *   - enum: list of allowed values (exact match)
       *   - minimum / maximum: numeric range (inclusive)
       */
      schema?: Record<string, unknown>;
    };
  };
  // The prompt — body of the AGENT.md
  prompt: string;
  // Optional eval config — loaded from EVAL.md
  eval?: EvalConfig;
  // Persistent memory — loaded from memory/MEMORY.md
  memory?: string;
  memoryDir: string; // absolute path to memory/ directory
}

// === Eval Config (from EVAL.md frontmatter) ===

export interface EvalConfig {
  provider?: Provider; // override provider for eval call ("script" runs a binary, not an LLM)
  model?: string; // override model for eval call
  on_fail?: "retry" | "fail" | "warn"; // default: "retry"
  max_retries?: number; // default: 1
  prompt: string; // body of the EVAL.md (ignored when provider === "script")
  script?: string; // path (relative to station dir) to the eval script when provider === "script"
}

// === Line Config (from line.yaml) ===

export type SequenceStep =
  | string // simple station name
  | { parallel: string[] } // parallel execution
  | {
      gate: {
        check: string;
        if_true: string;
        if_false: string;
      };
    }
  | {
      loop: {
        stations: string[];
        until: string;
        max: number;
      };
    }
  | { station: SequenceStationConfig };

export interface SequenceStationConfig {
  name: string;
  description?: string;
  timeout?: number;
  max_wall_clock?: number;
  flush_grace?: number;
  heartbeat?: HeartbeatConfig;
  claude_env?: Record<string, string>;
  repair?: RepairConfig;
}

export interface HeartbeatConfig {
  interval_ms?: number;
  emit_when_silent?: boolean;
}

export interface RepairConfig {
  enabled?: boolean; // default true — direct Anthropic API repair via Haiku
  model?: string;    // override repair model (default: claude-haiku-4-5-20251001)
}

export interface LineConfig {
  name: LineName;
  description?: string;
  sequence: SequenceStep[];
  concurrency?: number; // max workers per station (default: unlimited)
  timeout?: number; // seconds of idle (no output) before SIGTERM — 0 or omitted = unlimited
  max_wall_clock?: number; // seconds — hard ceiling regardless of activity; omit = no cap
  flush_grace?: number; // seconds — SIGTERM-to-SIGKILL window (default 30)
  heartbeat?: HeartbeatConfig;
  defaults?: {
    provider?: Provider;
    model?: string;
    max_tokens?: number;
    fallback?: string[];
    claude_env?: Record<string, string>;
    repair?: RepairConfig;
  };
  context?: "full" | "summary" | string;
  on_complete?: OnCompleteTarget[];
  on_success?: { script: string };
  on_failure?: { script: string };
  retry_policy?: Partial<RetryPolicyMap>;
}

// === LLM Provider ===

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  tokens: TokenUsage;
  model: string;
  cost_usd?: number;
}

export interface ProgressEvent {
  ts: string;
  phase: "prompt" | "llm" | "eval" | "repair" | "script";
  status: "started" | "running" | "done" | "failed";
  detail?: string;
  tool?: string;
  tool_input?: string;
  tokens?: { in: number; out: number };
  cost_usd?: number;
  turns?: number;
  elapsed_s?: number;
}

export type ProgressCallback = (event: {
  detail: string;
  tool?: string;
  tool_input?: string;
  tokens?: { in: number; out: number };
  cost_usd?: number;
  turns?: number;
}) => void;

// Re-export task event types for consumers (section-worker, llm, dashboard)
export type { TaskEvent, TaskEventKind, StationMeta, TaskEventsPage } from "./task-events";
export type TaskEventInput = Omit<import("./task-events").TaskEvent, "ts" | "seq" | "station">;
export type OnEventCallback = (event: TaskEventInput) => void;

export interface LLMResult extends LLMResponse {
  getLastActivityMs: () => number;
  promptBytes?: number;
  // Concatenated assistant text blocks captured from the stream, capped at 256 KB
  // (oldest trimmed). Used as a salvage source when the envelope file was not
  // written. See src/section-worker.ts for the fallback parse.
  fallbackContent?: string;
  envelopeFileError?: {
    path: string;
    message: string;
    bytes: number;
    preview: string;
  };
}

// === Log Events ===

export type LogEvent =
  | {
      event: "run_start";
      line: string;
      task: string;
      ts: string;
    }
  | {
      event: "station_start";
      station: string;
      model: string;
      ts: string;
    }
  | {
      event: "station_end";
      station: string;
      status: string;
      tokens: TokenUsage;
      ts: string;
    }
  | {
      event: "run_end";
      status: string;
      total_tokens: { in: number; out: number };
      duration: string;
      ts: string;
    }
  | {
      event: "trigger_fired";
      source: string;
      target: string;
      workpiece: string;
      input_keys: string[];
      ts: string;
    }
  | {
      event: "trigger_skipped";
      source: string;
      target: string;
      reason: string;
      ts: string;
    };

// Re-export branded types for convenience
export type { TaskFileName } from './ids';
