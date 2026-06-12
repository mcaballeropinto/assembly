import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { ASSEMBLY_HOME } from "../paths";

/**
 * Durable improver state. Two append-only JSONL registries under
 * ~/.assembly/improver/:
 *
 *   assessed.jsonl  — every line-completion the improver has looked at, so
 *                     restarts and hourly sweeps never re-assess (or re-bill)
 *                     the same workpiece. First-ever boot writes a `bootstrap`
 *                     baseline covering all pre-existing done/error files.
 *
 *   proposals.jsonl — event log of improvement proposals: proposed →
 *                     (recurrence)* → resolved. Open proposals and per-issue
 *                     lifetime counts are folds over this log.
 */

export type AssessVerdictKind =
  | "bootstrap" // pre-existing at first boot; never assessed
  | "proposed" // assessment produced a queued improvement task
  | "no_action" // assessed; no improvement warranted
  | "duplicate" // matches an open proposal; recorded as recurrence
  | "exhausted" // issue hit its lifetime proposal cap
  | "cap" // open-proposal cap hit; dropped
  | "dev_completion" // dev-line completion consumed for proposal resolution
  | "error"; // permanently unprocessable (e.g. unparseable JSON)

export interface AssessedRecord {
  key: string; // `${linePath}:${bucket}:${fileName}` or `baseline::${linePath}`
  wp_id: string | null;
  line: string;
  bucket: "done" | "error" | "review";
  file_name: string;
  verdict: AssessVerdictKind;
  issue_key?: string;
  at: string;
}

export interface RequeueItem {
  line_path: string;
  line: string;
  bucket: "done" | "error";
  file_name: string;
  wp_id: string | null;
}

export type ProposalEvent =
  | {
      type: "proposed";
      proposal_id: string;
      issue_key: string;
      source_line: string;
      source_line_path: string;
      issue_slug: string;
      target_station: string | null;
      title: string;
      dev_task_key: string;
      dev_task_file: string;
      requeue: RequeueItem[];
      at: string;
    }
  | {
      type: "recurrence";
      issue_key: string;
      item: RequeueItem;
      /** Attach this item to the open proposal's requeue list (default true). */
      wants_requeue?: boolean;
      at: string;
    }
  | {
      type: "dev_retry";
      proposal_id: string;
      issue_key: string;
      previous_dev_task_key: string;
      dev_task_key: string;
      dev_task_file: string;
      dev_wp_id?: string | null;
      reason: string;
      at: string;
    }
  | {
      type: "resolved";
      proposal_id: string;
      issue_key: string;
      outcome: "fixed" | "fix_failed" | "no_op" | "lost" | "escalated";
      dev_wp_id?: string | null;
      requeued?: number;
      at: string;
    }
  | {
      /** One-shot Discord-notice marker, used to dedupe repeat alerts. */
      type: "notice";
      kind: "exhausted" | "cap";
      issue_key: string;
      at: string;
    };

export interface OpenProposal {
  proposal_id: string;
  issue_key: string;
  source_line: string;
  source_line_path: string;
  issue_slug: string;
  target_station: string | null;
  title: string;
  dev_task_key: string;
  dev_task_file: string;
  dev_retry_count: number;
  last_dev_wp_id?: string | null;
  requeue: RequeueItem[];
  at: string;
}

export function assessedKey(
  linePath: string,
  bucket: "done" | "error" | "review",
  fileName: string
): string {
  return `${linePath}:${bucket}:${fileName}`;
}

function baselineKey(linePath: string): string {
  return `baseline::${linePath}`;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Tolerate a torn trailing line from a crashed appender.
    }
  }
  return out;
}

export class ImproverState {
  readonly dir: string;
  private assessed = new Set<string>();
  private events: ProposalEvent[] = [];

  private constructor(dir: string, assessed: Set<string>, events: ProposalEvent[]) {
    this.dir = dir;
    this.assessed = assessed;
    this.events = events;
  }

  static defaultDir(): string {
    return resolve(ASSEMBLY_HOME, "improver");
  }

  static load(dir: string = ImproverState.defaultDir()): ImproverState {
    mkdirSync(dir, { recursive: true });
    const assessed = new Set<string>();
    for (const rec of readJsonl<AssessedRecord>(resolve(dir, "assessed.jsonl"))) {
      if (rec.key) assessed.add(rec.key);
    }
    const events = readJsonl<ProposalEvent>(resolve(dir, "proposals.jsonl"));
    return new ImproverState(dir, assessed, events);
  }

  private assessedPath(): string {
    return resolve(this.dir, "assessed.jsonl");
  }

  private proposalsPath(): string {
    return resolve(this.dir, "proposals.jsonl");
  }

  hasAssessed(key: string): boolean {
    return this.assessed.has(key);
  }

  markAssessed(record: AssessedRecord): void {
    if (this.assessed.has(record.key)) return;
    this.assessed.add(record.key);
    try {
      appendFileSync(this.assessedPath(), JSON.stringify(record) + "\n");
    } catch {
      // In-memory set is authoritative within this process; next boot's
      // sweep re-assesses anything that failed to persist.
    }
  }

  /**
   * Per-line baseline marker. A line is baselined exactly once — the first
   * time the watcher ever sees it — so its pre-existing history is never
   * mass-assessed, including for lines added long after the first boot.
   * The marker is written AFTER the line's history walk, so a crash
   * mid-baseline re-walks (idempotent) rather than leaking history.
   */
  isLineBaselined(linePath: string): boolean {
    return this.assessed.has(baselineKey(linePath));
  }

  markLineBaselined(linePath: string, lineName: string): void {
    this.markAssessed({
      key: baselineKey(linePath),
      wp_id: null,
      line: lineName,
      bucket: "done",
      file_name: "",
      verdict: "bootstrap",
      at: new Date().toISOString(),
    });
  }

  /** Has a one-shot notice already been posted for this issue? */
  hasNotice(kind: "exhausted" | "cap", issueKey: string): boolean {
    return this.events.some((e) => e.type === "notice" && e.kind === kind && e.issue_key === issueKey);
  }

  appendEvent(event: ProposalEvent): void {
    this.events.push(event);
    try {
      appendFileSync(this.proposalsPath(), JSON.stringify(event) + "\n");
    } catch {}
  }

  /** Fold the event log into the set of currently open proposals. */
  openProposals(): OpenProposal[] {
    const open = new Map<string, OpenProposal>();
    for (const ev of this.events) {
      if (ev.type === "proposed") {
        open.set(ev.proposal_id, {
          proposal_id: ev.proposal_id,
          issue_key: ev.issue_key,
          source_line: ev.source_line,
          source_line_path: ev.source_line_path,
          issue_slug: ev.issue_slug,
          target_station: ev.target_station,
          title: ev.title,
          dev_task_key: ev.dev_task_key,
          dev_task_file: ev.dev_task_file,
          dev_retry_count: 0,
          requeue: [...ev.requeue],
          at: ev.at,
        });
      } else if (ev.type === "resolved") {
        open.delete(ev.proposal_id);
      } else if (ev.type === "recurrence") {
        if (ev.wants_requeue === false) continue;
        // Attach the recurrence's requeue item to whichever proposal for
        // this issue is currently open (at most one by construction).
        for (const p of open.values()) {
          if (p.issue_key !== ev.issue_key) continue;
          const dup = p.requeue.some(
            (r) => r.file_name === ev.item.file_name && r.bucket === ev.item.bucket && r.line_path === ev.item.line_path
          );
          if (!dup) p.requeue.push(ev.item);
          break;
        }
      } else if (ev.type === "dev_retry") {
        const p = open.get(ev.proposal_id);
        if (!p) continue;
        p.dev_task_key = ev.dev_task_key;
        p.dev_task_file = ev.dev_task_file;
        p.dev_retry_count++;
        p.last_dev_wp_id = ev.dev_wp_id;
      }
    }
    return [...open.values()];
  }

  findOpenByIssue(issueKey: string): OpenProposal | null {
    return this.openProposals().find((p) => p.issue_key === issueKey) ?? null;
  }

  findOpenByProposalId(proposalId: string): OpenProposal | null {
    return this.openProposals().find((p) => p.proposal_id === proposalId) ?? null;
  }

  /** Lifetime count of proposals ever filed for an issue_key. */
  proposalCountForIssue(issueKey: string): number {
    return this.events.filter((e) => e.type === "proposed" && e.issue_key === issueKey).length;
  }

  /** Recent issue slugs for a source line, newest first, deduped. */
  recentSlugsForLine(lineName: string, limit = 10): string[] {
    const slugs: string[] = [];
    for (let i = this.events.length - 1; i >= 0 && slugs.length < limit; i--) {
      const ev = this.events[i];
      if (ev.type === "proposed" && ev.source_line === lineName && !slugs.includes(ev.issue_slug)) {
        slugs.push(ev.issue_slug);
      }
    }
    return slugs;
  }
}
