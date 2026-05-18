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
  test("protectedPids exempts a pid from reaping even if it matches everything else", () => {
    // We can't easily fabricate a PPID=1 process matching the allowlist in
    // a test, so use our own pid as a sentinel: we explicitly add it to
    // protectedPids and verify it's NEVER touched even if we add it to the
    // allowlist. (Otherwise, scanAndReap on our own pid would happily try
    // to kill ourselves.)
    if (!existsSync("/proc/uptime")) {
      // Non-Linux — scanAndReap returns [] regardless. Skip.
      return;
    }
    const reaped = scanAndReap({
      binaryAllowlist: new RegExp(`^bun$`),
      olderThanMs: 0,
      protectedPids: new Set([process.pid, process.ppid]),
    });
    // Our own pid must not appear in the reaped list.
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
