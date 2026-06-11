import { resolve, basename } from "path";
import { mkdirSync, existsSync, appendFileSync, unlinkSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, openSync, closeSync, readSync } from "fs";
import { loadLine } from "./line";
import { createWorkpiece } from "./workpiece";
import { loadEnvFiles } from "./paths";
import {
  initLineQueue,
  initSectionQueue,
  watchFolder,
  claimFile,
  moveFile,
  readFromQueue,
  listQueue,
  listCompletedTaskKeys,
  filterReadyByDeps,
  type QueuePaths,
} from "./queue";
import type { Workpiece, LineConfig, FailureClass, RetryPolicy, RetryPolicyMap, Provider } from "./types";
import { autoArchiveOld } from "./error-dismiss";
import { writeRetryState, clearRetryState, cleanupOrphanedRetryStates } from "./retry-state";
import { startFlowSnapshotWriter } from "./flow-snapshot";
import { evaluateAndSnapshotForProviders } from "./usage";
import { computeRoundsFromProgress } from "./tool-rounds";
import { recordEmit, isEmitted, quarantineUnverified, bootstrapManifest } from "./emit-manifest";
import type { HandoffWorker, HandoffLineSnapshot, HandoffState } from "./handoff";
import { isPidAlive } from "./handoff";
import { tailStderrSink, appendStderrMarker } from "./stderr-log";
import {
  CURRENT_INBOX_PAYLOAD_VERSION,
  validateWorkpieceVersion,
  validateInboxPayloadVersion,
  UnsupportedSchemaVersionError,
} from './schemas';
import { StationName, asWorkpiece } from './ids';

// ─── Process-group helpers ────────────────────────────────────────

/**
 * Send a signal to an entire process group.
 * Asserts pid > 1 to prevent catastrophic mis-signaling
 * (pid=0 signals own group, pid=1 signals init).
 * Swallows ESRCH (process already exited).
 */
export function killProcessGroup(pid: number, signal: string): void {
  if (!pid || pid <= 1) {
    throw new Error(`Refusing to signal process group with pid=${pid}`);
  }
  try {
    process.kill(-pid, signal as NodeJS.Signals);
  } catch (err: any) {
    // ESRCH = no such process (already exited) — safe to ignore
    if (err?.code !== "ESRCH") throw err;
  }
}

/**
 * Linux-only: scan /proc for a running section-worker.ts whose argv contains
 * the given workpiece path. Returns the worker pid or null if no match.
 *
 * Used by stale_recovery to avoid re-queueing a processing/ file when an old
 * daemon's worker is still alive holding it (which would double-spawn). Returns
 * null on non-Linux, on any I/O error, and when the path doesn't appear in
 * any cmdline — fall-through is the existing requeue behaviour.
 */
export function findWorkerForWorkpiece(workpiecePath: string): number | null {
  try {
    const entries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    for (const entry of entries) {
      try {
        // /proc/<pid>/cmdline is null-separated argv. The worker invocation:
        //   bun\0run\0…/src/section-worker.ts\0<station-dir>\0<workpiecePath>\0
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8");
        if (cmdline.includes("section-worker.ts") && cmdline.includes(workpiecePath)) {
          return parseInt(entry, 10);
        }
      } catch {
        // Process may have exited between readdir and read — ignore.
      }
    }
  } catch {
    // Non-Linux or /proc unreadable — caller falls back to requeue.
  }
  return null;
}

/**
 * Count the number of processes in a given process group (Linux only).
 * Reads /proc/<pid>/stat field 5 (pgrp) for every numeric /proc entry.
 * Returns 'unknown' on non-Linux or any error.
 */
export function getProcessGroupSize(pgid: number): number | "unknown" {
  try {
    const entries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    let count = 0;
    for (const entry of entries) {
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf-8");
        // Field 2 (comm) can contain spaces and parens — find the last ')' first
        const closeParen = stat.lastIndexOf(")");
        const fields = stat.slice(closeParen + 2).split(" ");
        // After closing paren: fields[0]=state(3), fields[1]=ppid(4), fields[2]=pgrp(5)
        const pgrp = parseInt(fields[2], 10);
        if (pgrp === pgid) count++;
      } catch {
        // Process may have exited between readdir and stat read
      }
    }
    return count;
  } catch {
    return "unknown";
  }
}

export interface OrchestratorOptions {
  linePath: string;
  dashboardPort?: number;
  /**
   * Per-failure-class retry policy override. Merged on top of DEFAULT_RETRY_POLICY;
   * any class not supplied keeps its default. line.yaml `retry_policy` overrides this.
   */
  retryPolicy?: Partial<RetryPolicyMap>;
  /**
   * Pre-loaded handoff state from a predecessor daemon. When supplied, the
   * orchestrator adopts live workers listed for this line (via the matching
   * `line_path`) instead of treating their processing/ files as stale. See
   * `handoff.ts` for the schema.
   */
  handoffState?: HandoffState;
}

export interface StopOptions {
  /**
   * Handoff mode: skip SIGUSR2 sweep + processing/ aborted-envelope sweep so
   * worker subprocesses keep running for adoption by a successor daemon.
   * Watchers still stop and `isShuttingDown` still flips, so no new work is
   * picked up by this orchestrator.
   */
  handoff?: boolean;
}

/**
 * Default retry policy by failure class.
 *
 * envelope / guardrail both get 1 retry. The dominant failure mode is
 * non-deterministic narrative drift (agent emits adjacent-task output for a
 * given input), which empirically recovers on a fresh station attempt after
 * the Haiku in-worker repair couldn't rescue it. One full retry beats
 * landing in error/ and waiting for a human, and still bounds the blast
 * radius if a prompt is genuinely broken.
 * crash/timeout/provider get budgets matched to their transience profile.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicyMap = {
  envelope:  { maxRetries: 1, backoff: [30] },
  crash:     { maxRetries: 2, backoff: [15, 60] },
  timeout:   { maxRetries: 1, backoff: [60] },
  provider:  { maxRetries: 3, backoff: [5, 30, 120] },
  guardrail: { maxRetries: 1, backoff: [30] },
  // aborted: workers killed by graceful daemon shutdown. Same budget as
  // unknown — re-runs cleanly on the next boot but bounded so a restart
  // loop on a poisoned workpiece can't pin the line forever.
  aborted:   { maxRetries: 2, backoff: [15, 60] },
  unknown:   { maxRetries: 2, backoff: [15, 60] },
};

/**
 * Merge a partial override on top of the default retry policy so callers only
 * need to supply the classes they want to change.
 */
export function mergeRetryPolicy(
  override?: Partial<RetryPolicyMap>
): RetryPolicyMap {
  if (!override) return DEFAULT_RETRY_POLICY;
  const merged = { ...DEFAULT_RETRY_POLICY };
  for (const key of Object.keys(override) as FailureClass[]) {
    const v = override[key];
    if (v) merged[key] = { maxRetries: v.maxRetries, backoff: [...v.backoff] };
  }
  return merged;
}

export type RetryDecision =
  | { action: "retry"; attempt: number; delay_s: number }
  | { action: "error_bucket" };

/**
 * Decide whether a failed station should retry (with a delay) or move to the
 * error bucket, based on the failure class and how many times it has already
 * been retried.
 *
 * `currentRetryCount` is the number of retries already attempted (0 on first
 * failure). The returned `attempt` is the next attempt number the caller will
 * make. When the class has no backoff entry for the current attempt, the last
 * entry is reused; if the list is empty the caller never actually retries.
 */
export function decideRetry(
  failureClass: FailureClass | undefined,
  currentRetryCount: number,
  policy: RetryPolicyMap
): RetryDecision {
  const cls: FailureClass = failureClass ?? "unknown";
  const classPolicy: RetryPolicy = policy[cls] ?? policy.unknown;
  if (currentRetryCount < classPolicy.maxRetries) {
    const last = classPolicy.backoff[classPolicy.backoff.length - 1] ?? 60;
    const delay_s = classPolicy.backoff[currentRetryCount] ?? last;
    return { action: "retry", attempt: currentRetryCount + 1, delay_s };
  }
  return { action: "error_bucket" };
}

export interface SectionInfo {
  name: StationName;
  dir: string;
  provider?: Provider;
  queue: QueuePaths;
  timeout?: number; // seconds of idle (no output) before SIGTERM — undefined = no timeout
  max_wall_clock?: number; // seconds — hard ceiling regardless of activity; undefined = no cap
  flush_grace?: number; // seconds — SIGTERM→SIGKILL window (default 30)
  /**
   * Orphan mode: this station is not in the current line.yaml `sequence` but
   * has in-flight workpieces in its processing/ that were started under a
   * prior config. We watch its output/ so adopted workers can drain, but
   * never spawn new workers and never claim from inbox.
   */
  orphan?: boolean;
}

/**
 * Start the orchestrator for a line.
 * Returns a cleanup function to stop everything.
 */
export interface OrchestratorHandle {
  stop: (opts?: StopOptions) => Promise<void>;
  linePath: string;
  lineConfig: LineConfig;
  /** Snapshot in-flight workers + retry/usage state for handoff to a successor. */
  getHandoffSnapshot: () => { workers: HandoffWorker[]; line: HandoffLineSnapshot };
  /** Set of pids for currently-running workers — for reaper safety. */
  getKnownWorkerPids: () => Set<number>;
}

export async function startOrchestrator(
  options: OrchestratorOptions
): Promise<OrchestratorHandle> {
  loadEnvFiles();

  const { config, stations, linePath } = await loadLine(options.linePath);
  // line.yaml retry_policy wins over the programmatic option; both merge on top of the defaults.
  const retryPolicy = mergeRetryPolicy({
    ...(options.retryPolicy ?? {}),
    ...(config.retry_policy ?? {}),
  });

  // Flatten sequence to get ordered station names (simple sequential for now)
  const sequence = flattenSequence(config);

  // Initialize queues
  const lineQueue = initLineQueue(linePath);

  // Bootstrap the producer-allowlist manifest from any pre-existing inbox
  // contents. This is the migration path: tasks already queued before the
  // daemon learned about producer tracking get auto-trusted as `bootstrap`
  // so the in-flight run keeps draining. From this point forward only
  // recorded emits will pass the inbox-watcher / drainInbox checks.
  bootstrapManifest(lineQueue.inbox);

  // Build per-station override maps from sequence
  const stationTimeouts = new Map<StationName, number>();
  const stationMaxWallClocks = new Map<StationName, number>();
  const stationFlushGraces = new Map<StationName, number>();
  for (const step of config.sequence) {
    if (typeof step === 'object' && 'station' in step) {
      const s = (step as { station: { name: string; timeout?: number; max_wall_clock?: number; flush_grace?: number } }).station;
      if (s.timeout !== undefined && s.timeout > 0) {
        stationTimeouts.set(StationName(s.name), s.timeout);
      }
      if (s.max_wall_clock !== undefined && s.max_wall_clock > 0) {
        stationMaxWallClocks.set(StationName(s.name), s.max_wall_clock);
      }
      if (s.flush_grace !== undefined && s.flush_grace >= 0) {
        stationFlushGraces.set(StationName(s.name), s.flush_grace);
      }
    }
  }

  const sections: SectionInfo[] = sequence.map((name) => {
    const dir = resolve(linePath, "stations", name);
    const queue = initSectionQueue(dir);
    // Bootstrap section-inbox manifest too — files already queued from
    // previous orchestrator runs (e.g. mid-line workpieces routed before
    // restart) need to be on the allowlist or drainInbox would quarantine
    // them on first scan.
    bootstrapManifest(queue.inbox);
    // Per-station override > line-level default > undefined
    const timeout = stationTimeouts.get(name) ?? (config.timeout && config.timeout > 0 ? config.timeout : undefined);
    const max_wall_clock = stationMaxWallClocks.get(name) ?? (config.max_wall_clock && config.max_wall_clock > 0 ? config.max_wall_clock : undefined);
    const flush_grace = stationFlushGraces.get(name) ?? config.flush_grace ?? 30;
    const provider = stations.get(name)?.provider ?? "claude-code";
    return { name, dir, provider, queue, timeout, max_wall_clock, flush_grace };
  });

  // (Orphan station detection moved below — runs after log() is defined.)

  // Activity log
  const logPath = resolve(linePath, "queues", "activity.jsonl");

  function log(event: string, detail: Record<string, unknown> = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...detail,
    };
    // Activity logging is best-effort. A deferred setTimeout (e.g. a retry
    // backoff) firing after the line directory has been rm-rf'd shouldn't
    // crash the daemon — ENOENT just means there's no longer anything to
    // observe. Particularly relevant in tests where afterEach tears down
    // linePath while timers are still scheduled.
    try {
      appendFileSync(logPath, JSON.stringify(entry) + "\n");
    } catch {}
    console.log(
      `  [${entry.ts.slice(11, 19)}] ${event}${detail.station ? ` (${detail.station})` : ""}${detail.summary ? ` — ${detail.summary}` : ""}`
    );
  }

  /**
   * Tail the activity log for station_heartbeat events matching a specific
   * station and workpiece. When a heartbeat with child_live: true arrives,
   * calls the onHeartbeat callback to update the idle watchdog's lastActivityMs.
   *
   * Starts from the current EOF (ignores old heartbeats from prior runs).
   * Polls at 5s intervals (heartbeats fire every 30s; 5s poll ensures we catch
   * them well before the watchdog tick).
   *
   * Returns a stop function that clears the interval and closes the file descriptor.
   */
  function tailActivityLog(
    stationName: string,
    workpieceName: string,
    onHeartbeat: () => void
  ): () => void {
    // Start from current end of file — old heartbeats from prior runs don't count
    let offset = 0;
    try {
      offset = statSync(logPath).size;
    } catch {}

    let fd: number | null = null;
    let stopped = false;
    let lineBuf = "";

    const openFd = () => {
      if (fd !== null) return;
      try {
        fd = openSync(logPath, "r");
      } catch {
        fd = null;
      }
    };

    const drain = () => {
      if (stopped) return;
      if (fd === null) openFd();
      if (fd === null) return;
      try {
        const stat = statSync(logPath);
        if (stat.size <= offset) return;
        const buf = Buffer.alloc(stat.size - offset);
        const bytes = readSync(fd, buf, 0, buf.length, offset);
        if (bytes > 0) {
          offset += bytes;
          lineBuf += buf.slice(0, bytes).toString("utf-8");
          // Process complete lines
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() ?? ""; // keep incomplete last line
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (
                entry.event === "station_heartbeat" &&
                entry.station === stationName &&
                entry.workpiece === workpieceName &&
                entry.child_live === true
              ) {
                onHeartbeat();
              }
            } catch {
              // Malformed line — skip
            }
          }
        }
      } catch {
        try { if (fd !== null) closeSync(fd); } catch {}
        fd = null;
      }
    };

    const timer = setInterval(drain, 5_000);
    if (timer.unref) timer.unref();

    return () => {
      stopped = true;
      clearInterval(timer);
      drain(); // final pass
      try { if (fd !== null) closeSync(fd); } catch {}
      fd = null;
    };
  }

  // ─── Orphan station detection ─────────────────────────────────────
  //
  // After a `daemon reload` with a line.yaml change that removed (or renamed)
  // a station, any workpiece still in <linePath>/stations/<removed>/queue/
  // processing/ would be stranded. Detect these dirs and mount a
  // watch-only SectionInfo so the adopted worker's eventual output can be
  // routed forward by the *new* sequence (or parked in queues/review if no
  // path forward exists). Never spawn new workers for an orphan.
  const sequenceSet = new Set(sequence);
  const stationsRoot = resolve(linePath, "stations");
  if (existsSync(stationsRoot)) {
    try {
      const dirents = readdirSync(stationsRoot, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        if (sequenceSet.has(StationName(d.name))) continue;
        const stationDir = resolve(stationsRoot, d.name);
        const processingDir = resolve(stationDir, "queue", "processing");
        if (!existsSync(processingDir)) continue;
        const remaining = listQueue(processingDir);
        if (remaining.length === 0) continue;
        const queue = initSectionQueue(stationDir);
        sections.push({
          name: StationName(d.name),
          dir: stationDir,
          queue,
          // No timeouts/spawn config — orphan means no new spawns; idle
          // detection isn't useful when we can't kill the adopted worker
          // (only its predecessor daemon set its timer). flush_grace kept
          // at default in case shutdown is requested.
          flush_grace: config.flush_grace ?? 30,
          orphan: true,
        });
        log("orphan_station_mounted", {
          line: config.name,
          station: d.name,
          in_flight: remaining.length,
        });
      }
    } catch (err) {
      log("orphan_station_scan_error", { error: (err as Error).message });
    }
  }

  // ─── State maps (must exist before adoption / recovery / watchers) ─
  //
  // Declared up front because adoption populates them before recoverStale
  // runs, and watchers reference them at attach-time.

  // Track retry counts per workpiece (key: `${workpieceId}:${stationName}`)
  const retryCounts = new Map<string, number>();

  // Track active workers per station for concurrency control
  const activeWorkers = new Map<StationName, number>();
  const concurrencyLimit = config.concurrency ?? Infinity;

  interface ActiveWorkerHandle {
    pid: number;
    section: SectionInfo;
    processingPath: string;
    exited: Promise<number | null>;
    isExited: () => boolean;
    /** Worker startedAt — used for handoff snapshot. */
    started_at: string;
    /** True if this handle was adopted from a predecessor daemon. */
    adopted?: boolean;
    /** Stop-tail handle for the stderr sidecar (so we drain on exit). */
    stopStderrTail?: () => void;
    /** Stop-tail handle for the activity log heartbeat watcher. */
    stopActivityTail?: () => void;
  }
  const activeWorkerHandles = new Map<string, ActiveWorkerHandle>();

  // Usage-gate state (declared up front, see comment near drainInbox).
  let usagePaused = false;
  let usagePauseReason = "";
  let usageResumeTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Adoption from predecessor daemon ──────────────────────────────
  //
  // If a handoff state was passed in, walk its workers list for entries
  // matching this line and adopt the still-alive subprocesses. Dead entries
  // fall through to recoverStaleProcessing below, which writes an `aborted`
  // failure and routes via the retry path.
  if (options.handoffState) {
    const matching = options.handoffState.workers.filter(
      (w) => w.line_path === linePath
    );
    let adopted = 0;
    let skippedDead = 0;
    for (const w of matching) {
      if (!isPidAlive(w.pid)) {
        skippedDead++;
        continue;
      }
      if (!existsSync(w.processing_path)) {
        // Worker finished + moved the file during the handoff gap. Its
        // output is already in output/; the watcher will pick it up on
        // initial scan. Nothing to adopt.
        continue;
      }
      const section = sections.find((s) => s.name === w.section_name);
      if (!section) {
        // Station was removed from line.yaml between predecessor's spawn
        // and now. The orphan-station detector above will have built a
        // SectionInfo with `orphan: true` for any station that has a
        // non-empty processing/. Re-search including those.
        // (Since we scan stations/* AFTER building the live sequence and
        // append to `sections`, this find should now succeed for orphans.)
        // If it still fails, the workpiece file simply isn't in any
        // known station — leave the worker running uncoordinated; its
        // output won't be routed but we don't want to interfere.
        log("adoption_skip_unknown_station", {
          line: config.name,
          station: w.section_name,
          pid: w.pid,
          workpiece: w.workpiece_id,
        });
        continue;
      }
      adoptWorker({ section, worker: w });
      adopted++;
    }
    // Restore retry counts and usage-gate state from the line snapshot.
    const lineSnap = options.handoffState.lines.find(
      (l) => l.line_path === linePath
    );
    if (lineSnap) {
      for (const [k, v] of Object.entries(lineSnap.retry_counts)) {
        retryCounts.set(k, v);
      }
      if (lineSnap.usage_paused) {
        usagePaused = true;
        usagePauseReason = lineSnap.usage_pause_reason ?? "carried from predecessor";
      }
    }
    if (adopted > 0 || skippedDead > 0) {
      log("adoption_complete", {
        line: config.name,
        adopted,
        skipped_dead: skippedDead,
      });
    }
  }

  function adoptWorker(args: {
    section: SectionInfo;
    worker: HandoffWorker;
  }): void {
    const { section, worker } = args;
    let workerExited = false;

    // Synthesize proc.exited: poll kill(pid, 0) at 1Hz; resolve when ESRCH.
    const exited: Promise<number | null> = new Promise((resolveExit) => {
      const timer = setInterval(() => {
        if (!isPidAlive(worker.pid)) {
          workerExited = true;
          clearInterval(timer);
          resolveExit(null);
        }
      }, 1000);
      if (timer.unref) timer.unref();
    });

    // Tail the stderr sidecar from its current size — we only want bytes
    // written after adoption (predecessor already captured everything before).
    let stopStderrTail: (() => void) | undefined;
    try {
      // Append a marker line so post-mortem clearly shows where handoff
      // happened in the captured log.
      appendStderrMarker(
        worker.processing_path,
        `--- adopted by daemon pid=${process.pid} at ${new Date().toISOString()} ---`
      );
    } catch {}
    try {
      stopStderrTail = tailStderrSink(
        worker.stderr_sidecar,
        () => { /* adopted workers — no stdout liveness signal, file mtime
                   is the only fallback. Tail purely retains the bytes. */ }
      );
    } catch {}

    const handle: ActiveWorkerHandle = {
      pid: worker.pid,
      section,
      processingPath: worker.processing_path,
      exited,
      isExited: () => workerExited,
      started_at: worker.started_at,
      adopted: true,
      stopStderrTail,
    };
    activeWorkerHandles.set(worker.processing_path, handle);
    activeWorkers.set(section.name, (activeWorkers.get(section.name) ?? 0) + 1);

    // On exit, decrement activeWorkers and drain inbox so blocked tasks
    // get picked up. Output routing happens through the standard output
    // watcher attached below.
    exited.then(() => {
      activeWorkerHandles.delete(worker.processing_path);
      const cur = activeWorkers.get(section.name) ?? 1;
      activeWorkers.set(section.name, Math.max(0, cur - 1));
      // Drain only if we have a way to spawn — orphan sections never spawn.
      if (!section.orphan) {
        try { drainInbox(section); } catch {}
      }
    });

    log("worker_adopted", {
      line: config.name,
      station: section.name,
      pid: worker.pid,
      workpiece: worker.workpiece_id || basename(worker.processing_path),
    });
  }

  // Recover any stale workpieces in processing/ directories from previous run.
  // Adopted workers' processing/ files are filtered out via the live-worker
  // check inside recoverStaleProcessing (findWorkerForWorkpiece).
  const recovery = await recoverStaleProcessing(sections, lineQueue.error, log);
  if (recovery.recovered > 0 || recovery.errors > 0) {
    log("stale_recovery_complete", {
      recovered: recovery.recovered,
      errors: recovery.errors,
    });
  }

  // Sweep orphaned retry sidecars across every queue. A sidecar without its
  // companion workpiece.json can only mislead the dashboard (stale countdown,
  // phantom "in_backoff: true") so nuke them before the first poll.
  let sidecarsRemoved = 0;
  const sweepDirs: string[] = [
    lineQueue.inbox,
    lineQueue.held,
    lineQueue.done,
    lineQueue.error,
    lineQueue.review,
  ];
  for (const section of sections) {
    sweepDirs.push(section.queue.inbox, section.queue.processing, section.queue.output);
  }
  for (const d of sweepDirs) sidecarsRemoved += cleanupOrphanedRetryStates(d);
  if (sidecarsRemoved > 0) {
    log("retry_sidecar_cleanup", { removed: sidecarsRemoved });
  }

  // Sweep orphan `.envelope.json.tmp` files. The envelope-write protocol
  // (llm.ts) tells the agent to Write to ${envelopePath}.tmp then mv into
  // place. If the worker dies between those two tool calls — exactly what
  // a station hang produces — the .tmp lingers forever. Anything older
  // than ENVELOPE_TMP_TTL_MS is past any legitimate Write-to-mv gap.
  const ENVELOPE_TMP_TTL_MS = 60 * 60 * 1000; // 1 hour
  let envelopeTmpsRemoved = 0;
  for (const section of sections) {
    try {
      for (const entry of readdirSync(section.queue.processing)) {
        if (!entry.endsWith(".envelope.json.tmp")) continue;
        const path = resolve(section.queue.processing, entry);
        try {
          const ageMs = Date.now() - statSync(path).mtimeMs;
          if (ageMs >= ENVELOPE_TMP_TTL_MS) {
            unlinkSync(path);
            envelopeTmpsRemoved++;
          }
        } catch {}
      }
    } catch {}
  }
  if (envelopeTmpsRemoved > 0) {
    log("envelope_tmp_cleanup", { removed: envelopeTmpsRemoved });
  }

  // Auto-archive old errors (>7 days)
  try {
    const archiveResult = autoArchiveOld(linePath);
    if (archiveResult.archived > 0) {
      log("auto_archive_old_errors", { archived: archiveResult.archived });
    }
  } catch (err) {
    log("auto_archive_error", { error: (err as Error).message });
  }

  log("orchestrator_start", { line: config.name, stations: sequence });

  // Set when stop() begins. Used to: (a) suppress idle-watchdog SIGTERMs
  // (the shutdown sequence owns the kill), (b) tell spawnWorker not to start
  // anything new, (c) tell the output-watcher to skip the retry/error_bucket
  // path for `aborted` results so they re-run cleanly on the next boot.
  let isShuttingDown = false;

  // Pending retry-backoff timers. Cleared in stop() so deferred callbacks
  // don't fire after the line directory has been torn down (and to release
  // any timer-keeping-event-loop-alive references on test cleanup).
  const pendingRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  // Output-watcher dedup. Linux inotify can fire `rename` twice for the same
  // file under load (and stale-recovery on a fresh daemon also racy-double-fires
  // when an old worker's output appears just as the new daemon starts). Without
  // this guard the second fire would re-enter the retry/error_bucket path,
  // producing phantom dashboard events for the same logical failure. Key by
  // workpiece+station+mtime; treat sub-millisecond mtime deltas as the same
  // file. TTL keeps the map bounded.
  const recentlyHandledOutput = new Map<string, number>(); // key → mtime_ms
  const RECENT_OUTPUT_TTL_MS = 30_000;
  function gcRecentlyHandled(now: number) {
    if (recentlyHandledOutput.size < 64) return; // cheap fast-path
    for (const [k, ts] of recentlyHandledOutput) {
      if (now - ts > RECENT_OUTPUT_TTL_MS) recentlyHandledOutput.delete(k);
    }
  }

  // (Usage-gate state already declared up top; lazily reused by drainInbox.)

  // --- Watchers ---

  const stopFns: (() => void)[] = [];

  // Periodic flow-snapshot writer — accumulates flow.jsonl for future analysis.
  const flowWriter = startFlowSnapshotWriter(linePath, sequence, {
    onError: (err) => log("flow_snapshot_error", { error: err.message }),
  });
  stopFns.push(() => flowWriter.stop());

  // 1. Watch line inbox — new tasks dropped here.
  //    watchFolder adds a 10 s safety-net rescan so bursts that inotify
  //    drops are still picked up (claimFile makes re-fires idempotent).
  //
  //    Order matters: enrich the raw {task, input} INTO a full workpiece
  //    while the file is still in the line inbox (atomic tmp+rename),
  //    THEN claim it into sections[0].queue.inbox. The previous order —
  //    claim first, then write the enriched body — opened a race where
  //    the section-inbox watcher fired the moment claimFile renamed the
  //    file in, spawning a worker on the raw {task, input} body. The
  //    line-inbox handler then re-wrote the enriched workpiece at the
  //    same path (Bun.write recreates the file even after the worker
  //    moved the original to processing/), and the section-inbox watcher
  //    fired *again* — spawning a second worker on the same logical task.
  //    The result was two task_done events and two fanouts per discovery.
  const stopLineInbox = watchFolder(lineQueue.inbox, async (filePath) => {
    try {
      if (!existsSync(filePath)) return; // raced against another firing

      // Producer-allowlist check. Files in this inbox should have been
      // recorded by an authorized writer (CLI enqueue, fanout, single-task
      // trigger, held release, or bootstrap). Anything else is moved to
      // .unverified/ and logged. See src/emit-manifest.ts.
      const fileName = basename(filePath);
      if (!isEmitted(lineQueue.inbox, fileName)) {
        const dest = quarantineUnverified(lineQueue.inbox, filePath);
        log("producer_unknown", {
          line: config.name,
          queue: "line_inbox",
          filename: fileName,
          quarantined_to: dest,
        });
        return;
      }

      const raw = JSON.parse(await Bun.file(filePath).text());

      try {
        validateInboxPayloadVersion(raw as Record<string, unknown>);
      } catch (err) {
        if (err instanceof UnsupportedSchemaVersionError) {
          moveFile(filePath, lineQueue.error);
          log('unsupported_schema_version', {
            file: basename(filePath),
            got: err.got,
            supported: err.supported,
            queue: 'line_inbox',
          });
          return;
        }
        throw err;
      }

      if (!raw.id) {
        // Raw task — enrich into a full workpiece in place. Atomic via
        // tmp + rename so a concurrent firing either sees the raw shape
        // (and races on the same write — last writer wins, identical
        // content) or the enriched shape (and skips this branch).
        const workpiece = createWorkpiece(
          config.name,
          raw.task ?? "(no task)",
          raw.input ?? {}
        );
        const tmp = `${filePath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(workpiece, null, 2));
        renameSync(tmp, filePath);
        log("task_received", {
          workpiece: workpiece.id,
          task: workpiece.task.slice(0, 80),
        });
      } else {
        log("task_received", {
          workpiece: raw.id,
          task: (raw.task ?? "").slice(0, 80),
        });
      }

      // Now atomically move the enriched workpiece into the first
      // station's inbox. claimFile is the de-duplication point: if a
      // concurrent firing got here first, this returns null and we exit.
      const claimed = claimFile(filePath, sections[0].queue.inbox);
      if (!claimed) return;
      // Record the section-inbox transition so drainInbox accepts the file.
      recordEmit(sections[0].queue.inbox, basename(claimed), "transition");

      // Drain first station's inbox (respects concurrency limits)
      drainInbox(sections[0]);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // file vanished between firings
      log("error", { error: (err as Error).message, source: "line_inbox" });
    }
  });
  stopFns.push(stopLineInbox);

  // 2. Watch each section's output — route to next section or done/error.
  // Orphan sections (not in the current sequence) use dynamic routing: at
  // routing time we find the highest-indexed `done` station in the new
  // sequence and route to the one after.
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    // For sections in the live sequence, the next section is the next
    // non-orphan in sections[]. Orphans were appended at the end and must
    // not be selected as a forward destination — they accept only inbound
    // routing from another orphan, not from live sections.
    let nextSection: SectionInfo | null = null;
    if (!section.orphan) {
      for (let j = i + 1; j < sections.length; j++) {
        if (!sections[j].orphan) { nextSection = sections[j]; break; }
      }
    }

    // Resolve the destination section for an orphan output. Returns:
    //   { kind: "next", section }     — route to this live section's inbox
    //   { kind: "done" }              — workpiece is finished, route to done/
    //   { kind: "review" }            — degenerate (no live sections), park
    type OrphanRoute =
      | { kind: "next"; section: SectionInfo }
      | { kind: "done" }
      | { kind: "review" };
    function resolveOrphanNext(workpiece: Workpiece): OrphanRoute {
      let sawLiveSection = false;
      for (const liveSection of sections) {
        if (liveSection.orphan) continue;
        sawLiveSection = true;
        const sr = workpiece.stations[liveSection.name];
        if (!sr || sr.status !== "done") {
          return { kind: "next", section: liveSection };
        }
      }
      // Every live section is `done` for this workpiece. If the new sequence
      // is empty (degenerate config), park in review for human triage; else
      // the workpiece is genuinely finished.
      return sawLiveSection ? { kind: "done" } : { kind: "review" };
    }

    // 3. Watch each section's inbox — drop-in recovery, manual re-enqueue,
    //    or an external writer needs to wake the station. Skip for orphan
    //    sections — by definition we never spawn workers there.
    if (!section.orphan) {
      const stopInbox = watchFolder(section.queue.inbox, () => {
        try {
          drainInbox(section);
        } catch (err) {
          log("error", {
            error: (err as Error).message,
            source: `section_inbox:${section.name}`,
          });
        }
      });
      stopFns.push(stopInbox);
    }

    const stopOutput = watchFolder(
      section.queue.output,
      async (filePath) => {
        try {
          // Idempotency guard: same (workpiece, station, mtime) within the
          // recent window is a no-op. Linux inotify can fire `rename` twice
          // for the same write, and stale-recovery on a fresh daemon can also
          // double-route an output. Without this guard, a single failure can
          // generate `retry` AND `error_bucket` events for the same logical
          // event (counter incremented twice).
          let mtime = 0;
          try { mtime = statSync(filePath).mtimeMs; } catch {
            // File vanished between watcher fire and stat — nothing to do.
            return;
          }
          const workpiece = await readFromQueue(filePath);
          const stationResult = workpiece.stations[section.name];
          const wpId = workpiece.id;
          const fileName = basename(filePath);

          const dedupKey = `${wpId}:${section.name}`;
          const lastMtime = recentlyHandledOutput.get(dedupKey);
          if (lastMtime !== undefined && Math.abs(mtime - lastMtime) < 1) {
            log("output_watcher_duplicate_ignored", {
              station: section.name,
              workpiece: wpId,
              mtime,
            });
            return;
          }
          recentlyHandledOutput.set(dedupKey, mtime);
          gcRecentlyHandled(Date.now());

          if (stationResult?.status === "failed") {
            // Failed — retry or error bucket based on failure class policy
            const retryKey = `${wpId}:${section.name}`;
            // Effective retry count: prefer the in-memory counter, but if it's
            // missing (we restarted after the prior attempts and the Map was
            // wiped) fall back to counting persisted history on the workpiece.
            // Without this fallback, an externally-killed daemon resets every
            // workpiece's retry budget to 0 on restart — turning transient
            // failures into infinite loops (revpj3 hit 161 timeout retries
            // across one 12-hour run because of this).
            const persistedAttempts =
              (stationResult.previous_attempts?.length ?? 0) +
              (workpiece._retry_history?.[section.name]?.length ?? 0);
            const retries = retryCounts.get(retryKey) ?? persistedAttempts;
            const failureClass: FailureClass = stationResult.failure_class ?? "unknown";
            const decision = decideRetry(failureClass, retries, retryPolicy);

            if (decision.action === "retry") {
              retryCounts.set(retryKey, retries + 1);
              const delay = decision.delay_s * 1000;

              // Write retry sidecar for dashboard visualization
              const classPolicy = retryPolicy[failureClass] ?? retryPolicy.unknown;
              writeRetryState(filePath, {
                retry_count: retries + 1,
                max_retries: classPolicy.maxRetries,
                failure_class: failureClass,
                in_backoff: true,
                backoff_until: new Date(Date.now() + delay).toISOString(),
                exhausted: false,
              });

              log("retry", {
                station: section.name,
                workpiece: wpId,
                attempt: decision.attempt,
                delay_s: decision.delay_s,
                failure_class: failureClass,
                error: stationResult.summary?.slice(0, 80),
              });

              // Wait then move back to inbox
              const retryTimer = setTimeout(async () => {
                pendingRetryTimers.delete(retryTimer);
                try {
                  // Source file may already be gone — moved to error/ by a
                  // racing dedup-miss, deleted by stale-recovery on a fresh
                  // daemon, or rotated. The in-memory workpiece copy is no
                  // longer authoritative, so writing to inbox would clone
                  // stale state and re-trigger the station unnecessarily.
                  if (!existsSync(filePath)) {
                    log("retry_source_gone", {
                      station: section.name,
                      workpiece: wpId,
                      reason: "output_file_disappeared",
                    });
                    return;
                  }
                  if (isShuttingDown) {
                    // Daemon is mid-shutdown — the abort sweep will handle it.
                    return;
                  }
                  // Stash the failed station result into _retry_history so
                  // writeStation can fold it into previous_attempts on the
                  // next successful (or failed) run.
                  const prev = workpiece.stations[section.name];
                  const priorAttempts = prev.previous_attempts ?? [];
                  const { previous_attempts: _drop, ...flatPrev } = prev;
                  workpiece._retry_history = workpiece._retry_history ?? {};
                  workpiece._retry_history[section.name] = [...priorAttempts, flatPrev as Omit<typeof prev, "previous_attempts">];
                  delete workpiece.stations[section.name];

                  const inboxPath = resolve(
                    section.queue.inbox,
                    fileName
                  );
                  await Bun.write(
                    inboxPath,
                    JSON.stringify(workpiece, null, 2)
                  );
                  recordEmit(section.queue.inbox, fileName, "transition");
                  // Move retry sidecar: write at inbox (no longer in backoff), clear from output
                  const classPolicy2 = retryPolicy[failureClass] ?? retryPolicy.unknown;
                  writeRetryState(inboxPath, {
                    retry_count: retryCounts.get(retryKey) ?? 1,
                    max_retries: classPolicy2.maxRetries,
                    failure_class: failureClass,
                    in_backoff: false,
                    exhausted: false,
                  });
                  clearRetryState(filePath);
                  // Remove from output — fresh run will write its own session log.
                  try {
                    require("fs").unlinkSync(filePath);
                  } catch {}
                  try {
                    require("fs").unlinkSync(filePath + ".session.jsonl");
                  } catch {}

                  // Sweep any stale error/ copy of this workpiece from a
                  // prior crash-recovery or daemon restart.
                  const staleErrorPath = resolve(lineQueue.error, fileName);
                  if (existsSync(staleErrorPath)) {
                    log("stale_error_file_cleaned", {
                      station: section.name,
                      workpiece: wpId,
                      reason: "superseded_by_retry",
                    });
                    try { unlinkSync(staleErrorPath); } catch {}
                    try { unlinkSync(staleErrorPath + ".session.jsonl"); } catch {}
                  }

                  drainInbox(section);
                } catch (err) {
                  log("error", {
                    error: (err as Error).message,
                    source: "retry",
                  });
                }
              }, delay);
              pendingRetryTimers.add(retryTimer);
            } else {
              // Retry budget exhausted (or zero for this class) — move to error bucket
              log("error_bucket", {
                station: section.name,
                workpiece: wpId,
                failure_class: failureClass,
                error: stationResult.summary?.slice(0, 80),
              });
              clearRetryState(filePath);
              moveFile(filePath, lineQueue.error);
              retryCounts.delete(`${wpId}:${section.name}`);

              // Spawn on_failure hook if configured
              if (config.on_failure?.script) {
                try {
                  const errorFilePath = resolve(lineQueue.error, basename(filePath));
                  const hookScriptPath = resolve(linePath, config.on_failure.script);
                  const hookProc = Bun.spawn(["bun", "run", hookScriptPath, errorFilePath], {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env },
                    cwd: resolve(linePath, ".."),
                  });
                  const hookStdout = await new Response(hookProc.stdout).text();
                  const hookStderr = await new Response(hookProc.stderr).text();
                  const hookExitCode = await hookProc.exited;
                  if (hookExitCode !== 0) {
                    log("on_failure_hook_error", {
                      workpiece: wpId,
                      script: config.on_failure.script,
                      exit_code: hookExitCode,
                      stderr: hookStderr.slice(0, 200),
                    });
                  } else {
                    log("on_failure_hook_done", {
                      workpiece: wpId,
                      script: config.on_failure.script,
                      output: hookStdout.trim().slice(0, 200),
                    });
                  }
                } catch (hookErr) {
                  log("on_failure_hook_error", {
                    workpiece: wpId,
                    script: config.on_failure.script,
                    error: (hookErr as Error).message,
                  });
                }
              }
            }
          } else if (stationResult?.status === "escalated") {
            // Escalated — move to review queue for human intervention
            const retryKey = `${wpId}:${section.name}`;
            log("escalated", {
              station: section.name,
              workpiece: wpId,
              feedback: (stationResult.eval?.feedback ?? stationResult.summary ?? "").slice(0, 200),
            });
            clearRetryState(filePath);
            moveFile(filePath, lineQueue.review);
            retryCounts.delete(retryKey);
          } else if (stationResult?.status === "done") {
            // Success
            log("station_done", {
              station: section.name,
              workpiece: wpId,
              summary: stationResult.summary?.slice(0, 80),
            });

            clearRetryState(filePath);
            // Clear retry count
            retryCounts.delete(`${wpId}:${section.name}`);

            // For orphan sections, resolve the next destination at routing
            // time using the live sequence. For non-orphan sections, the
            // static `nextSection` from the live-sequence ordering applies.
            let routeToSection: SectionInfo | null = null;
            let routeToReview = false;
            let routeToDone = false;
            if (section.orphan) {
              const orphanRoute = resolveOrphanNext(workpiece);
              if (orphanRoute.kind === "next") {
                routeToSection = orphanRoute.section;
                log("orphan_routed_forward", {
                  from: section.name,
                  to: orphanRoute.section.name,
                  workpiece: wpId,
                });
              } else if (orphanRoute.kind === "done") {
                routeToDone = true;
                log("orphan_completed", {
                  from: section.name,
                  workpiece: wpId,
                });
              } else {
                routeToReview = true;
                log("orphan_parked_in_review", {
                  from: section.name,
                  workpiece: wpId,
                  reason: "no live sections in new sequence",
                });
              }
            } else {
              routeToSection = nextSection;
            }

            if (routeToSection) {
              // Route to next section
              const movedPath = moveFile(filePath, routeToSection.queue.inbox);
              recordEmit(routeToSection.queue.inbox, basename(movedPath), "transition");
              log("routed", {
                from: section.name,
                to: routeToSection.name,
                workpiece: wpId,
              });
              drainInbox(routeToSection);
            } else if (routeToReview) {
              moveFile(filePath, lineQueue.review);
            } else if (routeToDone) {
              moveFile(filePath, lineQueue.done);
              log("task_done", {
                workpiece: wpId,
                summary: stationResult.summary?.slice(0, 80),
                via: "orphan_completion",
              });
              // A predecessor just landed in done/ — re-evaluate every
              // section's inbox so dependents queued anywhere become eligible.
              for (const s of sections) drainInbox(s);
            } else {
              // Last section — move to done
              moveFile(filePath, lineQueue.done);
              log("task_done", {
                workpiece: wpId,
                summary: stationResult.summary?.slice(0, 80),
              });
              for (const s of sections) drainInbox(s);

              // Spawn on_success hook if configured
              if (config.on_success?.script) {
                try {
                  const doneFilePath = resolve(lineQueue.done, basename(filePath));
                  const hookScriptPath = resolve(linePath, config.on_success.script);
                  const hookProc = Bun.spawn(["bun", "run", hookScriptPath, doneFilePath], {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env },
                    cwd: resolve(linePath, ".."),
                  });
                  const hookStdout = await new Response(hookProc.stdout).text();
                  const hookStderr = await new Response(hookProc.stderr).text();
                  const hookExitCode = await hookProc.exited;
                  if (hookExitCode !== 0) {
                    log("on_success_hook_error", {
                      workpiece: wpId,
                      script: config.on_success.script,
                      exit_code: hookExitCode,
                      stderr: hookStderr.slice(0, 200),
                    });
                  } else {
                    log("on_success_hook_done", {
                      workpiece: wpId,
                      script: config.on_success.script,
                      output: hookStdout.trim().slice(0, 200),
                    });
                  }
                } catch (hookErr) {
                  log("on_success_hook_error", {
                    workpiece: wpId,
                    script: config.on_success.script,
                    error: (hookErr as Error).message,
                  });
                }
              }

              // Fire on_complete triggers to downstream lines
              try {
                await triggerDownstream(workpiece, config, linePath, log);
              } catch (triggerErr) {
                log("error", {
                  error: (triggerErr as Error).message,
                  source: "trigger_downstream",
                  workpiece: wpId,
                });
              }
            }
          }
        } catch (err) {
          if (err instanceof UnsupportedSchemaVersionError) {
            try {
              const fileName = basename(filePath);
              moveFile(filePath, lineQueue.error);
              log('unsupported_schema_version', {
                file: fileName,
                got: err.got,
                supported: err.supported,
                queue: `${section.name}_output`,
              });
            } catch {}
            return;
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return;
          log("error", {
            error: (err as Error).message,
            source: `${section.name}_output`,
          });
        }
      }
    );
    stopFns.push(stopOutput);
  }

  /**
   * Spawn a section worker process.
   */
  function spawnWorker(section: SectionInfo, workpiecePath: string) {
    // Don't start anything new mid-shutdown.
    if (isShuttingDown) return;

    // Concurrency gate: if station is at capacity, leave workpiece in inbox
    const active = activeWorkers.get(section.name) ?? 0;
    if (active >= concurrencyLimit) {
      log("queued", {
        station: section.name,
        file: basename(workpiecePath),
        active,
        limit: concurrencyLimit,
      });
      return;
    }

    // Claim from inbox to processing
    const processingPath = claimFile(workpiecePath, section.queue.processing);
    if (!processingPath) {
      log("claim_failed", {
        station: section.name,
        file: basename(workpiecePath),
      });
      return;
    }

    // Clear any retry sidecar from inbox (workpiece now in processing)
    clearRetryState(workpiecePath);
    // Increment active worker count
    activeWorkers.set(section.name, (activeWorkers.get(section.name) ?? 0) + 1);

    log("station_start", {
      station: section.name,
      workpiece: basename(workpiecePath),
    });

    const workerPath = resolve(__dirname, "section-worker.ts");

    // Stderr sidecar: open <processingPath>.stderr.log and pass its fd to
    // Bun.spawn so the kernel writes worker stderr directly to disk. This is
    // what makes adoption work — a successor daemon (after `daemon reload`)
    // can tail the same file from its current size to recover activity. We
    // close our copy of the fd after spawn dup's it.
    const stderrSidecarPath = processingPath + ".stderr.log";
    let stderrFd: number | undefined;
    try {
      stderrFd = require("fs").openSync(stderrSidecarPath, "a");
    } catch {
      stderrFd = undefined;
    }

    const proc = Bun.spawn(["bun", "run", workerPath, section.dir, processingPath], {
      stdout: "pipe",
      stderr: stderrFd !== undefined ? stderrFd : "pipe",
      env: { ...process.env },
      cwd: resolve(options.linePath, ".."),
      detached: true, // setsid() — worker becomes session + process group leader (pgid === pid)
    });

    if (stderrFd !== undefined) {
      try { require("fs").closeSync(stderrFd); } catch {}
    }

    // Register this worker so stop() can signal it for graceful shutdown.
    let workerExited = false;
    const spawnedAt = new Date().toISOString();
    const workerHandle: ActiveWorkerHandle = {
      pid: proc.pid!,
      section,
      processingPath,
      exited: proc.exited,
      isExited: () => workerExited,
      started_at: spawnedAt,
    };
    activeWorkerHandles.set(processingPath, workerHandle);

    // --- Idle timeout watchdog ---
    let lastActivityMs = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    // Async chunk readers — update liveness on each chunk.
    // Started before proc.exited.then() to avoid missing early output.
    (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivityMs = Date.now();
          stdoutChunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {}
    })();

    // Tail the stderr sidecar for liveness + activity capture. When stderr is
    // an fd-backed file (the normal path) we can't read from proc.stderr; the
    // sidecar IS the stderr. When the open failed and we fell back to "pipe",
    // proc.stderr is the readable stream — handle both.
    let stopStderrTail: (() => void) | undefined;
    if (stderrFd !== undefined) {
      stopStderrTail = tailStderrSink(stderrSidecarPath, (chunk: string) => {
        lastActivityMs = Date.now();
        stderrChunks.push(chunk);
      });
      workerHandle.stopStderrTail = stopStderrTail;
    } else {
      (async () => {
        const stderrStream = proc.stderr;
        if (typeof stderrStream === "number" || !stderrStream) return;
        const reader = (stderrStream as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            lastActivityMs = Date.now();
            stderrChunks.push(decoder.decode(value, { stream: true }));
          }
        } catch {}
      })();
    }

    // Tail activity.jsonl for station_heartbeat events from this worker.
    // When the section-worker reports child_live: true, refresh the idle
    // watchdog — this is the primary liveness signal for long-running
    // stations that produce no stdout.
    const stopActivityTail = tailActivityLog(
      section.name,
      basename(workpiecePath),
      () => { lastActivityMs = Date.now(); }
    );
    workerHandle.stopActivityTail = stopActivityTail;

    let idleWatchdog: ReturnType<typeof setInterval> | undefined;
    let maxWallClockTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFired = false;
    let sigkillSent = false;
    const flushGraceMs = (section.flush_grace ?? 30) * 1000;

    function beginKillSequence(reason: string) {
      if (timeoutFired) return; // already in kill sequence
      timeoutFired = true;
      if (idleWatchdog) { clearInterval(idleWatchdog); idleWatchdog = undefined; }
      if (maxWallClockTimer) { clearTimeout(maxWallClockTimer); maxWallClockTimer = undefined; }

      const pid = proc.pid!;
      const groupSize = getProcessGroupSize(pid);

      log("station_timeout", {
        station: section.name,
        workpiece: basename(workpiecePath),
        reason,
        pid,
        pgid: pid,
        group_size: groupSize,
      });

      // SIGUSR1 first — worker's SIGUSR1 handler is the timeout path
      // (gracefulFlush("timeout")). Using SIGUSR1 rather than SIGTERM lets the
      // worker distinguish "orchestrator idle watchdog fired" from "systemd
      // KillMode=control-group cascaded a SIGTERM into me because the daemon
      // is going down" — the latter is an abort, not a timeout, but they're
      // indistinguishable at the worker if both use SIGTERM. systemd never
      // sends SIGUSR1 to a cgroup, so receiving it unambiguously means the
      // orchestrator decided to kill us.
      killProcessGroup(pid, "SIGUSR1");

      sigkillTimer = setTimeout(() => {
        sigkillSent = true;
        killProcessGroup(pid, "SIGKILL");
      }, flushGraceMs);
    }

    if (section.timeout && section.timeout > 0) {
      const idleThresholdMs = section.timeout * 1000;
      const tickMs = Math.min(5_000, idleThresholdMs / 10);

      idleWatchdog = setInterval(() => {
        // During shutdown the kill sequence is owned by stop() — skip the idle
        // watchdog so the activity log doesn't show a misleading "idle timeout"
        // event for workers that are about to be SIGUSR2'd as `aborted`.
        if (isShuttingDown) return;

        // Also check workpiece file mtime as fallback liveness signal
        try {
          const mtime = statSync(processingPath).mtimeMs;
          if (mtime > lastActivityMs) lastActivityMs = mtime;
        } catch {}

        const idleMs = Date.now() - lastActivityMs;
        if (idleMs >= idleThresholdMs) {
          beginKillSequence(`idle timeout after ${Math.floor(idleMs / 1000)}s of no output`);
        }
      }, tickMs);
    }

    if (section.max_wall_clock && section.max_wall_clock > 0) {
      maxWallClockTimer = setTimeout(() => {
        beginKillSequence(`max wall clock ${section.max_wall_clock}s exceeded`);
      }, section.max_wall_clock * 1000);
    }

    // Handle completion asynchronously
    proc.exited.then(async (exitCode) => {
      workerExited = true;
      activeWorkerHandles.delete(processingPath);
      // Clear all timers on completion (normal or killed)
      if (idleWatchdog) clearInterval(idleWatchdog);
      if (maxWallClockTimer) clearTimeout(maxWallClockTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);

      // Small delay to let async chunk readers finish draining
      await new Promise((r) => setTimeout(r, 50));

      // Stop stderr tail and capture any final bytes (tail does a final drain).
      if (stopStderrTail) {
        try { stopStderrTail(); } catch {}
      }

      // Stop activity log tail
      if (stopActivityTail) {
        try { stopActivityTail(); } catch {}
      }

      const stderr = stderrChunks.join('');

      if (stderr.trim()) {
        log("station_stderr", {
          station: section.name,
          stderr: stderr.trim().slice(0, 200),
        });
      }

      // Log timeout-specific activity events
      if (timeoutFired && !existsSync(processingPath)) {
        // Worker handled the SIGTERM and moved the file itself
        if (exitCode === 0) {
          log("station_timeout_flushed", {
            station: section.name,
            workpiece: basename(workpiecePath),
          });
        } else {
          log("station_timeout", {
            station: section.name,
            workpiece: basename(workpiecePath),
            exit_code: exitCode,
          });
        }
      } else if (sigkillSent) {
        log("station_timeout_killed", {
          station: section.name,
          workpiece: basename(workpiecePath),
        });
      }

      // Sidecar with per-tool-use progress events. Rolled up into
      // stations[name].rounds below (for crash recovery) before it's unlinked
      // so operators keep the turn + tool-mix summary even when the worker
      // died without flushing. The raw session log is preserved separately —
      // it's the only record of WHY the worker went silent.
      const progressSidecarPath = processingPath + ".progress.jsonl";

      // If the worker crashed before moving the file out of processing,
      // we need to recover it — write a failure result and move to output
      // so the retry/error logic picks it up.
      if (existsSync(processingPath)) {
        log("worker_crash_recovery", {
          station: section.name,
          exitCode,
          file: basename(processingPath),
        });

        try {
          const raw = asWorkpiece<Workpiece>(JSON.parse(await Bun.file(processingPath).text()));
          validateWorkpieceVersion(raw as unknown as Record<string, unknown>);
          const errorMsg = stderr.trim().slice(0, 200) || `Worker exited with code ${exitCode}`;

          // Write failure status to workpiece. Non-zero exit / signal death =
          // "crash" so the orchestrator retries per the crash policy rather
          // than falling through to the unknown-class default. During a
          // graceful daemon shutdown classify as `aborted` instead — the
          // worker died because we killed it, not because it broke.
          const failureClass: FailureClass = isShuttingDown ? "aborted" : "crash";
          const summary = isShuttingDown
            ? "Station aborted by daemon shutdown"
            : `Worker crashed: ${errorMsg}`;
          raw.stations[section.name] = {
            status: "failed",
            summary,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            model: "unknown",
            tokens: { in: 0, out: 0 },
            cost_usd: 0,
            failure_class: failureClass,
          };

          // Roll up any tool-use events captured before the crash.
          const rounds = computeRoundsFromProgress(progressSidecarPath);
          if (rounds) raw.stations[section.name].rounds = rounds;

          const outputPath = resolve(section.queue.output, basename(processingPath));
          await Bun.write(outputPath, JSON.stringify(raw, null, 2));
          try { require("fs").unlinkSync(processingPath); } catch {}
          // Move the session log (if any) to follow the workpiece.
          const sessionSrc = processingPath + ".session.jsonl";
          if (existsSync(sessionSrc)) {
            try { require("fs").renameSync(sessionSrc, outputPath + ".session.jsonl"); } catch {}
          }
        } catch (recoveryErr) {
          if (recoveryErr instanceof UnsupportedSchemaVersionError) {
            log('unsupported_schema_version', {
              file: basename(processingPath),
              got: recoveryErr.got,
              supported: recoveryErr.supported,
              queue: `${section.name}_processing`,
            });
            try { moveFile(processingPath, lineQueue.error); } catch {}
            return;
          }
          log("recovery_failed", {
            station: section.name,
            error: (recoveryErr as Error).message,
          });
          // Last resort: just move the raw file to error bucket
          try { moveFile(processingPath, lineQueue.error); } catch {}
        }
      }

      // Clean up the summarized progress sidecar. Must run after the
      // rollup above so crash-recovered rounds aren't lost.
      try { unlinkSync(progressSidecarPath); } catch {}

      // Decrement active worker count and drain inbox for waiting workpieces
      const currentActive = activeWorkers.get(section.name) ?? 1;
      activeWorkers.set(section.name, Math.max(0, currentActive - 1));
      drainInbox(section);
    });
  }

  // --- Usage gate (account-wide provider plan limits) ---
  // evaluateAndSnapshot() writes ~/.assembly/usage-status.json for the
  // dashboard panel and returns blocked/not. Throttled at the source
  // (30s write window + 60s fetch cache), so calling it on every
  // drainInbox is cheap. When blocked, we skip spawning and enter a
  // resume-poll loop that re-checks every 60s. State declared at top of
  // function — see comment there.

  function startUsageResumePoll() {
    if (usageResumeTimer) return;
    const resumeProviders = Array.from(
      new Set(sections.map((section) => section.provider ?? "claude-code"))
    );
    usageResumeTimer = setInterval(() => {
      evaluateAndSnapshotForProviders(resumeProviders).then((decision) => {
        if (!decision.blocked) {
          stopUsageResumePoll();
          if (usagePaused) {
            usagePaused = false;
            usagePauseReason = "";
            log("orchestrator_resumed", { line: config.name });
            for (const section of sections) drainInbox(section);
          }
        } else {
          log("orchestrator_still_paused", {
            line: config.name,
            reason: decision.reason,
          });
        }
      }).catch(() => {});
    }, 60_000);
  }

  function stopUsageResumePoll() {
    if (usageResumeTimer) {
      clearInterval(usageResumeTimer);
      usageResumeTimer = null;
    }
  }
  stopFns.push(stopUsageResumePoll);

  /**
   * Check a station's inbox for waiting workpieces and spawn workers
   * up to the concurrency limit.
   *
   * Before spawning, fires the usage gate (fire-and-forget). On a blocked
   * decision, spawning is suppressed for this tick — the 60s resume poll
   * will re-drain when the limit clears.
   */
  function drainInbox(section: SectionInfo) {
    // Orphan sections never spawn new workers — the only reason they exist
    // is to drain an adopted predecessor's processing/ via the output watcher.
    if (section.orphan) return;
    const active = activeWorkers.get(section.name) ?? 0;
    if (active >= concurrencyLimit) return;

    // Producer-allowlist: any inbox file that wasn't recorded by an
    // authorized writer (transition / bootstrap / retry) is moved aside.
    // Section inboxes are populated only via internal claimFile/moveFile,
    // so an unverified file means an external writer (e.g. a Bash-armed
    // station agent) deposited it directly. See src/emit-manifest.ts.
    const allWaiting = listQueue(section.queue.inbox);
    for (const filePath of allWaiting) {
      const fileName = basename(filePath);
      if (!isEmitted(section.queue.inbox, fileName)) {
        const dest = quarantineUnverified(section.queue.inbox, filePath);
        log("producer_unknown", {
          line: config.name,
          queue: `section_inbox:${section.name}`,
          filename: fileName,
          quarantined_to: dest,
        });
      }
    }

    const waiting = listQueue(section.queue.inbox);
    if (waiting.length === 0) return;

    // Fire the gate async; if already paused, skip immediately without
    // waiting — the resume poll owns the transition back to healthy.
    if (usagePaused) return;

    evaluateAndSnapshotForProviders([section.provider ?? "claude-code"]).then((decision) => {
      if (decision.blocked) {
        if (!usagePaused) {
          usagePaused = true;
          usagePauseReason = decision.reason ?? "over threshold";
          log("orchestrator_paused", {
            line: config.name,
            reason: usagePauseReason,
          });
          startUsageResumePoll();
        }
        return;
      }

      // Not blocked — recompute capacity (workers may have finished while
      // the gate was in flight) and spawn.
      const activeNow = activeWorkers.get(section.name) ?? 0;
      if (activeNow >= concurrencyLimit) return;
      const nowWaitingAll = listQueue(section.queue.inbox);
      if (nowWaitingAll.length === 0) return;
      // Dependency gate: drop workpieces whose `dependsOn` keys haven't yet
      // appeared in queues/done/. Blocked tasks stay in inbox; the per-done
      // re-drain (see `moveFile(..., lineQueue.done)` sites) reconsiders
      // them when a predecessor lands.
      const doneKeys = listCompletedTaskKeys(lineQueue.done);
      const nowWaiting = filterReadyByDeps(nowWaitingAll, doneKeys);
      if (nowWaiting.length === 0) return;
      const slotsAvailable = concurrencyLimit === Infinity
        ? nowWaiting.length
        : Math.min(nowWaiting.length, concurrencyLimit - activeNow);
      for (let i = 0; i < slotsAvailable; i++) {
        spawnWorker(section, nowWaiting[i]);
      }
    }).catch((err) => {
      log("usage_gate_error", {
        line: config.name,
        error: (err as Error).message,
      });
    });
  }

  // --- Post-startup inbox scan ---
  // Drain section inboxes for any pre-existing workpieces (e.g. from stale
  // recovery). The per-section inbox watcher above also scans existing files
  // on setup, so this loop is belt-and-braces; keeping it explicit makes the
  // startup drain ordering obvious and covers edge cases where the watcher
  // hasn't fully attached yet. Mid-run drops are handled by the watcher.
  for (const section of sections) {
    drainInbox(section);
  }

  // Graceful shutdown.
  //
  // Order matters in regular shutdown:
  //   1. Set isShuttingDown so spawnWorker, idle watchdog, and the retry
  //      setTimeout all stop initiating new work.
  //   2. Stop watchers (keeps new files from triggering anything).
  //   3. Send SIGUSR2 to every active worker's process group. The worker's
  //      SIGUSR2 handler writes a `failure_class: "aborted"` envelope and
  //      moves the workpiece to output/ — exactly what we want for re-run
  //      on the next daemon boot.
  //   4. Wait up to flush_grace for workers to exit; SIGKILL stragglers.
  //   5. Sweep processing/ for any leftover files (workers that died without
  //      flushing) and write `aborted` for them too, so the next daemon's
  //      stale_recovery doesn't see a half-written failure.
  //
  // In `handoff` mode (called via `assembly daemon reload`), the orchestrator
  // hands its in-flight workers to a successor daemon: skip steps 3-5
  // entirely. Workers keep running detached; their output/ writes will be
  // routed by the successor's watchers.
  async function stop(stopOptions?: StopOptions) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const handoffMode = stopOptions?.handoff === true;
    log("orchestrator_stop", { line: config.name, mode: handoffMode ? "handoff" : "shutdown" });

    // Cancel any pending retry-backoff timers so their deferred callbacks
    // don't fire after the line is torn down. isShuttingDown alone protects
    // against new work, but a setTimeout already scheduled could still fire
    // and try to read state that's about to be deleted.
    for (const t of pendingRetryTimers) {
      try { clearTimeout(t); } catch {}
    }
    pendingRetryTimers.clear();

    for (const fn of stopFns) {
      try { fn(); } catch {}
    }

    // Stop stderr tails — final drain happens inside tailStderrSink stop.
    // We do this for both modes so we don't leak fds/timers; the file itself
    // stays on disk for the successor to re-tail.
    for (const h of activeWorkerHandles.values()) {
      if (h.stopStderrTail) {
        try { h.stopStderrTail(); } catch {}
      }
      if (h.stopActivityTail) {
        try { h.stopActivityTail(); } catch {}
      }
    }

    if (handoffMode) {
      // Done. Workers are still alive, processing/ is untouched. The
      // successor daemon reads the handoff file we wrote elsewhere and
      // adopts these workers.
      return;
    }

    const handles = [...activeWorkerHandles.values()];
    if (handles.length > 0) {
      // Use the longest per-section flush_grace so no worker is killed before
      // its own configured grace window expires.
      const flushGraceMs = Math.max(
        ...handles.map((h) => (h.section.flush_grace ?? 30) * 1000)
      );

      log("orchestrator_stop_signaling_workers", {
        count: handles.length,
        flush_grace_ms: flushGraceMs,
      });

      for (const h of handles) {
        try { killProcessGroup(h.pid, "SIGUSR2"); } catch {}
      }

      const allExited = Promise.all(
        handles.map((h) => h.exited.catch(() => null))
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceTimeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), flushGraceMs);
      });
      const result = await Promise.race([allExited.then(() => "exited" as const), graceTimeout]);
      if (timer) clearTimeout(timer);

      if (result === "timeout") {
        const stragglers = handles.filter((h) => !h.isExited());
        log("orchestrator_stop_sigkill_stragglers", { count: stragglers.length });
        for (const h of stragglers) {
          try { killProcessGroup(h.pid, "SIGKILL"); } catch {}
        }
        // Best-effort wait for the SIGKILLed workers so file descriptors are
        // released before the sweep below reads processing/.
        await Promise.race([
          Promise.all(stragglers.map((h) => h.exited.catch(() => null))),
          new Promise((r) => setTimeout(r, 2_000)),
        ]);
      }
    }

    // Sweep: any processing/ file still present means a worker died without
    // flushing. Write an `aborted` failure and move to output/ so the next
    // daemon's output-watcher routes it through the retry path normally.
    //
    // EXCEPT: if a section-worker process is still alive holding this file
    // (typically another daemon's worker on the same line — e.g. a test
    // daemon that inherited ASSEMBLY_LINE_DIRS and accidentally discovered
    // a production line), do NOT overwrite. Writing an aborted envelope
    // here would corrupt the live worker's in-flight workpiece and trigger
    // a phantom retry against an alive worker, creating a double-spawn
    // race. Same liveness check that recoverStaleProcessing uses on boot.
    for (const section of sections) {
      const remaining = listQueue(section.queue.processing);
      for (const filePath of remaining) {
        try {
          const wp = asWorkpiece<Workpiece>(JSON.parse(await Bun.file(filePath).text()));
          validateWorkpieceVersion(wp as unknown as Record<string, unknown>);
          const sr = wp.stations[section.name];
          // Worker may have already written a result (done or failed) before
          // dying on SIGKILL — don't overwrite, just leave it for the post-
          // shutdown sweep.
          if (sr?.status === "done" || sr?.status === "failed") {
            const outPath = resolve(section.queue.output, basename(filePath));
            try { require("fs").renameSync(filePath, outPath); } catch {}
            continue;
          }
          const livePid = findWorkerForWorkpiece(filePath);
          if (livePid !== null) {
            log("shutdown_sweep_skip", {
              station: section.name,
              workpiece: wp.id,
              reason: "worker_still_alive",
              pid: livePid,
            });
            continue;
          }
          wp.stations[section.name] = {
            status: "failed",
            summary: "Station aborted by daemon shutdown",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            model: "unknown",
            tokens: { in: 0, out: 0 },
            cost_usd: 0,
            failure_class: "aborted",
          };
          const outPath = resolve(section.queue.output, basename(filePath));
          await Bun.write(outPath, JSON.stringify(wp, null, 2));
          try { unlinkSync(filePath); } catch {}
          // Carry the session log + stderr sidecar along.
          for (const suffix of [".session.jsonl", ".stderr.log"]) {
            const sidecarSrc = filePath + suffix;
            if (existsSync(sidecarSrc)) {
              try { require("fs").renameSync(sidecarSrc, outPath + suffix); } catch {}
            }
          }
          log("station_aborted", {
            station: section.name,
            workpiece: wp.id,
            reason: "daemon_shutdown",
          });
        } catch (err) {
          if (err instanceof UnsupportedSchemaVersionError) {
            log('unsupported_schema_version', {
              file: basename(filePath),
              got: err.got,
              supported: err.supported,
              queue: `${section.name}_processing`,
            });
            try {
              moveFile(filePath, lineQueue.error);
            } catch {}
            continue;
          }
          log("station_aborted_error", {
            station: section.name,
            file: basename(filePath),
            error: (err as Error).message,
          });
        }
      }
    }
  }

  /**
   * Build a handoff snapshot for this line. Called by the global orchestrator
   * during `daemon reload` to assemble the full handoff state.
   */
  function getHandoffSnapshot(): { workers: HandoffWorker[]; line: HandoffLineSnapshot } {
    const workers: HandoffWorker[] = [];
    for (const h of activeWorkerHandles.values()) {
      if (h.isExited()) continue;
      let workpieceId = "";
      try {
        // Read workpiece id cheaply for diagnostics — best-effort.
        const raw = require("fs").readFileSync(h.processingPath, "utf-8");
        workpieceId = JSON.parse(raw).id ?? "";
      } catch {}
      workers.push({
        pid: h.pid,
        pgid: h.pid, // detached → pgid === pid
        line_path: linePath,
        line_name: config.name,
        section_name: h.section.name,
        section_dir: h.section.dir,
        processing_path: h.processingPath,
        workpiece_id: workpieceId,
        started_at: h.started_at,
        flush_grace_s: h.section.flush_grace ?? 30,
        timeout_s: h.section.timeout,
        max_wall_clock_s: h.section.max_wall_clock,
        stderr_sidecar: h.processingPath + ".stderr.log",
      });
    }
    const lineSnapshot: HandoffLineSnapshot = {
      line_path: linePath,
      line_name: config.name,
      retry_counts: Object.fromEntries(retryCounts),
      usage_paused: usagePaused,
      usage_pause_reason: usagePaused ? usagePauseReason : undefined,
    };
    return { workers, line: lineSnapshot };
  }

  /** Set of currently-known worker pids — passed to the reaper so it doesn't
   * kill adopted workers (which have PPID=1 after old daemon dies). */
  function getKnownWorkerPids(): Set<number> {
    const pids = new Set<number>();
    for (const h of activeWorkerHandles.values()) {
      if (!h.isExited()) pids.add(h.pid);
    }
    return pids;
  }

  return {
    stop,
    linePath,
    lineConfig: config,
    getHandoffSnapshot,
    getKnownWorkerPids,
  };
}

/**
 * Recover stale workpieces from processing/ directories after an orchestrator restart.
 * For each file in a station's processing/ queue:
 *   - If the station result has status "done": move to output/ (already completed)
 *   - Otherwise: clear any partial result and move to inbox/ for re-processing
 *   - On JSON parse error: move to the line error bucket
 */
export async function recoverStaleProcessing(
  sections: SectionInfo[],
  lineErrorDir: string,
  log: (event: string, detail: Record<string, unknown>) => void
): Promise<{ recovered: number; errors: number }> {
  let recovered = 0;
  let errors = 0;

  for (const section of sections) {
    const processingFiles = listQueue(section.queue.processing);

    for (const filePath of processingFiles) {
      try {
        const workpiece = asWorkpiece<Workpiece>(JSON.parse(
          await Bun.file(filePath).text()
        ));
        validateWorkpieceVersion(workpiece as unknown as Record<string, unknown>);
        const stationResult = workpiece.stations[section.name];
        const progressSidecar = filePath + ".progress.jsonl";

        const livePid = stationResult?.status === "done" ? null : findWorkerForWorkpiece(filePath);

        if (stationResult?.status === "done") {
          // Station completed but file wasn't moved — route via output.
          // Roll up any progress events the worker didn't manage to fold in
          // before dying, then clean up the sidecar.
          if (!stationResult.rounds) {
            const rounds = computeRoundsFromProgress(progressSidecar);
            if (rounds) {
              workpiece.stations[section.name].rounds = rounds;
              await Bun.write(filePath, JSON.stringify(workpiece, null, 2));
            }
          }
          try { unlinkSync(progressSidecar); } catch {}
          // moveFile() carries the session log along if any.
          moveFile(filePath, section.queue.output);
          log("stale_recovery", {
            station: section.name,
            workpiece: workpiece.id,
            action: "routed_to_output",
          });
        } else if (livePid !== null) {
          // An old daemon's worker is still alive holding this file. Don't
          // requeue — that would double-spawn against the same workpiece and
          // race the watcher with two output writes. Leave it; when the old
          // worker exits it will move the file out itself.
          log("stale_recovery_skip", {
            station: section.name,
            workpiece: workpiece.id,
            reason: "worker_still_alive",
            pid: livePid,
          });
          recovered++;
          continue;
        } else {
          // Requeue path — station result is about to be wiped so there's
          // nothing to attach rounds to. Just drop the sidecar.
          try { unlinkSync(progressSidecar); } catch {}
          // Station didn't complete — re-run by moving to inbox.
          // BEFORE wiping the station result, fold its history into
          // workpiece._retry_history so the retry budget survives the
          // restart. Without this, the orchestrator's in-memory retryCounts
          // map starts empty after every daemon restart and an externally
          // killed daemon turns transient failures into infinite loops.
          const prior = workpiece.stations[section.name];
          if (prior) {
            workpiece._retry_history = workpiece._retry_history ?? {};
            const existingHistory = workpiece._retry_history[section.name] ?? [];
            const { previous_attempts, ...flatPrior } = prior;
            const flatPriorAttempts = (previous_attempts ?? []) as typeof existingHistory;
            workpiece._retry_history[section.name] = [
              ...existingHistory,
              ...flatPriorAttempts,
              flatPrior as Omit<typeof prior, "previous_attempts">,
            ];
            delete workpiece.stations[section.name];
          }
          await Bun.write(filePath, JSON.stringify(workpiece, null, 2));
          try { unlinkSync(filePath + ".session.jsonl"); } catch {}
          const requeued = moveFile(filePath, section.queue.inbox);
          recordEmit(section.queue.inbox, basename(requeued), "recovery");
          log("stale_recovery", {
            station: section.name,
            workpiece: workpiece.id,
            action: "requeued_to_inbox",
            history_carried: workpiece._retry_history?.[section.name]?.length ?? 0,
          });
        }
        recovered++;
      } catch (err) {
        if (err instanceof UnsupportedSchemaVersionError) {
          log('unsupported_schema_version', {
            file: basename(filePath),
            got: err.got,
            supported: err.supported,
            queue: `${section.name}_processing`,
          });
          try {
            moveFile(filePath, lineErrorDir);
          } catch {}
          errors++;
          continue;
        }
        log("stale_recovery_error", {
          station: section.name,
          file: basename(filePath),
          error: (err as Error).message,
        });
        // Last resort: move to error bucket
        try {
          moveFile(filePath, lineErrorDir);
        } catch {}
        errors++;
      }
    }
  }

  return { recovered, errors };
}

/**
 * Flatten sequence into ordered station names (simple sequential).
 */
function flattenSequence(config: LineConfig): StationName[] {
  const result: StationName[] = [];
  for (const step of config.sequence) {
    if (typeof step === "string") {
      result.push(StationName(step));
    } else if ("parallel" in step) {
      result.push(...step.parallel.map(StationName));
    } else if ("gate" in step) {
      result.push(StationName(step.gate.if_true));
    } else if ("loop" in step) {
      result.push(...step.loop.stations.map(StationName));
    } else if ("station" in step) {
      result.push(StationName((step as { station: { name: string } }).station.name));
    }
  }
  return result;
}

/**
 * Resolve a dot-notation path against a workpiece.
 * Paths can start with:
 *   - 'input.'  -> walks workpiece.input
 *   - 'task'    -> returns workpiece.task
 *   - anything else -> walks workpiece.stations (e.g., 'recommend.data.top_picks')
 */
export function resolvePath(wp: Workpiece, path: string): unknown {
  const parts = path.split(".");
  let current: any;

  if (parts[0] === "input") {
    current = wp.input;
    parts.shift();
  } else if (parts[0] === "task") {
    if (parts.length === 1) return wp.task;
    current = wp.task;
    parts.shift();
  } else {
    // Default: walk workpiece.stations
    current = wp.stations;
  }

  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Fire on_complete triggers for a completed workpiece.
 * Creates task files in target lines' inbox queues.
 */
export async function triggerDownstream(
  workpiece: Workpiece,
  config: LineConfig,
  linePath: string,
  log: (event: string, detail: Record<string, unknown>) => void
): Promise<void> {
  if (!config.on_complete?.length) return;

  for (const trigger of config.on_complete) {
    // Resolve target line name. `target_path` wins when set; falls back to
    // the static `target` field. Skip the trigger if neither resolves.
    const targetName: string | undefined = (() => {
      if (trigger.target_path) {
        const v = resolvePath(workpiece, trigger.target_path);
        return typeof v === "string" && v.length > 0 ? v : undefined;
      }
      return trigger.target;
    })();
    if (!targetName) {
      log("trigger_skipped", {
        source: config.name,
        target: trigger.target ?? null,
        target_path: trigger.target_path ?? null,
        reason: trigger.target_path
          ? `target_path '${trigger.target_path}' did not resolve to a non-empty string`
          : "no target or target_path on trigger",
      });
      continue;
    }

    // Check condition if specified
    if (trigger.condition) {
      const val = resolvePath(workpiece, trigger.condition);
      if (!val) {
        log("trigger_skipped", {
          source: config.name,
          target: targetName,
          reason: `condition '${trigger.condition}' is falsy`,
        });
        continue;
      }
    }

    // Build the shared `pass` portion of the input. For non-fanout triggers
    // this is the entire input. For fanout triggers it is forwarded to every
    // emitted task alongside the per-element payload.
    const sharedInput: Record<string, unknown> = {
      triggered_by: config.name,
      source_run: workpiece.id,
    };
    if (trigger.pass) {
      for (const [inputKey, wpPath] of Object.entries(trigger.pass)) {
        sharedInput[inputKey] = resolvePath(workpiece, wpPath);
      }
    }

    // Resolve target inbox path (sibling line directory) once.
    const targetInbox = resolve(linePath, "..", targetName, "queues", "inbox");
    mkdirSync(targetInbox, { recursive: true });

    // Fan-out path — emit one downstream task per element of the source array.
    // Each task gets `input[as] = [element]` so downstream stations whose
    // contract is "array of seeds" continue to work without changes.
    if (trigger.fanout) {
      const sourceArr = resolvePath(workpiece, trigger.fanout.over);
      if (!Array.isArray(sourceArr) || sourceArr.length === 0) {
        log("trigger_skipped", {
          source: config.name,
          target: targetName,
          reason: `fanout.over '${trigger.fanout.over}' did not resolve to a non-empty array`,
        });
        continue;
      }

      const baseTs = Date.now();
      let emitted = 0;
      for (let i = 0; i < sourceArr.length; i++) {
        const element = sourceArr[i];
        const input: Record<string, unknown> = {
          ...sharedInput,
          [trigger.fanout.as]: [element],
          fanout_index: i,
          fanout_total: sourceArr.length,
        };
        // Stable, collision-free filename even when many tasks fan out in the
        // same millisecond.
        const taskFileName = `task-${baseTs}-${i.toString().padStart(3, "0")}-from-${config.name}.json`;
        await Bun.write(
          resolve(targetInbox, taskFileName),
          JSON.stringify(
            {
              schema_version: CURRENT_INBOX_PAYLOAD_VERSION,
              task: `Triggered by ${config.name} (${workpiece.id}) — fanout ${i + 1}/${sourceArr.length}`,
              input,
            },
            null,
            2
          )
        );
        recordEmit(targetInbox, taskFileName, "fanout");
        emitted++;
      }

      log("trigger_fired", {
        source: config.name,
        target: targetName,
        workpiece: workpiece.id,
        fanout: { over: trigger.fanout.over, count: emitted, as: trigger.fanout.as },
      });
      continue;
    }

    // Single-task path — original behaviour preserved.
    const taskFileName = `task-${Date.now()}-from-${config.name}.json`;
    const taskFilePath = resolve(targetInbox, taskFileName);
    await Bun.write(
      taskFilePath,
      JSON.stringify(
        {
          schema_version: CURRENT_INBOX_PAYLOAD_VERSION,
          task: `Triggered by ${config.name} (${workpiece.id})`,
          input: sharedInput,
        },
        null,
        2
      )
    );
    recordEmit(targetInbox, taskFileName, "trigger");

    log("trigger_fired", {
      source: config.name,
      target: targetName,
      workpiece: workpiece.id,
      input_keys: Object.keys(sharedInput),
    });
  }
}
