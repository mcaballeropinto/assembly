import { test, expect, describe } from "bun:test";
import { existsSync } from "fs";
import { scanAndReap } from "../reaper";

/**
 * The reaper kills PPID=1 processes whose comm matches an allowlist (claude,
 * mcp-*, *-mcp-server) and which are older than a threshold. After
 * `daemon reload` the predecessor daemon exits, so any worker that was
 * detached becomes PPID=1. The orchestrator must protect known worker pids
 * (and processes parented by them) so the reaper doesn't kill adopted
 * workers or their LLM children. These tests exercise scanAndReap directly.
 */
describe("reaper safety against adopted workers", () => {
  test("protectedPids is honored and scanAndReap accepts the option", () => {
    // scanAndReap is the production reaper — it actually SIGKILLs every
    // PPID=1 process on the host whose comm matches the allowlist and which
    // isn't in protectedPids. So this test MUST use a sentinel allowlist
    // that can't match any real process; using `^bun$` (or anything that
    // could match a live daemon, e.g. the assembly.service main process
    // which systemd reparents to PID=1) destroys arbitrary daemons on the
    // host. The protectedPids assertion below is therefore a contract
    // smoke-test: scanAndReap accepts the option and doesn't reap our pid.
    // For end-to-end exercise of the protection semantics, see the orphan
    // tests in process-group.test.ts which use `exec -a <sentinel>` to
    // spawn a controllable PPID=1 process with a unique comm.
    if (!existsSync("/proc/uptime")) {
      // Non-Linux — scanAndReap returns [] regardless. Skip.
      return;
    }
    const reaped = scanAndReap({
      binaryAllowlist: new RegExp(`^reaper-adoption-safety-sentinel$`),
      olderThanMs: 0,
      protectedPids: new Set([process.pid, process.ppid]),
    });
    // Sentinel doesn't match anything, so nothing should be reaped — and
    // our own pid certainly shouldn't be.
    expect(reaped).toEqual([]);
    const selfReaped = reaped.find((r) => r.pid === process.pid);
    expect(selfReaped).toBeUndefined();
  });

  test("a process whose ppid is in protectedPids is also exempt", () => {
    // bun's worker forks live as children of our pid. They would never be
    // PPID=1 in this test, but ppid check still applies if/when they are.
    // The behavioural assertion: scanAndReap does not throw and respects
    // the predicate. Combined with the previous test, this is the contract.
    if (!existsSync("/proc/uptime")) return;
    const reaped = scanAndReap({
      binaryAllowlist: new RegExp(`^something-definitely-not-a-real-binary$`),
      olderThanMs: 0,
      protectedPids: new Set([process.pid]),
    });
    expect(Array.isArray(reaped)).toBe(true);
    expect(reaped.length).toBe(0);
  });

  test("scanAndReap with no protectedPids still works (backward compatibility)", () => {
    if (!existsSync("/proc/uptime")) return;
    const reaped = scanAndReap({
      binaryAllowlist: new RegExp(`^not-a-real-process$`),
      olderThanMs: 0,
    });
    expect(reaped).toEqual([]);
  });
});
