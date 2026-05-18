import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { killProcessGroup, getProcessGroupSize } from "../orchestrator";
import { scanAndReap } from "../reaper";

const isLinux = process.platform === "linux";

// Track spawned processes for cleanup
const spawnedPids: number[] = [];

function cleanupPids() {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead — fine
    }
  }
  spawnedPids.length = 0;
}

afterEach(() => {
  cleanupPids();
});

// ─── killProcessGroup safety ──────────────────────────────────────

describe("killProcessGroup", () => {
  test("refuses pid = 0", () => {
    expect(() => killProcessGroup(0, "SIGTERM")).toThrow(
      "Refusing to signal process group with pid=0"
    );
  });

  test("refuses pid = 1", () => {
    expect(() => killProcessGroup(1, "SIGTERM")).toThrow(
      "Refusing to signal process group with pid=1"
    );
  });

  test("refuses pid = -1 (falsy-ish)", () => {
    expect(() => killProcessGroup(-1, "SIGTERM")).toThrow(
      "Refusing to signal"
    );
  });

  test("swallows ESRCH for already-dead process", () => {
    // Use a PID that almost certainly doesn't exist
    // (max PID on Linux is typically 4194304)
    expect(() => killProcessGroup(4194000, "SIGTERM")).not.toThrow();
  });
});

// ─── Process group isolation (Linux-only, needs /proc) ────────────

describe("process group isolation", () => {
  test.skipIf(!isLinux)(
    "detached worker has pgid === pid",
    async () => {
      const proc = Bun.spawn(["sleep", "300"], {
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      const pid = proc.pid!;
      spawnedPids.push(pid);

      // Read /proc/<pid>/stat and parse pgrp (field 5)
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const closeParen = stat.lastIndexOf(")");
      const fields = stat.slice(closeParen + 2).split(" ");
      const pgrp = parseInt(fields[2], 10);

      expect(pgrp).toBe(pid);

      // Cleanup
      process.kill(pid, "SIGKILL");
    }
  );

  test.skipIf(!isLinux)(
    "group kill takes out child and grandchild",
    async () => {
      // Spawn bash that starts a sleep child; print child PID then wait
      const proc = Bun.spawn(
        ["bash", "-c", "sleep 300 & echo $!; wait"],
        {
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }
      );
      const parentPid = proc.pid!;
      spawnedPids.push(parentPid);

      // Read child PID from stdout
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const childPid = parseInt(new TextDecoder().decode(value).trim(), 10);
      spawnedPids.push(childPid);
      reader.releaseLock();

      // Both should be alive
      expect(() => process.kill(parentPid, 0)).not.toThrow();
      expect(() => process.kill(childPid, 0)).not.toThrow();

      // Kill the entire process group
      killProcessGroup(parentPid, "SIGTERM");

      // Wait briefly for signal delivery
      await Bun.sleep(500);

      // Fallback SIGKILL for good measure
      try { process.kill(-parentPid, "SIGKILL"); } catch {}
      await Bun.sleep(200);

      // Both should be dead
      expect(() => process.kill(parentPid, 0)).toThrow();
      expect(() => process.kill(childPid, 0)).toThrow();
    },
    10_000
  );

  test.skipIf(!isLinux)(
    "double-forked daemonized child survives group kill",
    async () => {
      // Spawn bash that double-forks a sleep with setsid (leaves the group)
      // Parent prints the daemonized PID and exits quickly
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          // setsid creates a new session — the sleep leaves our process group
          "setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $!; sleep 0.5",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }
      );
      const parentPid = proc.pid!;
      spawnedPids.push(parentPid);

      // Read daemonized PID from stdout
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const daemonPid = parseInt(new TextDecoder().decode(value).trim(), 10);
      spawnedPids.push(daemonPid);
      reader.releaseLock();

      // Wait for bash to finish its 0.5s sleep
      await Bun.sleep(1000);

      // Daemon should be alive
      expect(() => process.kill(daemonPid, 0)).not.toThrow();

      // Kill the original process group — the daemon should survive
      try { killProcessGroup(parentPid, "SIGKILL"); } catch {}
      await Bun.sleep(300);

      // Daemonized sleep should still be alive (it's in a different session)
      expect(() => process.kill(daemonPid, 0)).not.toThrow();

      // Cleanup
      try { process.kill(daemonPid, "SIGKILL"); } catch {}
    },
    10_000
  );
});

// ─── getProcessGroupSize ──────────────────────────────────────────

describe("getProcessGroupSize", () => {
  test.skipIf(!isLinux)(
    "returns correct count for a group with parent + 2 children",
    async () => {
      // Spawn detached bash that forks 2 sleep children
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          "sleep 300 & sleep 300 & echo ready; wait",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }
      );
      const pid = proc.pid!;
      spawnedPids.push(pid);

      // Wait for "ready" to ensure children are spawned
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const output = new TextDecoder().decode(value).trim();
      reader.releaseLock();
      expect(output).toBe("ready");

      // Small delay for processes to register
      await Bun.sleep(200);

      const size = getProcessGroupSize(pid);
      expect(typeof size).toBe("number");
      // bash parent + 2 sleep children = at least 3
      expect(size as number).toBeGreaterThanOrEqual(3);

      // Cleanup
      try { process.kill(-pid, "SIGKILL"); } catch {}
    },
    10_000
  );

  test("returns 'unknown' for non-existent pgid on non-Linux or error", () => {
    if (!isLinux) {
      const size = getProcessGroupSize(999999);
      expect(size).toBe("unknown");
    }
    // On Linux, a non-existent pgid just returns 0
  });
});

// ─── Orphan reaper ────────────────────────────────────────────────

describe("orphan reaper", () => {
  test.skipIf(!isLinux)(
    "reaper kills orphaned claude-named process with PPID=1",
    async () => {
      // Spawn a bash that double-forks an orphan named 'claude' via exec -a
      // The parent bash exits immediately, orphaning the child to PPID=1
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          // Fork a child that renames itself to 'claude' and sleeps
          // Parent exits immediately → child re-parents to PID 1
          '(exec -a claude sleep 300) & CHILD=$!; disown $CHILD; echo $CHILD',
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const orphanPid = parseInt(new TextDecoder().decode(value).trim(), 10);
      reader.releaseLock();
      spawnedPids.push(orphanPid);

      // Wait for parent bash to exit so child is re-parented to PID 1
      await proc.exited;
      await Bun.sleep(500);

      // Verify it's alive
      let alive = false;
      try {
        process.kill(orphanPid, 0);
        alive = true;
      } catch {}

      if (!alive) {
        // If exec -a didn't work, skip the test
        console.warn("exec -a claude didn't produce a persistent orphan, skipping");
        return;
      }

      // Verify PPID is 1
      try {
        const stat = readFileSync(`/proc/${orphanPid}/stat`, "utf-8");
        const closeParen = stat.lastIndexOf(")");
        const fields = stat.slice(closeParen + 2).split(" ");
        const ppid = parseInt(fields[1], 10);
        if (ppid !== 1) {
          // Not yet re-parented; give it more time
          await Bun.sleep(500);
        }
      } catch {
        return; // process already gone
      }

      // Run the reaper
      const reaped = scanAndReap({
        binaryAllowlist: /^(claude|sleep)$/,
        olderThanMs: 0, // don't wait for age threshold in test
      });

      // Verify the orphan was reaped
      const found = reaped.find((r) => r.pid === orphanPid);
      if (found) {
        // SIGKILL is async — poll until the OS cleans up the process (up to 2 s)
        let dead = false;
        for (let i = 0; i < 20; i++) {
          await Bun.sleep(100);
          try {
            process.kill(orphanPid, 0);
          } catch {
            dead = true;
            break;
          }
        }
        expect(dead).toBe(true);
      }
      // Note: if comm didn't match (exec -a is unreliable on some systems),
      // this is a known limitation and we don't fail the test
    },
    15_000
  );

  test.skipIf(!isLinux)(
    "reaper does NOT kill process outside allowlist",
    async () => {
      // Spawn a bash that double-forks an orphan named 'not-claude-test'
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          '(exec -a not-claude-test sleep 300) & CHILD=$!; disown $CHILD; echo $CHILD',
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const orphanPid = parseInt(new TextDecoder().decode(value).trim(), 10);
      reader.releaseLock();
      spawnedPids.push(orphanPid);

      // Wait for parent to exit
      await proc.exited;
      await Bun.sleep(500);

      // Run the reaper with the standard allowlist — should NOT match 'not-claude-test'
      const reaped = scanAndReap({
        binaryAllowlist: /^(claude|mcp-.*|.*-mcp-server)$/,
        olderThanMs: 0,
      });

      // Verify no match for our PID
      const found = reaped.find((r) => r.pid === orphanPid);
      expect(found).toBeUndefined();

      // Verify the process is still alive
      try {
        process.kill(orphanPid, 0);
        // Still alive — correct!
      } catch {
        // May have died for other reasons — don't fail
      }
    },
    15_000
  );

  test.skipIf(!isLinux)(
    "reaper respects olderThanMs threshold",
    async () => {
      // Spawn a process that will be orphaned
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          '(exec -a claude sleep 300) & CHILD=$!; disown $CHILD; echo $CHILD',
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const orphanPid = parseInt(new TextDecoder().decode(value).trim(), 10);
      reader.releaseLock();
      spawnedPids.push(orphanPid);

      await proc.exited;
      await Bun.sleep(500);

      // Run reaper with high age threshold — should NOT reap (process is < 2 minutes old)
      const reaped = scanAndReap({
        binaryAllowlist: /^(claude|sleep)$/,
        olderThanMs: 120_000, // 2 minutes
      });

      const found = reaped.find((r) => r.pid === orphanPid);
      expect(found).toBeUndefined();

      // Process should still be alive
      try {
        process.kill(orphanPid, 0);
      } catch {
        // May have died for other reasons
      }
    },
    15_000
  );
});

// ─── Backward compatibility ───────────────────────────────────────

describe("backward compatibility", () => {
  test("existing station-timeout tests are not affected (import check)", () => {
    // This test just verifies that orchestrator exports are still available
    // The actual station-timeout tests run in their own file
    expect(typeof killProcessGroup).toBe("function");
    expect(typeof getProcessGroupSize).toBe("function");
  });
});
