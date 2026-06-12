import { existsSync, readFileSync } from "fs";
import YAML from "yaml";
import { GLOBAL_CONFIG } from "../paths";

/**
 * Improver configuration, read from the `improver:` section of
 * ~/.assembly/config.yaml. Everything has a safe default; the feature is
 * opt-in via `enabled: true`.
 *
 *   improver:
 *     enabled: true
 *     model: sonnet                 # assessment model (direct Anthropic API)
 *     dev_line: assembly-dev        # line that receives improvement tasks
 *     exclude_lines: [hello-world]  # never assess completions of these lines
 *     max_open_proposals: 3         # cap on unresolved improver tasks in dev_line
 *     max_assessments_per_sweep: 10 # LLM-call budget per sweep window
 *     sweep_interval_minutes: 60    # periodic catch-up sweep
 *     requeue_on_fix: true          # requeue source tasks when a fix deploys
 *     max_proposals_per_issue: 2    # lifetime proposals per issue_key
 *     max_dev_task_retries: 1       # bounded repair attempts for failed dev tasks
 */
export interface ImproverConfig {
  enabled: boolean;
  model: string;
  devLine: string;
  excludeLines: string[];
  maxOpenProposals: number;
  /** Max open proposals per source line — bounds slug-drift loops. */
  maxOpenPerLine: number;
  maxAssessmentsPerSweep: number;
  sweepIntervalMs: number;
  requeueOnFix: boolean;
  /**
   * Allow re-running tasks that SUCCEEDED (done bucket) after a fix deploys.
   * Off by default: re-runs can duplicate external side effects (CRM writes,
   * outreach). When on, the assessor's per-task requeue_after_fix flag still
   * has to agree. Failed (error bucket) tasks always requeue.
   */
  requeueDoneTasks: boolean;
  maxProposalsPerIssue: number;
  maxDevTaskRetries: number;
  /**
   * Where improvement tasks land on the dev line: "inbox" auto-runs them
   * (full self-improvement loop); "held" requires a manual release — the
   * human-approval gate for operators whose lines ingest untrusted content.
   */
  proposalMode: "inbox" | "held";
}

export const IMPROVER_DEFAULTS: ImproverConfig = {
  enabled: false,
  model: "sonnet",
  devLine: "assembly-dev",
  excludeLines: [],
  maxOpenProposals: 3,
  maxOpenPerLine: 1,
  maxAssessmentsPerSweep: 10,
  sweepIntervalMs: 60 * 60 * 1000,
  requeueOnFix: true,
  requeueDoneTasks: false,
  maxProposalsPerIssue: 2,
  maxDevTaskRetries: 1,
  proposalMode: "inbox",
};

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asPosInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

export function loadImproverConfig(configPath: string = GLOBAL_CONFIG): ImproverConfig {
  const cfg = { ...IMPROVER_DEFAULTS, excludeLines: [...IMPROVER_DEFAULTS.excludeLines] };
  if (!existsSync(configPath)) return cfg;

  let section: Record<string, unknown> | null = null;
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf-8"));
    if (parsed && typeof parsed.improver === "object" && parsed.improver !== null) {
      section = parsed.improver as Record<string, unknown>;
    }
  } catch {
    // Malformed config.yaml — same tolerance as lineSearchDirsWithLabels.
    return cfg;
  }
  if (!section) return cfg;

  cfg.enabled = asBool(section.enabled, cfg.enabled);
  cfg.model = asString(section.model, cfg.model);
  cfg.devLine = asString(section.dev_line, cfg.devLine);
  if (Array.isArray(section.exclude_lines)) {
    cfg.excludeLines = section.exclude_lines.filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0
    );
  }
  cfg.maxOpenProposals = asPosInt(section.max_open_proposals, cfg.maxOpenProposals);
  cfg.maxOpenPerLine = asPosInt(section.max_open_per_line, cfg.maxOpenPerLine);
  cfg.maxAssessmentsPerSweep = asPosInt(
    section.max_assessments_per_sweep,
    cfg.maxAssessmentsPerSweep
  );
  const sweepMin = asPosInt(section.sweep_interval_minutes, cfg.sweepIntervalMs / 60_000);
  cfg.sweepIntervalMs = sweepMin * 60_000;
  cfg.requeueOnFix = asBool(section.requeue_on_fix, cfg.requeueOnFix);
  cfg.requeueDoneTasks = asBool(section.requeue_done_tasks, cfg.requeueDoneTasks);
  cfg.maxProposalsPerIssue = asPosInt(section.max_proposals_per_issue, cfg.maxProposalsPerIssue);
  cfg.maxDevTaskRetries = asPosInt(section.max_dev_task_retries, cfg.maxDevTaskRetries);
  if (section.proposal_mode === "held" || section.proposal_mode === "inbox") {
    cfg.proposalMode = section.proposal_mode;
  }
  return cfg;
}

/**
 * Lines the improver must never propose improvements for, regardless of
 * config. The dev line would recurse on itself.
 */
export function isHardExcluded(lineName: string, cfg: ImproverConfig): boolean {
  return lineName === cfg.devLine || cfg.excludeLines.includes(lineName);
}
