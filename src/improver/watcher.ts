import { appendFileSync, existsSync, readFileSync } from "fs";
import { basename, relative, resolve } from "path";
import { listQueue, watchFolder, type WatchFolderStop } from "../queue";
import { loadImproverConfig, isHardExcluded, type ImproverConfig } from "./config";
import { ImproverState, assessedKey, type RequeueItem } from "./state";
import {
  assessWorkpiece,
  guardedDownstreamSuccessVerdict,
  normalizeSlug,
  VerdictParseError,
  type AssessmentContext,
  type AssessmentVerdict,
} from "./assess";
import { enqueueDevTask, devTaskStillPresent, devTaskTerminalBucket, requeueSource } from "./devline";
import { buildDiagnosisReportMessage, sendDiscord, type DiagnosisReportAction } from "./discord";
import { diagnoseFailure, formatDiagnosisReport, type FailureDiagnosis } from "./diagnosis";

/**
 * The improver watcher — Assembly's self-improvement loop.
 *
 * Runs inside the daemon alongside the per-line orchestrators. Watches every
 * line's done/ and error/ queues; when a task finishes it assesses the
 * outcome (cheap direct-API LLM call), and when a concrete high-confidence
 * improvement exists it queues a work order on the dev line (assembly-dev).
 * When that improvement task completes, the previously affected source tasks
 * are requeued on their lines. An hourly sweep catches anything that
 * finished while the daemon (or this watcher) was down.
 *
 * Safety properties:
 *   - Dev line and excluded lines are never assessed (no recursion).
 *   - Every completion is assessed at most once, durably (assessed.jsonl).
 *   - Each line is baselined the first time the watcher ever sees it —
 *     pre-existing history is never mass-assessed, even for lines added
 *     long after the first boot.
 *   - Open improvement tasks are capped globally and per source line; each
 *     issue_key has a lifetime proposal cap; a per-sweep-window LLM budget
 *     caps assessment cost.
 *   - Assessment runs tool-free on the direct API — it cannot touch the
 *     filesystem — and its output passes a sanitizer plus a deny-list
 *     tripwire before reaching the dev line.
 *   - Successful (done-bucket) tasks are only ever re-run when
 *     requeue_done_tasks is enabled AND the assessor judged a re-run safe.
 */

export interface ImproverLineRef {
  linePath: string;
  lineName: string;
}

export interface ImproverWatcherOptions {
  getLines: () => ImproverLineRef[];
  /** Test override — merged over the config file values. */
  config?: Partial<ImproverConfig>;
  configPath?: string;
  stateDir?: string;
  /** Test injection — replaces the real LLM assessment call. */
  assessFn?: (ctx: AssessmentContext) => Promise<AssessmentVerdict>;
  /** Test injection — replaces the real Discord send. */
  notifyFn?: (message: string) => Promise<boolean>;
  /** Test override — age before an unresolved proposal is reaped (ms). */
  staleProposalMs?: number;
}

export interface ImproverWatcherHandle {
  enabled: boolean;
  stop: () => void;
  syncLines: () => void;
  /** Run one catch-up sweep now (also used by tests). */
  sweep: () => Promise<void>;
  /** Drain the in-process assessment queue (test synchronization point). */
  settle: () => Promise<void>;
}

interface Candidate {
  linePath: string;
  lineName: string;
  bucket: "done" | "error" | "review";
  filePath: string;
}

const DEFAULT_STALE_PROPOSAL_MS = 24 * 60 * 60 * 1000;

export function startImproverWatcher(opts: ImproverWatcherOptions): ImproverWatcherHandle {
  const config: ImproverConfig = { ...loadImproverConfig(opts.configPath), ...(opts.config ?? {}) };

  if (!config.enabled) {
    return {
      enabled: false,
      stop: () => {},
      syncLines: () => {},
      sweep: async () => {},
      settle: async () => {},
    };
  }

  const staleProposalMs = opts.staleProposalMs ?? DEFAULT_STALE_PROPOSAL_MS;
  const state = ImproverState.load(opts.stateDir);
  const notify = opts.notifyFn ?? sendDiscord;
  const assess =
    opts.assessFn ?? ((ctx: AssessmentContext) => assessWorkpiece(ctx, { model: config.model }));

  const activityPath = resolve(state.dir, "activity.jsonl");
  const log = (event: string, detail: Record<string, unknown> = {}) => {
    const entry = { ts: new Date().toISOString(), event, ...detail };
    console.log(`[improver] ${event}`, JSON.stringify(detail));
    try {
      appendFileSync(activityPath, JSON.stringify(entry) + "\n");
    } catch {}
  };

  // ── Watcher registry ────────────────────────────────────────────────
  const watched = new Map<string, { lineName: string; stops: WatchFolderStop[] }>();
  let stopped = false;

  // ── Serial assessment queue ─────────────────────────────────────────
  const queue: Candidate[] = [];
  const queuedKeys = new Set<string>();
  let draining: Promise<void> | null = null;
  let assessmentsThisWindow = 0;
  let budgetExhaustedLogged = false;
  let devLineMissingLogged = false;
  let authFailureNotified = false;
  // In-memory verdict-parse failure counter per assessedKey: a couple of
  // retries are useful (the model may emit clean JSON next time), but a file
  // that consistently produces unparseable/forbidden verdicts must not burn
  // the budget every sweep forever.
  const parseFailures = new Map<string, number>();
  const MAX_PARSE_FAILURES = 2;

  const devLineRef = (): ImproverLineRef | null =>
    opts.getLines().find((l) => l.lineName === config.devLine) ?? null;

  function enqueueCandidate(
    lineName: string,
    linePath: string,
    bucket: "done" | "error" | "review",
    filePath: string
  ): void {
    if (stopped) return;
    const key = assessedKey(linePath, bucket, basename(filePath));
    if (state.hasAssessed(key) || queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ linePath, lineName, bucket, filePath });
    kickQueue();
  }

  function kickQueue(): void {
    if (draining) return;
    draining = (async () => {
      try {
        while (queue.length > 0 && !stopped) {
          const item = queue.shift()!;
          queuedKeys.delete(assessedKey(item.linePath, item.bucket, basename(item.filePath)));
          try {
            await processCandidate(item);
          } catch (err) {
            log("candidate_error", {
              line: item.lineName,
              file: basename(item.filePath),
              error: (err as Error).message,
            });
          }
        }
      } finally {
        draining = null;
        // New candidates may have arrived while we were finishing up.
        if (queue.length > 0 && !stopped) kickQueue();
      }
    })();
  }

  function isAuthError(err: Error): boolean {
    return /api[_ -]?key|401|authentication|unauthorized|x-api-key/i.test(err.message);
  }

  async function processCandidate(c: Candidate): Promise<void> {
    const fileName = basename(c.filePath);
    const key = assessedKey(c.linePath, c.bucket, fileName);
    if (state.hasAssessed(key)) return;
    if (!existsSync(c.filePath)) return;

    if (c.lineName === config.devLine) {
      if (c.bucket === "review") {
        await handleDevEscalation(c, key, fileName);
      } else {
        const handled = await handleDevCompletion(c, key, fileName);
        if (!handled && c.bucket === "error") {
          await handleOrdinaryFailure(c, key, fileName);
        }
      }
      return;
    }

    // LLM budget applies only to real assessments, never to dev-completion
    // bookkeeping. Skipped candidates stay unregistered so the next sweep
    // window picks them up.
    if (assessmentsThisWindow >= config.maxAssessmentsPerSweep) {
      if (!budgetExhaustedLogged) {
        budgetExhaustedLogged = true;
        log("assessment_budget_exhausted", { window_max: config.maxAssessmentsPerSweep });
      }
      return;
    }

    const mark = (
      verdictKind: Parameters<typeof state.markAssessed>[0]["verdict"],
      wpId: string | null,
      issueKey?: string
    ) =>
      state.markAssessed({
        key,
        wp_id: wpId,
        line: c.lineName,
        bucket: c.bucket,
        file_name: fileName,
        verdict: verdictKind,
        issue_key: issueKey,
        at: new Date().toISOString(),
      });

    let wp: Record<string, unknown>;
    try {
      wp = JSON.parse(readFileSync(c.filePath, "utf-8"));
    } catch {
      mark("error", null);
      log("unparseable_workpiece", { line: c.lineName, file: fileName });
      return;
    }
    const wpId = typeof wp.id === "string" ? wp.id : null;

    const deterministicDiagnosis =
      c.bucket === "error"
        ? diagnoseFailure({
            lineName: c.lineName,
            linePath: c.linePath,
            fileName,
            filePath: c.filePath,
            workpiece: wp,
          })
        : null;
    if (deterministicDiagnosis?.confidence === "high") {
      await handleDiagnosis(c, key, fileName, wpId, deterministicDiagnosis);
      return;
    }

    const ctx: AssessmentContext = {
      workpiece: wp,
      lineName: c.lineName,
      linePath: c.linePath,
      bucket: c.bucket as "done" | "error",
      recentSlugs: state.recentSlugsForLine(c.lineName),
      openTitles: state.openProposals().map((p) => `[${p.issue_key}] ${p.title}`),
    };

    const deterministicVerdict = guardedDownstreamSuccessVerdict(ctx);
    if (deterministicVerdict) {
      mark("no_action", wpId);
      log("no_action", {
        line: c.lineName,
        wp: wpId,
        outcome: deterministicVerdict.outcome,
        confidence: deterministicVerdict.confidence,
        reasoning: deterministicVerdict.reasoning.slice(0, 200),
      });
      return;
    }

    assessmentsThisWindow++;
    let verdict: AssessmentVerdict;
    try {
      verdict = await assess(ctx);
    } catch (err) {
      const e = err as Error;
      if (isAuthError(e)) {
        // Permanent-looking config failure: alert once and stop burning the
        // window. Candidates stay unregistered; sweeps retry once fixed.
        assessmentsThisWindow = config.maxAssessmentsPerSweep;
        log("assessment_auth_error", { error: e.message });
        if (!authFailureNotified) {
          authFailureNotified = true;
          await notify(
            `🚨 **improver** — assessments are failing with an auth error (check ASSEMBLY_ANTHROPIC_API_KEY in the daemon's env). Pausing until it works.\n\`${e.message.slice(0, 200)}\``
          );
        }
        return;
      }
      if (e instanceof VerdictParseError) {
        const n = (parseFailures.get(key) ?? 0) + 1;
        parseFailures.set(key, n);
        if (n >= MAX_PARSE_FAILURES) {
          parseFailures.delete(key);
          mark("error", wpId);
          log("verdict_rejected", { line: c.lineName, file: fileName, error: e.message, attempts: n });
          return;
        }
      }
      // Transient (API blip / first parse failure): leave unregistered so
      // the next sweep retries; the per-window budget bounds the cost.
      log("assessment_failed", { line: c.lineName, file: fileName, error: e.message });
      return;
    }
    parseFailures.delete(key);

    if (!verdict.should_improve || verdict.confidence !== "high") {
      await postDiagnosisReportOnce(c, fileName, wp, verdict, {
        text:
          verdict.confidence === "low" || verdict.confidence === "medium"
            ? "deferred due to low confidence/manual-only diagnosis; no automatic action taken"
            : "no automatic action taken: should_improve=false",
      });
      mark("no_action", wpId);
      log("no_action", {
        line: c.lineName,
        wp: wpId,
        outcome: verdict.outcome,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning.slice(0, 200),
      });
      return;
    }

    const issueKey = `${c.lineName}/${verdict.target_station ?? "line"}/${verdict.issue_slug}`;
    // Failed source tasks always requeue after a fix (that's the point of
    // the loop). Successful tasks are re-run only when the operator enabled
    // requeue_done_tasks AND the assessor judged a re-run safe — re-runs can
    // duplicate external side effects.
    const wantsRequeue =
      c.bucket === "error" ? true : config.requeueDoneTasks && verdict.requeue_after_fix;
    const item: RequeueItem = {
      line_path: c.linePath,
      line: c.lineName,
      bucket: c.bucket as "done" | "error",
      file_name: fileName,
      wp_id: wpId,
    };

    const openForIssue = state.findOpenByIssue(issueKey);
    if (openForIssue) {
      await postDiagnosisReportOnce(c, fileName, wp, verdict, {
        text: `deduped as already handled by proposal ${openForIssue.proposal_id}; no new repair task enqueued`,
      });
      state.appendEvent({
        type: "recurrence",
        issue_key: issueKey,
        item,
        wants_requeue: wantsRequeue,
        at: new Date().toISOString(),
      });
      mark("duplicate", wpId, issueKey);
      log("recurrence", { issue: issueKey, wp: wpId, open_proposal: openForIssue.proposal_id });
      return;
    }

    if (state.proposalCountForIssue(issueKey) >= config.maxProposalsPerIssue) {
      await postDiagnosisReportOnce(c, fileName, wp, verdict, {
        text: `capped due to repeated attempts (${config.maxProposalsPerIssue}/${config.maxProposalsPerIssue}); no automatic action taken`,
      });
      state.appendEvent({
        type: "recurrence",
        issue_key: issueKey,
        item,
        wants_requeue: false,
        at: new Date().toISOString(),
      });
      mark("exhausted", wpId, issueKey);
      log("issue_exhausted", { issue: issueKey, wp: wpId });
      if (!state.hasNotice("exhausted", issueKey)) {
        state.appendEvent({ type: "notice", kind: "exhausted", issue_key: issueKey, at: new Date().toISOString() });
        await notify(
          `⚠️ **improver** — issue \`${issueKey}\` keeps recurring after ${config.maxProposalsPerIssue} improvement attempt(s). Not re-proposing; needs manual attention.\nLatest occurrence: \`${wpId ?? fileName}\` (${c.bucket}/)`
        );
      }
      return;
    }

    const open = state.openProposals();
    const openForLine = open.filter((p) => p.source_line === c.lineName).length;
    if (open.length >= config.maxOpenProposals || openForLine >= config.maxOpenPerLine) {
      await postDiagnosisReportOnce(c, fileName, wp, verdict, {
        text: `skipped due to safety gate: proposal cap hit (${open.length}/${config.maxOpenProposals}, ${openForLine}/${config.maxOpenPerLine} for line); will reconsider later`,
      });
      // Leave UNREGISTERED so the candidate is reconsidered when a slot
      // frees (the next sweep re-assesses it — bounded by the budget).
      log("proposal_cap_hit", {
        issue: issueKey,
        open_total: open.length,
        open_for_line: openForLine,
      });
      if (!state.hasNotice("cap", issueKey)) {
        state.appendEvent({ type: "notice", kind: "cap", issue_key: issueKey, at: new Date().toISOString() });
        await notify(
          `⏸️ **improver** — proposal cap hit (${open.length} open, ${openForLine} for ${c.lineName}); deferring proposal for \`${issueKey}\`: ${verdict.title}`
        );
      }
      return;
    }

    const dev = devLineRef();
    if (!dev) {
      // Dev line not discovered (not running / removed). Leave unregistered
      // so the sweep retries once it exists.
      await postDiagnosisReportOnce(c, fileName, wp, verdict, {
        text: `skipped due to safety gate: dev line ${config.devLine} unavailable; no automatic action taken`,
      });
      if (!devLineMissingLogged) {
        devLineMissingLogged = true;
        log("dev_line_missing", { dev_line: config.devLine, issue: issueKey });
        await notify(
          `⚠️ **improver** — wanted to queue an improvement for \`${issueKey}\` but the \`${config.devLine}\` line is not running.`
        );
      }
      return;
    }

    const now = new Date();
    const proposalId = `imp_${now.toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 6)}`;
    const { fileName: devFile, taskKey } = enqueueDevTask(
      dev.linePath,
      {
        proposalId,
        issueKey,
        issueSlug: verdict.issue_slug,
        sourceLine: c.lineName,
        sourceWorkpieceId: wpId,
        title: verdict.title,
        taskBody: verdict.task_body,
      },
      now,
      config.proposalMode
    );
    state.appendEvent({
      type: "proposed",
      proposal_id: proposalId,
      issue_key: issueKey,
      source_line: c.lineName,
      source_line_path: c.linePath,
      issue_slug: verdict.issue_slug,
      target_station: verdict.target_station,
      title: verdict.title,
      dev_task_key: taskKey,
      dev_task_file: devFile,
      requeue: wantsRequeue ? [item] : [],
      at: now.toISOString(),
    });
    mark("proposed", wpId, issueKey);
    log("proposal_queued", {
      issue: issueKey,
      proposal: proposalId,
      dev_task: taskKey,
      wp: wpId,
      mode: config.proposalMode,
    });
    await postDiagnosisReportOnce(c, fileName, wp, verdict, {
      text: `auto-enqueued repair task ${taskKey} (${devFile})`,
      devTaskKey: taskKey,
      devTaskFile: devFile,
      fingerprint: diagnosisFingerprint(verdict, failedStationInfo(wp, verdict).station, failedStationInfo(wp, verdict).failureClass),
    });
    await notify(
      [
        `🔧 **improver** — queued improvement for **${c.lineName}**${config.proposalMode === "held" ? " (held — release to run)" : ""}`,
        `**${verdict.title}**`,
        `issue \`${issueKey}\` · proposal \`${proposalId}\` · dev task \`${taskKey}\``,
        `source run \`${wpId ?? fileName}\` (${c.bucket}/)${wantsRequeue ? " — will requeue when the fix deploys" : ""}`,
      ].join("\n")
    );
  }

  async function reportDiagnosis(diagnosis: FailureDiagnosis): Promise<void> {
    if (state.hasDiagnosisReport(diagnosis.fingerprint)) return;
    state.appendEvent({
      type: "diagnosis_reported",
      fingerprint: diagnosis.fingerprint,
      line: diagnosis.source_line,
      file_name: diagnosis.file_name,
      wp_id: diagnosis.workpiece_id,
      root_cause: diagnosis.root_cause,
      confidence: diagnosis.confidence,
      action: diagnosis.action,
      at: new Date().toISOString(),
    });
    await notify(formatDiagnosisReport(diagnosis));
  }

  async function handleDiagnosis(
    c: Candidate,
    key: string,
    fileName: string,
    wpId: string | null,
    diagnosis: FailureDiagnosis
  ): Promise<void> {
    const issueKey = `${c.lineName}/${diagnosis.station ?? "line"}/${diagnosis.issue_slug}`;
    const mark = (
      verdictKind: Parameters<typeof state.markAssessed>[0]["verdict"],
      issueKeyArg?: string
    ) =>
      state.markAssessed({
        key,
        wp_id: wpId,
        line: c.lineName,
        bucket: c.bucket,
        file_name: fileName,
        verdict: verdictKind,
        issue_key: issueKeyArg,
        at: new Date().toISOString(),
      });

    if (diagnosis.action !== "enqueue_repair") {
      mark("no_action");
      await reportDiagnosis(diagnosis);
      return;
    }

    const item: RequeueItem = {
      line_path: c.linePath,
      line: c.lineName,
      bucket: "error",
      file_name: fileName,
      wp_id: wpId,
    };

    const openForIssue = state.findOpenByIssue(issueKey);
    if (openForIssue) {
      state.appendEvent({
        type: "recurrence",
        issue_key: issueKey,
        item,
        wants_requeue: true,
        at: new Date().toISOString(),
      });
      mark("duplicate", issueKey);
      await reportDiagnosis({
        ...diagnosis,
        action: "deduped",
        recommended_action: `Existing proposal ${openForIssue.proposal_id} is already open; attached this failure as a recurrence.`,
      });
      log("diagnosis_deduped", { issue: issueKey, wp: wpId, proposal: openForIssue.proposal_id });
      return;
    }

    if (state.proposalCountForIssue(issueKey) >= config.maxProposalsPerIssue) {
      state.appendEvent({
        type: "recurrence",
        issue_key: issueKey,
        item,
        wants_requeue: false,
        at: new Date().toISOString(),
      });
      mark("exhausted", issueKey);
      await reportDiagnosis({
        ...diagnosis,
        action: "capped",
        recommended_action: `Issue ${issueKey} hit the proposal cap; manual review needed.`,
      });
      log("diagnosis_capped", { issue: issueKey, wp: wpId });
      return;
    }

    const open = state.openProposals();
    const openForLine = open.filter((p) => p.source_line === c.lineName).length;
    if (open.length >= config.maxOpenProposals || openForLine >= config.maxOpenPerLine) {
      await reportDiagnosis({
        ...diagnosis,
        action: "skipped",
        recommended_action: `Proposal cap hit (${open.length} open, ${openForLine} for ${c.lineName}); retry on a later sweep.`,
      });
      log("diagnosis_cap_hit", { issue: issueKey, open_total: open.length, open_for_line: openForLine });
      return;
    }

    const dev = devLineRef();
    if (!dev) {
      await reportDiagnosis({
        ...diagnosis,
        action: "skipped",
        recommended_action: `Dev line ${config.devLine} is not available; retry on a later sweep.`,
      });
      log("diagnosis_dev_line_missing", { issue: issueKey, wp: wpId });
      return;
    }

    const now = new Date();
    const proposalId = `imp_${now.toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 6)}`;
    const { fileName: devFile, taskKey } = enqueueDevTask(
      dev.linePath,
      {
        proposalId,
        issueKey,
        issueSlug: diagnosis.issue_slug,
        sourceLine: c.lineName,
        sourceWorkpieceId: wpId,
        title: diagnosis.title,
        taskBody: diagnosis.task_body,
      },
      now,
      config.proposalMode
    );
    state.appendEvent({
      type: "proposed",
      proposal_id: proposalId,
      issue_key: issueKey,
      source_line: c.lineName,
      source_line_path: c.linePath,
      issue_slug: diagnosis.issue_slug,
      target_station: diagnosis.station,
      title: diagnosis.title,
      dev_task_key: taskKey,
      dev_task_file: devFile,
      requeue: [item],
      at: now.toISOString(),
    });
    mark("proposed", issueKey);
    await reportDiagnosis({
      ...diagnosis,
      recommended_action: `queued improvement repair task ${taskKey} (${devFile})${config.proposalMode === "held" ? " (held for manual release)" : ""}.`,
      action: "enqueue_repair",
    });
    log("diagnosis_repair_queued", {
      issue: issueKey,
      proposal: proposalId,
      dev_task: taskKey,
      wp: wpId,
      fingerprint: diagnosis.fingerprint,
    });
  }

  async function handleOrdinaryFailure(c: Candidate, key: string, fileName: string): Promise<void> {
    if (!existsSync(c.filePath)) return;
    let wp: Record<string, unknown>;
    try {
      wp = JSON.parse(readFileSync(c.filePath, "utf-8"));
    } catch {
      state.markAssessed({
        key,
        wp_id: null,
        line: c.lineName,
        bucket: c.bucket,
        file_name: fileName,
        verdict: "error",
        at: new Date().toISOString(),
      });
      return;
    }
    const wpId = typeof wp.id === "string" ? wp.id : null;
    const diagnosis = diagnoseFailure({
      lineName: c.lineName,
      linePath: c.linePath,
      fileName,
      filePath: c.filePath,
      workpiece: wp,
    });
    await handleDiagnosis(c, key, fileName, wpId, diagnosis);
  }

  function clipText(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max)}...[truncated]`;
  }

  function failedStationInfo(
    wp: Record<string, unknown>,
    verdict: AssessmentVerdict
  ): { station: string | null; failureClass: string | null } {
    const stations = (wp.stations ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, station] of Object.entries(stations)) {
      if (!station || typeof station !== "object") continue;
      if (station.status === "failed" || station.status === "escalated") {
        return {
          station: name,
          failureClass: typeof station.failure_class === "string" && station.failure_class.trim() ? station.failure_class : null,
        };
      }
    }
    if (verdict.target_station) {
      const station = stations[verdict.target_station];
      return {
        station: verdict.target_station,
        failureClass:
          station && typeof station.failure_class === "string" && station.failure_class.trim()
            ? station.failure_class
            : null,
      };
    }
    return { station: null, failureClass: null };
  }

  function compactPath(path: string): string {
    const rel = relative(process.cwd(), path);
    return rel && !rel.startsWith("..") ? rel : path;
  }

  function existingSidecars(filePath: string): string[] {
    return [`${filePath}.stderr.log`, `${filePath}.session.jsonl`]
      .filter((path) => existsSync(path))
      .map((path) => compactPath(path));
  }

  function diagnosisFingerprint(
    verdict: AssessmentVerdict,
    station: string | null,
    failureClass: string | null
  ): string {
    if (verdict.failure_fingerprint) return verdict.failure_fingerprint;
    return normalizeSlug(`${station ?? "line"}-${failureClass ?? "unknown"}-${verdict.issue_slug}`);
  }

  function diagnosisReportKey(
    c: Candidate,
    fileName: string,
    wpId: string | null,
    station: string | null,
    fingerprint: string
  ): string {
    return `${c.lineName}:${wpId ?? fileName}:${station ?? "line"}:${fingerprint}`;
  }

  function reportEvidence(c: Candidate, verdict: AssessmentVerdict): string[] {
    const sidecars = existingSidecars(c.filePath).map((path) => `sidecar: ${path}`).slice(0, 2);
    const evidence = [...(verdict.evidence ?? [])]
      .filter((x) => x.trim())
      .slice(0, Math.max(0, 4 - sidecars.length));
    const combined = [...evidence, ...sidecars].slice(0, 4);
    if (combined.length === 0) return [verdict.reasoning || `issue: ${verdict.issue_slug}`];
    if (combined.length === 1) {
      combined.push(verdict.reasoning ? `reasoning: ${verdict.reasoning}` : `issue: ${verdict.issue_slug}`);
    }
    return combined;
  }

  async function postDiagnosisReportOnce(
    c: Candidate,
    fileName: string,
    wp: Record<string, unknown>,
    verdict: AssessmentVerdict,
    action: DiagnosisReportAction
  ): Promise<void> {
    if (c.bucket !== "error" || c.lineName === config.devLine) return;
    const wpId = typeof wp.id === "string" ? wp.id : null;
    const stationInfo = failedStationInfo(wp, verdict);
    const fingerprint = diagnosisFingerprint(verdict, stationInfo.station, stationInfo.failureClass);
    const reportKey = diagnosisReportKey(c, fileName, wpId, stationInfo.station, fingerprint);
    if (state.hasReport(reportKey)) return;
    const finalAction = { ...action, fingerprint: action.fingerprint ?? fingerprint };
    try {
      await notify(
        buildDiagnosisReportMessage({
          sourceLine: c.lineName,
          workpieceId: wpId,
          fileName,
          sourceFile: compactPath(c.filePath),
          failedStation: stationInfo.station,
          failureClass: stationInfo.failureClass,
          rootCauseCategory: verdict.root_cause_category ?? verdict.issue_slug,
          confidenceLevel: verdict.confidence,
          confidenceScore: verdict.confidence_score,
          evidence: reportEvidence(c, verdict),
          recommendedNextAction: verdict.recommended_next_action ?? "manual review",
          action: finalAction,
        })
      );
    } catch {}
    state.markReport({
      key: reportKey,
      line: c.lineName,
      wp_id: wpId,
      file_name: fileName,
      station: stationInfo.station,
      fingerprint,
      at: new Date().toISOString(),
    });
  }

  function stringifyPart(v: unknown): string {
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  function devFailureText(wp: Record<string, unknown>): string {
    const parts: string[] = [];
    if (wp.id) parts.push(`id: ${stringifyPart(wp.id)}`);
    if (wp.summary) parts.push(`summary: ${stringifyPart(wp.summary)}`);
    const stations = (wp.stations ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, station] of Object.entries(stations)) {
      if (!station || typeof station !== "object") continue;
      parts.push(`station ${name}: status=${stringifyPart(station.status)} summary=${stringifyPart(station.summary)}`);
      const data = station.data as Record<string, unknown> | undefined;
      if (data?.error) parts.push(`station ${name} error: ${stringifyPart(data.error)}`);
      if (data?.gate_failure) parts.push(`station ${name} gate_failure: ${stringifyPart(data.gate_failure)}`);
      const evalRes = station.eval as Record<string, unknown> | undefined;
      if (evalRes?.feedback) parts.push(`station ${name} eval: ${stringifyPart(evalRes.feedback)}`);
      const attempts = station.previous_attempts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(attempts) && attempts.length > 0) {
        const last = attempts[attempts.length - 1];
        if (last?.summary) parts.push(`station ${name} last_attempt: ${stringifyPart(last.summary)}`);
      }
    }
    return clipText(parts.join("\n"), 5000);
  }

  function recoverableDevFailureReason(wp: Record<string, unknown>): string | null {
    const text = devFailureText(wp);
    if (
      /usage limit|api[_ -]?key|unauthorized|authentication|gitleaks|secret|blocked path|systemctl|git push|push rejected/i.test(
        text
      )
    ) {
      return null;
    }
    const patterns: Array<[RegExp, string]> = [
      [/\btests? failed\b/i, "tests failed"],
      [/\b\d+\s+tests?\s+failed\b/i, "tests failed"],
      [/bun test exited/i, "bun test failed"],
      [/typecheck failed|tsc --noEmit/i, "typecheck failed"],
      [/lint failed|eslint/i, "lint failed"],
      [/gate_failure|plan-alignment|envelope-scope/i, "validation gate failed"],
      [/deploy\.ts exited with code 1|deploy validation/i, "deploy validation failed"],
      [/rebase conflict|conflict markers/i, "merge conflict repair needed"],
    ];
    for (const [pattern, reason] of patterns) {
      if (pattern.test(text)) return reason;
    }
    return null;
  }

  async function handleDevCompletion(c: Candidate, key: string, fileName: string): Promise<boolean> {
    const mark = () =>
      state.markAssessed({
        key,
        wp_id: null,
        line: c.lineName,
        bucket: c.bucket,
        file_name: fileName,
        verdict: "dev_completion",
        at: new Date().toISOString(),
      });

    let wp: Record<string, unknown>;
    try {
      wp = JSON.parse(readFileSync(c.filePath, "utf-8"));
    } catch {
      // Unparseable dev completion: don't resolve here — the stale sweep's
      // terminal-bucket check releases the proposal slot with outcome lost.
      mark();
      log("dev_completion_unparseable", { file: fileName });
      return true;
    }

    const input = (wp.input ?? {}) as Record<string, unknown>;
    const improverMeta = (input.improver ?? null) as Record<string, unknown> | null;
    const proposalId = improverMeta && typeof improverMeta.proposal_id === "string" ? improverMeta.proposal_id : null;
    if (!proposalId) {
      // A regular dev-line run is not a proposal completion. Let failed
      // ordinary tasks flow through the general failure diagnostician.
      if (c.bucket === "error") return false;
      mark();
      return true;
    }

    const open = state.findOpenByProposalId(proposalId);
    if (!open) {
      mark();
      log("dev_completion_unmatched", { proposal: proposalId, file: fileName });
      return true;
    }

    const devWpId = typeof wp.id === "string" ? wp.id : null;
    const stations = (wp.stations ?? {}) as Record<string, Record<string, unknown>>;
    const noOp = Object.values(stations).some(
      (s) => s && typeof s === "object" && (s.data as Record<string, unknown> | undefined)?.no_op === true
    );

    if (c.bucket === "error") {
      const retryReason = recoverableDevFailureReason(wp);
      const dev = devLineRef();
      if (retryReason && dev && open.dev_retry_count < config.maxDevTaskRetries) {
        const now = new Date();
        const failureText = devFailureText(wp);
        const { fileName: devFile, taskKey } = enqueueDevTask(
          dev.linePath,
          {
            proposalId,
            issueKey: open.issue_key,
            issueSlug: open.issue_slug,
            sourceLine: open.source_line,
            sourceWorkpieceId: (improverMeta?.source_workpiece_id as string | undefined) ?? open.requeue[0]?.wp_id ?? null,
            title: `Repair failed improvement: ${open.title}`,
            taskBody: [
              `The previous assembly-dev improvement task failed during local validation and appears repairable.`,
              ``,
              `Failed dev run: ${devWpId ?? fileName}`,
              `Previous dev task key: ${open.dev_task_key}`,
              `Retry reason: ${retryReason}`,
              ``,
              `Failure evidence:`,
              "```",
              failureText,
              "```",
              ``,
              `Repair the implementation for issue ${open.issue_key}. Do not requeue source tasks; the improver will do that only after this repair task completes successfully.`,
            ].join("\n"),
          },
          now,
          config.proposalMode
        );
        state.appendEvent({
          type: "dev_retry",
          proposal_id: proposalId,
          issue_key: open.issue_key,
          previous_dev_task_key: open.dev_task_key,
          dev_task_key: taskKey,
          dev_task_file: devFile,
          dev_wp_id: devWpId,
          reason: retryReason,
          at: now.toISOString(),
        });
        mark();
        log("fix_retry_queued", {
          proposal: proposalId,
          issue: open.issue_key,
          previous_dev_task: open.dev_task_key,
          dev_task: taskKey,
          reason: retryReason,
        });
        await notify(
          `🛠️ **improver** — queued a repair task for \`${open.issue_key}\` after ${config.devLine} failed validation (${retryReason}).\n**${open.title}**\nfailed dev run \`${devWpId ?? fileName}\` — source tasks were NOT requeued.`
        );
        return true;
      }
      state.appendEvent({
        type: "resolved",
        proposal_id: proposalId,
        issue_key: open.issue_key,
        outcome: "fix_failed",
        dev_wp_id: devWpId,
        at: new Date().toISOString(),
      });
      mark();
      log("fix_failed", { proposal: proposalId, issue: open.issue_key });
      await notify(
        `❌ **improver** — improvement task for \`${open.issue_key}\` failed in ${config.devLine}.\n**${open.title}**\ndev run \`${devWpId ?? fileName}\` — source tasks were NOT requeued.`
      );
      return true;
    }

    if (noOp) {
      state.appendEvent({
        type: "resolved",
        proposal_id: proposalId,
        issue_key: open.issue_key,
        outcome: "no_op",
        dev_wp_id: devWpId,
        requeued: 0,
        at: new Date().toISOString(),
      });
      mark();
      log("fix_no_op", { proposal: proposalId, issue: open.issue_key });
      await notify(
        `ℹ️ **improver** — ${config.devLine} judged \`${open.issue_key}\` a no-op (already implemented or nothing to change). Source tasks were not requeued.\n**${open.title}**`
      );
      return true;
    }

    // Persist the resolution BEFORE requeueing: a crash mid-requeue must not
    // replay the whole batch on restart (duplicate side effects). The safer
    // failure mode is "fix recorded, some requeues lost" — visible in the
    // activity log and recoverable by hand.
    const planned = config.requeueOnFix ? open.requeue : [];
    state.appendEvent({
      type: "resolved",
      proposal_id: proposalId,
      issue_key: open.issue_key,
      outcome: "fixed",
      dev_wp_id: devWpId,
      requeued: planned.length,
      at: new Date().toISOString(),
    });
    mark();
    const results = planned.map((r) => requeueSource(r));
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    log("fix_deployed", {
      proposal: proposalId,
      issue: open.issue_key,
      requeued: ok.length,
      requeue_failed: failed.length,
    });
    const lines = [
      `✅ **improver** — improvement deployed for \`${open.issue_key}\``,
      `**${open.title}**`,
      `dev run \`${devWpId ?? fileName}\``,
    ];
    if (config.requeueOnFix && open.requeue.length > 0) {
      lines.push(`requeued ${ok.length}/${open.requeue.length} source task(s) on ${open.source_line}`);
      for (const f of failed.slice(0, 3)) {
        lines.push(`  ⚠️ ${f.item.file_name}: ${f.reason}`);
      }
    }
    await notify(lines.join("\n"));
    return true;
  }

  /**
   * A dev task escalated to queues/review/ needs a human decision and may
   * sit there indefinitely — release its proposal slot and say so, instead
   * of silently starving the improver.
   */
  async function handleDevEscalation(c: Candidate, key: string, fileName: string): Promise<void> {
    const mark = () =>
      state.markAssessed({
        key,
        wp_id: null,
        line: c.lineName,
        bucket: c.bucket,
        file_name: fileName,
        verdict: "dev_completion",
        at: new Date().toISOString(),
      });

    let proposalId: string | null = null;
    let wp: Record<string, unknown>;
    let improverMeta: Record<string, unknown> | undefined;
    try {
      wp = JSON.parse(readFileSync(c.filePath, "utf-8"));
      improverMeta = ((wp.input ?? {}) as Record<string, unknown>).improver as
        | Record<string, unknown>
        | undefined;
      if (improverMeta && typeof improverMeta.proposal_id === "string") {
        proposalId = improverMeta.proposal_id;
      }
    } catch {
      mark();
      return;
    }
    if (!proposalId) {
      mark();
      return;
    }
    const open = state.findOpenByProposalId(proposalId);
    if (!open) {
      mark();
      return;
    }

    const retryReason = recoverableDevFailureReason(wp);
    const dev = devLineRef();
    if (retryReason && dev && open.dev_retry_count < config.maxDevTaskRetries) {
      const now = new Date();
      const devWpId = typeof wp.id === "string" ? wp.id : null;
      const failureText = devFailureText(wp);
      const { fileName: devFile, taskKey } = enqueueDevTask(
        dev.linePath,
        {
          proposalId,
          issueKey: open.issue_key,
          issueSlug: open.issue_slug,
          sourceLine: open.source_line,
          sourceWorkpieceId: (improverMeta?.source_workpiece_id as string | undefined) ?? open.requeue[0]?.wp_id ?? null,
          title: `Repair escalated improvement: ${open.title}`,
          taskBody: [
            `The previous assembly-dev improvement task escalated for review, but the failure appears repairable by another dev-line pass.`,
            ``,
            `Escalated dev run: ${devWpId ?? fileName}`,
            `Previous dev task key: ${open.dev_task_key}`,
            `Retry reason: ${retryReason}`,
            ``,
            `Failure evidence:`,
            "```",
            failureText,
            "```",
            ``,
            `Repair the implementation for issue ${open.issue_key}. Do not requeue source tasks; the improver will do that only after this repair task completes successfully.`,
          ].join("\n"),
        },
        now,
        config.proposalMode
      );
      state.appendEvent({
        type: "dev_retry",
        proposal_id: proposalId,
        issue_key: open.issue_key,
        previous_dev_task_key: open.dev_task_key,
        dev_task_key: taskKey,
        dev_task_file: devFile,
        dev_wp_id: devWpId,
        reason: retryReason,
        at: now.toISOString(),
      });
      mark();
      log("fix_retry_queued", {
        proposal: proposalId,
        issue: open.issue_key,
        previous_dev_task: open.dev_task_key,
        dev_task: taskKey,
        reason: retryReason,
        bucket: "review",
      });
      await notify(
        `🛠️ **improver** — queued a repair task for \`${open.issue_key}\` after ${config.devLine} escalated with a recoverable validation failure (${retryReason}).\n**${open.title}**\nfailed dev run \`${devWpId ?? fileName}\` — source tasks were NOT requeued.`
      );
      return;
    }

    state.appendEvent({
      type: "resolved",
      proposal_id: proposalId,
      issue_key: open.issue_key,
      outcome: "escalated",
      at: new Date().toISOString(),
    });
    mark();
    log("fix_escalated", { proposal: proposalId, issue: open.issue_key });
    await notify(
      `⚠️ **improver** — improvement task for \`${open.issue_key}\` was escalated for human review (it stays in ${config.devLine}/queues/review/). Releasing its proposal slot.\n**${open.title}**`
    );
  }

  // ── Per-line baseline ───────────────────────────────────────────────
  // The first time the watcher ever sees a line (first boot OR a line added
  // months later), its pre-existing history is baselined without LLM calls.
  // The marker is written after the walk, so a crash mid-baseline re-walks
  // idempotently instead of leaking history into assessment.
  function baselineLine(ref: ImproverLineRef): void {
    if (state.isLineBaselined(ref.linePath)) return;
    let count = 0;
    for (const bucket of ["done", "error"] as const) {
      const dir = resolve(ref.linePath, "queues", bucket);
      for (const filePath of listQueue(dir)) {
        const fileName = basename(filePath);
        const key = assessedKey(ref.linePath, bucket, fileName);
        if (state.hasAssessed(key)) continue;
        state.markAssessed({
          key,
          wp_id: null,
          line: ref.lineName,
          bucket,
          file_name: fileName,
          verdict: "bootstrap",
          at: new Date().toISOString(),
        });
        count++;
      }
    }
    state.markLineBaselined(ref.linePath, ref.lineName);
    log("line_baselined", { line: ref.lineName, baselined: count });
  }

  // ── Line watcher sync ───────────────────────────────────────────────
  function syncLines(): void {
    if (stopped) return;
    const lines = opts.getLines();
    const want = new Map<string, ImproverLineRef>();
    for (const l of lines) {
      // Excluded lines are never watched; the dev line IS watched (for
      // proposal resolution), it's just never assessed for improvements.
      if (l.lineName !== config.devLine && isHardExcluded(l.lineName, config)) continue;
      want.set(l.linePath, l);
    }

    for (const [linePath, entry] of watched) {
      if (!want.has(linePath)) {
        for (const stop of entry.stops) {
          try {
            stop();
          } catch {}
        }
        watched.delete(linePath);
        log("unwatched_line", { line: entry.lineName });
      }
    }

    for (const [linePath, ref] of want) {
      if (watched.has(linePath)) continue;
      baselineLine(ref);
      const stops: WatchFolderStop[] = [];
      const buckets: Array<"done" | "error" | "review"> =
        ref.lineName === config.devLine ? ["done", "error", "review"] : ["done", "error"];
      for (const bucket of buckets) {
        const dir = resolve(linePath, "queues", bucket);
        // No periodic rescan — the hourly sweep covers dropped inotify
        // events without re-listing thousands of done files every 10s.
        stops.push(
          watchFolder(dir, (filePath) => enqueueCandidate(ref.lineName, linePath, bucket, filePath), {
            rescanIntervalMs: 0,
          })
        );
      }
      watched.set(linePath, { lineName: ref.lineName, stops });
    }
  }

  // ── Sweep ───────────────────────────────────────────────────────────
  async function sweep(): Promise<void> {
    if (stopped) return;
    assessmentsThisWindow = 0;
    budgetExhaustedLogged = false;
    devLineMissingLogged = false;
    syncLines();

    // Stale proposals: release slots whose dev task can no longer resolve —
    // vanished entirely (deleted), or terminal (done/error) but its
    // completion was consumed without a resolution (e.g. unparseable JSON).
    const dev = devLineRef();
    if (dev) {
      for (const open of state.openProposals()) {
        const ageMs = Date.now() - new Date(open.at).getTime();
        if (ageMs < staleProposalMs) continue;
        const present = devTaskStillPresent(dev.linePath, open.dev_task_key);
        const terminal = devTaskTerminalBucket(dev.linePath, open.dev_task_key);
        if (present && !terminal) continue; // still working / held / review-watched
        state.appendEvent({
          type: "resolved",
          proposal_id: open.proposal_id,
          issue_key: open.issue_key,
          outcome: "lost",
          at: new Date().toISOString(),
        });
        log("proposal_lost", { proposal: open.proposal_id, issue: open.issue_key, terminal });
        await notify(
          `⚠️ **improver** — improvement task for \`${open.issue_key}\` ${
            terminal
              ? `finished (${terminal}/) but its completion was never processed`
              : `disappeared from ${config.devLine} without completing`
          }; releasing its slot.`
        );
      }
    }

    for (const [linePath, entry] of watched) {
      const buckets: Array<"done" | "error" | "review"> =
        entry.lineName === config.devLine ? ["done", "error", "review"] : ["done", "error"];
      for (const bucket of buckets) {
        for (const filePath of listQueue(resolve(linePath, "queues", bucket))) {
          enqueueCandidate(entry.lineName, linePath, bucket, filePath);
        }
      }
    }
    await settle();
  }

  async function settle(): Promise<void> {
    while (draining) {
      await draining;
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────
  syncLines();
  // Eager misconfiguration warning: assessments will fail without the key.
  if (!opts.assessFn && !process.env.ASSEMBLY_ANTHROPIC_API_KEY) {
    log("missing_api_key", {});
    void notify(
      "🚨 **improver** — enabled, but ASSEMBLY_ANTHROPIC_API_KEY is not set in the daemon's environment; assessments will fail until it is."
    );
  }
  // Catch-up for completions that landed while the daemon was down.
  void sweep().catch((err) => log("sweep_error", { error: (err as Error).message }));

  const sweepTimer = setInterval(() => {
    void sweep().catch((err) => log("sweep_error", { error: (err as Error).message }));
  }, config.sweepIntervalMs);
  if ((sweepTimer as unknown as { unref?: () => void }).unref) {
    (sweepTimer as unknown as { unref: () => void }).unref();
  }

  log("started", {
    dev_line: config.devLine,
    model: config.model,
    proposal_mode: config.proposalMode,
    max_open_proposals: config.maxOpenProposals,
    max_open_per_line: config.maxOpenPerLine,
    requeue_done_tasks: config.requeueDoneTasks,
    sweep_interval_min: Math.round(config.sweepIntervalMs / 60_000),
  });

  return {
    enabled: true,
    stop: () => {
      stopped = true;
      clearInterval(sweepTimer);
      for (const entry of watched.values()) {
        for (const stop of entry.stops) {
          try {
            stop();
          } catch {}
        }
      }
      watched.clear();
      queue.length = 0;
      queuedKeys.clear();
    },
    syncLines,
    sweep,
    settle,
  };
}
