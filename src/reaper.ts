/**
 * Orphan reaper — periodically scans /proc for orphaned claude/MCP processes
 * (PPID=1) and kills them. Belt-and-suspenders for the process-group kill:
 * catches double-forked daemons or processes that called setsid() themselves.
 *
 * Linux-only. On non-Linux, logs a one-time warning and returns a no-op handle.
 */

import { readdirSync, readFileSync, existsSync } from "fs";

// ─── Types ─────────────────────────────────────────────────────────

export interface ReapedProcess {
  pid: number;
  comm: string;
  ppid: number;
  startTimeJiffies: number;
}

export interface ReaperHandle {
  stop: () => void;
}

// ─── Constants ─────────────────────────────────────────────────────

/**
 * Clock ticks per second. On all modern Linux kernels this is 100.
 * Used to convert /proc/<pid>/stat starttime (field 22) from jiffies to seconds.
 */
const CLK_TCK = 100;

// ─── Core scan logic ──────────────────────────────────────────────

/**
 * Perform a single orphan-reaping scan of /proc.
 * Exported for testability — the timer-based startOrphanReaper calls this internally.
 *
 * Finds processes where:
 *   1. PPID === 1 (orphaned / re-parented to init)
 *   2. comm matches binaryAllowlist
 *   3. Process age > olderThanMs
 *
 * Sends SIGKILL to each match. Returns the list of reaped processes.
 */
export function scanAndReap(opts: {
  binaryAllowlist: RegExp;
  olderThanMs: number;
  /**
   * Set of pids the caller wants protected from reaping — and any process
   * whose ppid is in this set (so a worker's child claude/MCP processes are
   * also safe even though their name matches the allowlist). After
   * `daemon reload` the adopted section-workers are PPID=1, which would
   * NOT match the allowlist for `bun` itself, but their `claude` children
   * matching the allowlist must still be protected.
   */
  protectedPids?: Set<number>;
}): ReapedProcess[] {
  const { binaryAllowlist, olderThanMs } = opts;
  const protectedPids = opts.protectedPids ?? new Set<number>();

  // Bail on non-Linux — /proc doesn't exist
  if (!existsSync("/proc/uptime")) {
    return [];
  }

  const reaped: ReapedProcess[] = [];

  try {
    // Read system uptime (seconds since boot)
    const uptimeStr = readFileSync("/proc/uptime", "utf-8");
    const uptimeSeconds = parseFloat(uptimeStr.split(" ")[0]);
    const nowMs = Date.now();

    const entries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));

    for (const entry of entries) {
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf-8");

        // Parse /proc/<pid>/stat
        // Field 2 (comm) is enclosed in parens and can contain spaces/parens
        const openParen = stat.indexOf("(");
        const closeParen = stat.lastIndexOf(")");
        if (openParen === -1 || closeParen === -1) continue;

        const comm = stat.slice(openParen + 1, closeParen);
        const afterComm = stat.slice(closeParen + 2).split(" ");

        // After closing paren (0-indexed from afterComm):
        //   [0]=state(3), [1]=ppid(4), [2]=pgrp(5), ... [19]=starttime(22)
        const ppid = parseInt(afterComm[1], 10);
        const startTimeJiffies = parseInt(afterComm[19], 10);
        const pid = parseInt(entry, 10);

        // Filter 1: must be orphaned (PPID === 1)
        if (ppid !== 1) continue;

        // Filter 1b: never reap a pid the daemon has claimed, nor any
        // process whose parent the daemon has claimed. Adopted workers
        // after `daemon reload` are PPID=1 but listed in protectedPids;
        // a freshly-spawned worker's `claude` child has the worker as
        // ppid (so ppid !== 1 → already skipped above), but if the worker
        // was adopted, its child claude inherited ppid=workerPid which IS
        // in protectedPids — covered here.
        if (protectedPids.has(pid)) continue;
        if (protectedPids.has(ppid)) continue;

        // Filter 2: comm must match the allowlist
        if (!binaryAllowlist.test(comm)) continue;

        // Filter 3: process must be older than olderThanMs
        const startTimeSeconds = startTimeJiffies / CLK_TCK;
        // Wall-clock time when the process started
        const processStartMs = nowMs - (uptimeSeconds - startTimeSeconds) * 1000;
        const ageMs = nowMs - processStartMs;

        if (ageMs < olderThanMs) continue;

        // All filters passed — kill the orphan
        try {
          process.kill(pid, "SIGKILL");
        } catch (err: any) {
          // ESRCH = already dead, EPERM = can't kill (shouldn't happen for our own children)
          if (err?.code !== "ESRCH") continue;
        }

        reaped.push({ pid, comm, ppid, startTimeJiffies });
      } catch {
        // Process may have exited between readdir and stat read — skip
      }
    }
  } catch {
    // /proc read failed entirely — nothing we can do
  }

  return reaped;
}

// ─── Timer-based reaper ───────────────────────────────────────────

/**
 * Start a periodic orphan reaper.
 *
 * @param opts.intervalMs     Scan interval in ms (default: 300_000 = 5 min)
 * @param opts.binaryAllowlist  Regex for allowed comm names (default: claude, mcp-*, *-mcp-server)
 * @param opts.olderThanMs    Min process age before reaping (default: 60_000 = 1 min)
 * @param opts.onReap         Callback when orphans are reaped
 * @returns Handle with stop() to clear the timer
 */
export function startOrphanReaper(opts?: {
  intervalMs?: number;
  binaryAllowlist?: RegExp;
  olderThanMs?: number;
  onReap?: (reaped: ReapedProcess[]) => void;
  /**
   * Called on every tick. Returned pids (and processes parented by them) are
   * protected from reaping. Used to keep adopted workers and their LLM
   * children alive across `daemon reload`.
   */
  getProtectedPids?: () => Set<number>;
}): ReaperHandle {
  const intervalMs = opts?.intervalMs ?? 300_000;
  const binaryAllowlist = opts?.binaryAllowlist ?? /^(claude|mcp-.*|.*-mcp-server)$/;
  const olderThanMs = opts?.olderThanMs ?? 60_000;
  const onReap = opts?.onReap;
  const getProtectedPids = opts?.getProtectedPids;

  // Non-Linux: log once and return no-op
  if (!existsSync("/proc/uptime")) {
    console.warn(
      "[reaper] /proc not available — orphan reaper disabled (non-Linux)"
    );
    return { stop: () => {} };
  }

  const timer = setInterval(() => {
    const protectedPids = getProtectedPids ? getProtectedPids() : undefined;
    const reaped = scanAndReap({ binaryAllowlist, olderThanMs, protectedPids });
    if (reaped.length > 0 && onReap) {
      onReap(reaped);
    }
  }, intervalMs);

  // Don't let the reaper timer keep the process alive
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
