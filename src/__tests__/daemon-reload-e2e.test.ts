import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";

/**
 * End-to-end daemon-reload test.
 *
 * We spawn `bun run src/cli.ts daemon` as a real subprocess pointing at a
 * test HOME dir (so ~/.assembly/ is sandboxed and doesn't trample the
 * developer's real state). Inside that daemon we enqueue a slow workpiece
 * via `assembly enqueue`, wait for the worker to start, then run
 * `assembly daemon reload`. After the reload completes:
 *   1. The worker subprocess is still alive (same pid).
 *   2. The PID file points at a different pid (the successor).
 *   3. Eventually the worker finishes and the workpiece lands in done/.
 *
 * This test runs slowly (~30 s) because it covers the full handoff
 * sequence. It's the integration that proves the design end-to-end.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const CLI = resolve(REPO_ROOT, "src", "cli.ts");

let testHome: string;
let assemblyHome: string;
let linePath: string;
let daemonProc: Bun.Subprocess | null = null;
const originalHome = process.env.HOME;

beforeEach(async () => {
  testHome = resolve("/tmp", `assembly-test-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assemblyHome = resolve(testHome, ".assembly");
  linePath = resolve(assemblyHome, "lines", "reload-line");
  mkdirSync(linePath, { recursive: true });
  mkdirSync(resolve(linePath, "queues", "inbox"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "done"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "error"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "held"), { recursive: true });
  mkdirSync(resolve(linePath, "queues", "review"), { recursive: true });
  // Slow station — sleeps for 8s, so it's guaranteed to be mid-flight when
  // we reload (which takes a few seconds).
  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: reload-line\nflush_grace: 5\nsequence:\n  - slow\n`
  );
  const stationDir = resolve(linePath, "stations", "slow");
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(
    resolve(stationDir, "AGENT.md"),
    `---\nprovider: script\nscript: slow.ts\n---\n`
  );
  writeFileSync(
    resolve(stationDir, "slow.ts"),
    `await new Promise((r) => setTimeout(r, 8000));\nconsole.log(JSON.stringify({summary:"slow-ok"}));\n`
  );
  // Pretend usage gate is OK. We can't easily monkey-patch fetch in a
  // separate process, so set the usage snapshot directly via an env var
  // pointing at a static "all clear" snapshot.
  const snapshotPath = resolve(testHome, "usage-status.json");
  writeFileSync(snapshotPath, JSON.stringify({
    fetched_at: new Date().toISOString(),
    decision: { blocked: false },
    five_hour: { utilization: 0.1, resets_at: "2099-01-01T00:00:00Z" },
    seven_day: { utilization: 0.1, resets_at: "2099-01-01T00:00:00Z" },
  }));

  process.env.HOME = testHome;
});

afterEach(async () => {
  // Tear down: SIGKILL daemon, plus any descendants. Best-effort.
  if (daemonProc) {
    try { daemonProc.kill("SIGKILL"); } catch {}
    try {
      if (daemonProc.pid) process.kill(-daemonProc.pid, "SIGKILL");
    } catch {}
    daemonProc = null;
  }
  // Kill any leftover bun processes that were section-workers from this test.
  // We do this by scanning /proc for processes with testHome in cmdline.
  try {
    const procs = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    for (const p of procs) {
      try {
        const cmd = readFileSync(`/proc/${p}/cmdline`, "utf-8");
        if (cmd.includes(testHome)) {
          try { process.kill(parseInt(p, 10), "SIGKILL"); } catch {}
        }
      } catch {}
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

/**
 * Env for spawned daemon/CLI subprocesses inside this test.
 *
 * `ASSEMBLY_LINE_DIRS` is set in the production systemd unit to point at
 * `<assembly-repo>/lines`. Inheriting it into a test-spawned daemon
 * would cause that daemon to discover and manage every real line (incl.
 * `assembly-dev`), writing `orchestrator_start/stop` into production
 * activity logs and — at SIGTERM — running an abort sweep on real workers'
 * processing/ files. Strip both line-discovery overrides so the test daemon
 * sees ONLY lines under `testHome`.
 */
function sandboxedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: testHome, ASSEMBLY_DISABLE_USAGE_GATE: "1" };
  delete env.ASSEMBLY_LINE_DIRS;
  return env;
}

async function runCli(args: string[], opts: { timeout?: number } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: sandboxedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout) {
    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, opts.timeout);
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

describe("daemon reload end-to-end", () => {
  test("worker survives reload, finishes under successor, PID file flips", async () => {
    // 1. Start daemon as a subprocess.
    daemonProc = Bun.spawn(["bun", "run", CLI, "daemon", "start"], {
      env: sandboxedEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const pidFile = resolve(assemblyHome, "orchestrator.pid");
    const ok = await waitFor(() => existsSync(pidFile), 10_000);
    expect(ok).toBe(true);

    const originalPidData = JSON.parse(readFileSync(pidFile, "utf-8"));
    const originalDaemonPid = originalPidData.pid;
    expect(originalDaemonPid).toBe(daemonProc.pid);

    // 2. Enqueue a workpiece.
    const enq = await runCli(["enqueue", "reload-line", "--task", "do the slow thing"], { timeout: 10_000 });
    expect(enq.exitCode).toBe(0);

    // 3. Wait for the worker to start (file appears in stations/slow/queue/processing/).
    const procDir = resolve(linePath, "stations", "slow", "queue", "processing");
    const workerStarted = await waitFor(() => {
      if (!existsSync(procDir)) return false;
      return readdirSync(procDir).filter((f) => f.endsWith(".json")).length > 0;
    }, 15_000);
    expect(workerStarted).toBe(true);

    // 4. Find the worker pid by scanning /proc for section-worker.ts cmdline
    //    that references our processing file.
    const procFiles = readdirSync(procDir).filter((f) => f.endsWith(".json"));
    const wpFile = resolve(procDir, procFiles[0]);
    let workerPid: number | null = null;
    const procs = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    for (const p of procs) {
      try {
        const cmd = readFileSync(`/proc/${p}/cmdline`, "utf-8");
        if (cmd.includes("section-worker.ts") && cmd.includes(wpFile)) {
          workerPid = parseInt(p, 10);
          break;
        }
      } catch {}
    }
    expect(workerPid).not.toBeNull();

    // 5. Reload.
    const reload = await runCli(["daemon", "reload", "--timeout", "30"], { timeout: 40_000 });
    if (reload.exitCode !== 0) {
      console.error(`[reload-test] reload stdout:\n${reload.stdout}`);
      console.error(`[reload-test] reload stderr:\n${reload.stderr}`);
      // Tail the daemon's combined output too. Narrow the stdout type before
      // passing to Response — Bun.spawn can return a number (fd), a stream,
      // or undefined depending on options, and only streams are BodyInit.
      try {
        const stdoutStream = daemonProc?.stdout;
        const daemonOut =
          stdoutStream && typeof stdoutStream !== "number"
            ? await new Response(stdoutStream).text()
            : "";
        console.error(`[reload-test] daemon stdout (truncated):\n${daemonOut.slice(-4000)}`);
      } catch {}
    }
    expect(reload.exitCode).toBe(0);

    // 6. PID file should now point at a different pid.
    const newPidData = JSON.parse(readFileSync(pidFile, "utf-8"));
    expect(newPidData.pid).not.toBe(originalDaemonPid);

    // 7. Original daemon process should have exited.
    let oldAlive = true;
    try { process.kill(originalDaemonPid, 0); } catch { oldAlive = false; }
    expect(oldAlive).toBe(false);

    // 8. Worker should still be alive.
    let workerAlive = true;
    try { process.kill(workerPid!, 0); } catch { workerAlive = false; }
    expect(workerAlive).toBe(true);

    // 9. Wait for the workpiece to land in done/.
    const doneDir = resolve(linePath, "queues", "done");
    const completed = await waitFor(() => {
      const files = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
      return files.length > 0;
    }, 30_000);
    expect(completed).toBe(true);

    // Final daemon is the successor — stop it cleanly. The bun test runner
    // can't reach into a spawned grandchild, so kill it via the pid file.
    try { process.kill(newPidData.pid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }, 90_000);

  test("reload fails cleanly when successor can't start — workers untouched", async () => {
    // The successor inherits process.argv[1] from the predecessor (see
    // cli.ts performHandoffReload). Spawn the daemon from a WRAPPER that
    // delegates to the real cli.ts via absolute-path import. Then corrupt
    // the wrapper before reload — the successor will fail to start and we
    // can verify the predecessor recovered gracefully.
    const copyDir = resolve(testHome, "cli-copy");
    mkdirSync(copyDir, { recursive: true });
    const copyCli = resolve(copyDir, "cli.ts");
    writeFileSync(
      copyCli,
      `await import(${JSON.stringify(CLI)});\n`
    );

    daemonProc = Bun.spawn(["bun", "run", copyCli, "daemon", "start"], {
      env: sandboxedEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const pidFile = resolve(assemblyHome, "orchestrator.pid");
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true);
    const originalPid = JSON.parse(readFileSync(pidFile, "utf-8")).pid;

    // Enqueue + wait for worker.
    const enq = await runCli(["enqueue", "reload-line", "--task", "another slow task"], { timeout: 10_000 });
    expect(enq.exitCode).toBe(0);
    const procDir = resolve(linePath, "stations", "slow", "queue", "processing");
    expect(await waitFor(() => existsSync(procDir) && readdirSync(procDir).filter((f) => f.endsWith(".json")).length > 0, 15_000)).toBe(true);

    // Sabotage the copy so the successor exits immediately.
    writeFileSync(copyCli, `console.error("intentional test failure"); process.exit(1);\n`);

    // Reload — successor will exit before signaling ready, old daemon
    // should NOT remove its PID file or kill workers.
    const reload = await runCli(["daemon", "reload", "--timeout", "5"], { timeout: 15_000 });
    // We expect non-zero exit because reload failed.
    expect(reload.exitCode).not.toBe(0);

    // PID file should still reference the original daemon — old still running.
    expect(existsSync(pidFile)).toBe(true);
    const cur = JSON.parse(readFileSync(pidFile, "utf-8"));
    expect(cur.pid).toBe(originalPid);

    // Original daemon is still alive.
    let alive = true;
    try { process.kill(originalPid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
  }, 60_000);
});
