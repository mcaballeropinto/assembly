import {
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { resolve, basename } from "path";
import {
  ORCHESTRATOR_PID_FILE,
  lineSearchDirs,
} from "./paths";
import { startOrchestrator } from "./orchestrator";
import { getFullState } from "./dashboard-data";
import { startOrphanReaper } from "./reaper";
import type { LineConfig } from "./types";
import {
  findLatestHandoff,
  writeHandoffState,
  consumeHandoffState,
  HANDOFF_VERSION,
  type HandoffState,
  type HandoffWorker,
  type HandoffLineSnapshot,
} from "./handoff";

// ─── Types ─────────────────────────────────────────────────────────

export interface ManagedLine {
  linePath: string;
  lineName: string;
  lineConfig: LineConfig;
  stop: (opts?: { handoff?: boolean }) => void | Promise<void>;
  startedAt: string;
  status: "running" | "error";
  error?: string;
  /** Snapshot worker + retry state for the daemon-reload handoff. */
  getHandoffSnapshot?: () => { workers: HandoffWorker[]; line: HandoffLineSnapshot };
  /** Known worker pids — passed to reaper for adoption safety. */
  getKnownWorkerPids?: () => Set<number>;
}

export interface GlobalOrchestratorOptions {
  scanIntervalMs?: number; // hot-reload interval, default 30000
  /**
   * If true, look for a handoff file in ~/.assembly/ and pass it through to
   * each line's startOrchestrator. Set to false in tests that want a clean
   * cold start. Defaults to true.
   */
  consumeHandoffOnStart?: boolean;
}

export interface GlobalOrchestratorHandle {
  stop: (opts?: { handoff?: boolean }) => Promise<void>;
  managedLines: Map<string, ManagedLine>;
  /** Write a handoff state file with the current daemon's pid in the name. */
  writeHandoff: () => string;
}

export interface GlobalState {
  lines: Array<{
    name: string;
    path: string;
    status: "running" | "error";
    error?: string;
    startedAt: string;
    state: {
      line: string;
      sequence: string[];
      lineQueue: { inbox: number; done: number; error: number; errorActive: number; review: number };
      sections: Record<
        string,
        {
          inbox: number;
          processing: number;
          output: number;
          done_total: number;
        }
      >;
      stationTimings?: Record<string, { started_at: string; finished_at?: string; duration_ms?: number; running?: boolean }>;
      pipelineTotalMs?: number | null;
      activity: unknown[];
      completed: unknown[];
      errors: unknown[];
      banner_errors?: unknown[];
      errors_meta?: {
        total_active: number;
        in_banner: number;
        oldest_in_banner_age_ms: number;
        max_banner_age_ms: number;
      };
      errorsDismissed: unknown[];
      health?: { state: string; count: number; detail: string };
      sessionTotals?: {
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
        workpieces: number;
        byStation: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number; count: number }>;
      };
      throughput?: { last_1h: number; last_24h: number };
      timestamp: string;
    } | null;
  }>;
  totals: {
    lines: number;
    linesRunning: number;
    linesErrored: number;
    totalInbox: number;
    totalDone: number;
    totalErrors: number;
    totalReview: number;
    totalCostUsd: number;
    totalThroughput1h: number;
    totalThroughput24h: number;
  };
  timestamp: string;
  version: string;
}

// ─── Discovery ─────────────────────────────────────────────────────

/**
 * Discover all assembly lines from the shared search directories
 * (see `lineSearchDirs` in paths.ts).
 */
export function discoverLines(): string[] {
  const paths: string[] = [];
  for (const dir of lineSearchDirs()) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          existsSync(resolve(dir, entry.name, "line.yaml"))
        ) {
          paths.push(resolve(dir, entry.name));
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  // Deduplicate by resolved path
  return [...new Set(paths)];
}

// ─── Global Orchestrator ───────────────────────────────────────────

/**
 * Start the global orchestrator that manages all discovered lines.
 */
export async function startGlobalOrchestrator(
  options?: GlobalOrchestratorOptions
): Promise<GlobalOrchestratorHandle> {
  // `ASSEMBLY_RELOAD_FROM_PID` is set by an old daemon when it spawns its
  // successor for `daemon reload`. While that env var is set:
  //   - A live PID file pointing at the predecessor is tolerated (we'll
  //     write our own after the predecessor exits).
  //   - We write our PID file only after the predecessor's file disappears,
  //     to keep the "active daemon" pointer single-valued.
  const reloadFromPidRaw = process.env.ASSEMBLY_RELOAD_FROM_PID;
  const reloadFromPid = reloadFromPidRaw ? parseInt(reloadFromPidRaw, 10) : null;

  // 1. PID check — prevent double-start (with reload exception)
  if (existsSync(ORCHESTRATOR_PID_FILE)) {
    try {
      const pidData = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));
      try {
        process.kill(pidData.pid, 0); // throws if not alive
        // PID file points at a live process. The only acceptable reason to
        // proceed is if we're the reload successor and that process is our
        // predecessor.
        if (reloadFromPid !== null && pidData.pid === reloadFromPid) {
          // OK — keep going. We'll write our own PID file after the
          // predecessor removes its own.
        } else {
          throw new Error(
            `Global orchestrator already running (PID: ${pidData.pid}). Use 'assembly daemon stop' first.`
          );
        }
      } catch (err) {
        if ((err as Error).message.includes("already running")) throw err;
        // Stale PID file — clean up and continue
        try {
          unlinkSync(ORCHESTRATOR_PID_FILE);
        } catch {}
      }
    } catch (err) {
      if ((err as Error).message.includes("already running")) throw err;
      // Malformed PID file
      try { unlinkSync(ORCHESTRATOR_PID_FILE); } catch {}
    }
  }

  // 2. Discover lines
  const linePaths = discoverLines();
  if (linePaths.length === 0) {
    throw new Error(
      "No lines discovered. Check ~/.assembly/config.yaml line_dirs or ~/.assembly/lines/."
    );
  }

  // 3. Initialize managed lines
  const managedLines = new Map<string, ManagedLine>();

  // 3a. Load handoff state from a predecessor daemon, if any. We pick up the
  //     newest file in ~/.assembly/handoff-<pid>.json that we can parse and
  //     pass it through to every per-line orchestrator. Adoption happens
  //     inside startOrchestrator (see orchestrator.ts).
  const consumeHandoff = options?.consumeHandoffOnStart !== false;
  let handoff: { path: string; state: HandoffState } | null = null;
  if (consumeHandoff) {
    handoff = findLatestHandoff();
  }

  // 4. Start per-line orchestrators
  for (const linePath of linePaths) {
    await startManagedLine(managedLines, linePath, handoff?.state);
  }

  // After all lines have had their chance to adopt, consume the handoff
  // file so future restarts don't double-adopt.
  if (handoff) {
    consumeHandoffState(handoff.path);
  }

  // 5. Write PID file. In normal cold-start we own it immediately. In reload
  //    mode we wait for the predecessor to remove theirs first (so the
  //    "active daemon" pointer is single-valued at all times), then write
  //    the orchestrator-ready signal, then claim the PID file.
  if (reloadFromPid !== null) {
    const { orchestratorReadyFileFor } = require("./paths");
    const readyPath = orchestratorReadyFileFor(process.pid);
    try { writeFileSync(readyPath, JSON.stringify({ pid: process.pid, predecessor: reloadFromPid, ts: new Date().toISOString() })); } catch {}
    // Poll for predecessor's PID file to disappear (or predecessor to die).
    // Either signal is enough to take over.
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      let predLive = true;
      try { process.kill(reloadFromPid, 0); } catch { predLive = false; }
      let pidFileOwnedByPred = false;
      if (existsSync(ORCHESTRATOR_PID_FILE)) {
        try {
          const cur = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));
          if (cur.pid === reloadFromPid) pidFileOwnedByPred = true;
        } catch {}
      }
      if (!predLive || !pidFileOwnedByPred) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Now write our PID file (atomic via tmp+rename).
    const tmp = `${ORCHESTRATOR_PID_FILE}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid }));
    try { require("fs").renameSync(tmp, ORCHESTRATOR_PID_FILE); } catch {
      // If rename failed, write directly (race is unlikely after the wait).
      writeFileSync(ORCHESTRATOR_PID_FILE, JSON.stringify({ pid: process.pid }));
    }
    // Best-effort: drop the ready file once we own the PID file.
    try { unlinkSync(readyPath); } catch {}
  } else {
    writeFileSync(
      ORCHESTRATOR_PID_FILE,
      JSON.stringify({ pid: process.pid })
    );
  }

  // 5b. Start orphan reaper — kills leaked claude/MCP processes (PPID=1).
  // Protected pids: every active worker pid across every managed line, so
  // adopted workers (PPID=1 after the predecessor daemon exited) and their
  // claude/MCP children are not reaped.
  const reaper = startOrphanReaper({
    onReap: (reaped) => {
      console.log(
        `[daemon] Reaped ${reaped.length} orphan(s): ${reaped.map((r) => `${r.comm}(${r.pid})`).join(", ")}`
      );
    },
    getProtectedPids: () => {
      const all = new Set<number>();
      for (const ml of managedLines.values()) {
        if (ml.getKnownWorkerPids) {
          try {
            for (const pid of ml.getKnownWorkerPids()) all.add(pid);
          } catch {}
        }
      }
      return all;
    },
  });

  // 6. Cleanup handler
  // Only unlink the PID file if it still points at us. Without this guard,
  // a leaked successor daemon that exits later would wipe the canonical
  // pointer — observed when reload-handoff races left multiple daemons
  // running and the strays eventually died (or were killed) under a PID
  // file that meanwhile had been reclaimed by another process.
  const cleanup = () => {
    try {
      const cur = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));
      if (cur?.pid !== process.pid) return;
      unlinkSync(ORCHESTRATOR_PID_FILE);
    } catch {}
  };
  process.on("exit", cleanup);

  // 7. Hot-reload polling — detect added/removed lines
  const scanInterval = setInterval(async () => {
    try {
      const currentPaths = discoverLines();
      const currentSet = new Set(currentPaths);
      const managedSet = new Set(managedLines.keys());

      // Added lines
      for (const linePath of currentPaths) {
        if (!managedSet.has(linePath)) {
          console.log(`[daemon] Added line: ${basename(linePath)}`);
          await startManagedLine(managedLines, linePath);
        }
      }

      // Removed lines
      for (const linePath of managedSet) {
        if (!currentSet.has(linePath)) {
          const ml = managedLines.get(linePath);
          if (ml) {
            console.log(`[daemon] Removed line: ${ml.lineName}`);
            try { await ml.stop(); } catch {}
            managedLines.delete(linePath);
          }
        }
      }
    } catch (err) {
      console.error(
        `[daemon] Hot-reload error: ${(err as Error).message}`
      );
    }
  }, options?.scanIntervalMs ?? 30000);

  // 8. Return handle
  const writeHandoff = (): string => {
    const allWorkers: HandoffWorker[] = [];
    const allLines: HandoffLineSnapshot[] = [];
    for (const ml of managedLines.values()) {
      if (ml.status !== "running" || !ml.getHandoffSnapshot) continue;
      try {
        const snap = ml.getHandoffSnapshot();
        allWorkers.push(...snap.workers);
        allLines.push(snap.line);
      } catch {
        // Best-effort — a snapshot failure for one line shouldn't block reload.
      }
    }
    const state: HandoffState = {
      version: HANDOFF_VERSION,
      old_pid: process.pid,
      handoff_started_at: new Date().toISOString(),
      workers: allWorkers,
      lines: allLines,
    };
    return writeHandoffState(state);
  };

  return {
    stop: async (stopOpts) => {
      reaper.stop();
      clearInterval(scanInterval);
      // Stop all managed lines in parallel so the slowest flush_grace bounds
      // total daemon shutdown time, not the sum of them. In handoff mode the
      // per-line stops are near-instant (no SIGUSR2 sweep).
      await Promise.all(
        [...managedLines.values()].map((ml) =>
          Promise.resolve()
            .then(() => ml.stop(stopOpts))
            .catch(() => {})
        )
      );
      cleanup();
    },
    managedLines,
    writeHandoff,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Start a single managed line orchestrator and add it to the map.
 */
async function startManagedLine(
  managedLines: Map<string, ManagedLine>,
  linePath: string,
  handoffState?: HandoffState
): Promise<void> {
  try {
    const handle = await startOrchestrator({ linePath, handoffState });
    managedLines.set(linePath, {
      linePath,
      lineName: handle.lineConfig.name,
      lineConfig: handle.lineConfig,
      stop: handle.stop,
      startedAt: new Date().toISOString(),
      status: "running",
      getHandoffSnapshot: handle.getHandoffSnapshot,
      getKnownWorkerPids: handle.getKnownWorkerPids,
    });
  } catch (err) {
    managedLines.set(linePath, {
      linePath,
      lineName: basename(linePath),
      lineConfig: { name: basename(linePath), sequence: [] } as LineConfig,
      stop: () => {},
      startedAt: new Date().toISOString(),
      status: "error",
      error: (err as Error).message,
    });
  }
}

/**
 * Get aggregated state across all managed lines.
 */
export async function getGlobalState(
  managedLines: Map<string, ManagedLine>
): Promise<GlobalState> {
  const lines: GlobalState["lines"] = [];
  const totals = {
    lines: 0,
    linesRunning: 0,
    linesErrored: 0,
    totalInbox: 0,
    totalDone: 0,
    totalErrors: 0,
    totalReview: 0,
    totalCostUsd: 0,
    totalThroughput1h: 0,
    totalThroughput24h: 0,
  };

  for (const ml of managedLines.values()) {
    totals.lines++;

    if (ml.status === "running") {
      totals.linesRunning++;
      try {
        const state = await getFullState(ml.linePath);
        if ("error" in state) {
          lines.push({
            name: ml.lineName,
            path: ml.linePath,
            status: ml.status,
            startedAt: ml.startedAt,
            state: null,
          });
        } else {
          const s = state as {
            line: string;
            sequence: string[];
            lineQueue: { inbox: number; done: number; error: number; errorActive: number; review: number };
            sections: Record<
              string,
              {
                inbox: number;
                processing: number;
                output: number;
                done_total: number;
              }
            >;
            stationTimings?: Record<string, { started_at: string; finished_at?: string; duration_ms?: number; running?: boolean }>;
            pipelineTotalMs?: number | null;
            activity: unknown[];
            completed: unknown[];
            errors: unknown[];
            errorsDismissed: unknown[];
            throughput?: { last_1h: number; last_24h: number };
            timestamp: string;
          };
          totals.totalInbox += s.lineQueue.inbox;
          totals.totalDone += s.lineQueue.done;
          totals.totalErrors += s.lineQueue.errorActive;
          totals.totalReview += s.lineQueue.review;
          if (s.throughput) {
            totals.totalThroughput1h += s.throughput.last_1h ?? 0;
            totals.totalThroughput24h += s.throughput.last_24h ?? 0;
          }
          lines.push({
            name: ml.lineName,
            path: ml.linePath,
            status: ml.status,
            startedAt: ml.startedAt,
            state: s,
          });
        }
      } catch {
        lines.push({
          name: ml.lineName,
          path: ml.linePath,
          status: ml.status,
          startedAt: ml.startedAt,
          state: null,
        });
      }
    } else {
      totals.linesErrored++;
      lines.push({
        name: ml.lineName,
        path: ml.linePath,
        status: ml.status,
        error: ml.error,
        startedAt: ml.startedAt,
        state: null,
      });
    }
  }

  return {
    lines,
    totals,
    timestamp: new Date().toISOString(),
  };
}
