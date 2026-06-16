#!/usr/bin/env bun

import { resolve } from "path";
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { run } from "./runner";
import { validateLine } from "./line";
import { loadWorkpiece } from "./workpiece";
import { startGlobalOrchestrator } from "./global-orchestrator";
import { startGlobalDashboard } from "./global-dashboard";
import { listHeld, releaseHeldTasks, InvalidTaskFileError } from "./held";
import { recordEmit } from "./emit-manifest";
import { CURRENT_INBOX_PAYLOAD_VERSION } from './schemas/inbox-payload';
import { StationName } from './ids';
import {
  resolveLinePath,
  loadEnvFiles,
  lineSearchDirsWithLabels,
  GLOBAL_LINES_DIR,
  GLOBAL_STATIONS_DIR,
  GLOBAL_RUNS_DIR,
  ASSEMBLY_HOME,
  ORCHESTRATOR_PID_FILE,
  DASHBOARD_PID_FILE,
} from "./paths";

const HELP = `
🏭 Assembly — Agent Factory Lines

Usage:
  assembly daemon [start]                           Start orchestrator for all lines (headless)
  assembly daemon stop                              Stop the running daemon
  assembly daemon reload [--timeout 30]             Graceful reload — pick up new code/config without killing workers
  assembly daemon status                            Show daemon status
  assembly dashboard [--port N] [--host HOST]       Start dashboard server (default: 127.0.0.1:4111)
  assembly dashboard stop                           Stop the dashboard server
  assembly dashboard status                         Show dashboard status
  assembly enqueue <line> --task "..." [--hold] [--key <name>] [--depends-on a,b]
                                                    Drop a task into a line's inbox (or held/ with --hold).
                                                    --key names the task so other tasks can depend on it.
                                                    --depends-on holds the task in inbox until each key has
                                                    landed in queues/done/.
  assembly held <line>                              List held tasks
  assembly release <line> <taskFile>|--all          Move held task(s) into inbox
  assembly run <line> --task "..." [options]         Run a line synchronously (batch mode)
  assembly inspect <workpiece.json> [--station]     Inspect a workpiece
  assembly validate <line>                          Validate a line
  assembly dry <line> --task "..."                  Show execution plan
  assembly list                                     List available lines
  assembly init                                     Set up ~/.assembly

Line Resolution:
  <line> can be a path or a name. Assembly searches:
  1. Exact path               ./lines/my-pipeline/
  2. Project-local             .assembly/lines/<name>/
  3. Global                    ~/.assembly/lines/<name>/

Run Options:
  --task "..."              The task to execute (required)
  --input '{"key": "val"}'  Input parameters (optional, JSON)
  --resume <workpiece.json> Resume from a saved workpiece
  --from <station>          Resume from this station onward
  --only <station>          Re-run only this station

Environment:
  API keys loaded from (first match wins; shell env always wins):
  1. ~/.secrets.env (system-level shared secrets)
  2. ~/.assembly/.env
  3. .env (current directory)
  4. .assembly/.env (current directory)
  5. Shell environment

Examples:
  assembly daemon start
  assembly dashboard --host 127.0.0.1 --port 4111
  assembly enqueue hello-world --task "Greet a new contributor"
  assembly enqueue repo-health-digest --task "Audit Anthropic SDKs" \\
    --input '{"repos":["anthropics/anthropic-sdk-python"]}'
  assembly list
`;

async function main() {
  // Load .env files before anything else
  loadEnvFiles();

  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "run":
      await handleRun(args.slice(1));
      break;
    case "enqueue":
      await handleEnqueue(args.slice(1));
      break;
    case "held":
      handleHeld(args.slice(1));
      break;
    case "release":
      handleRelease(args.slice(1));
      break;
    case "dry":
      await handleDry(args.slice(1));
      break;
    case "inspect":
      await handleInspect(args.slice(1));
      break;
    case "validate":
      await handleValidate(args.slice(1));
      break;
    case "list":
      handleList();
      break;
    case "init":
      await handleInit();
      break;
    case "daemon":
      await handleDaemon(args.slice(1));
      break;
    case "dashboard":
      await handleDashboardCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function handleRun(args: string[]) {
  const lineRef = args[0];
  if (!lineRef) {
    console.error(
      "Error: line required. Usage: assembly run <line> --task '...'"
    );
    process.exit(1);
  }

  const task = getFlag(args, "--task");
  if (!task) {
    console.error("Error: --task is required");
    process.exit(1);
  }

  const inputRaw = getFlag(args, "--input");
  let input: Record<string, unknown> = {};
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw);
    } catch {
      console.error("Error: --input must be valid JSON");
      process.exit(1);
    }
  }

  const resumeFrom = getFlag(args, "--resume");
  const fromStation = getFlag(args, "--from");
  const onlyStation = getFlag(args, "--only");

  await run({
    linePath: resolveLinePath(lineRef),
    task,
    input,
    resumeFrom: resumeFrom ? resolve(resumeFrom) : undefined,
    fromStation: fromStation ? StationName(fromStation) : undefined,
    onlyStation: onlyStation ? StationName(onlyStation) : undefined,
  });
}

async function handleDry(args: string[]) {
  const lineRef = args[0];
  if (!lineRef) {
    console.error("Error: line required");
    process.exit(1);
  }

  const task = getFlag(args, "--task") ?? "(dry run)";

  await run({
    linePath: resolveLinePath(lineRef),
    task,
    dryRun: true,
  });
}

async function handleInspect(args: string[]) {
  const wpPath = args[0];
  if (!wpPath) {
    console.error("Error: workpiece.json path required");
    process.exit(1);
  }

  const workpiece = await loadWorkpiece(resolve(wpPath));
  const stationFilter = getFlag(args, "--station");

  if (stationFilter) {
    const station = workpiece.stations[stationFilter as StationName];
    if (!station) {
      console.error(`Station "${stationFilter}" not found in workpiece`);
      console.log(
        `Available stations: ${Object.keys(workpiece.stations).join(", ")}`
      );
      process.exit(1);
    }

    console.log(`\n📋 Station: ${stationFilter}`);
    console.log(`   Status: ${station.status}`);
    console.log(`   Summary: ${station.summary}`);
    console.log(`   Model: ${station.model}`);
    console.log(
      `   Tokens: ${station.tokens.in} in / ${station.tokens.out} out`
    );
    if (station.cost_usd !== undefined) {
      console.log(`   Cost: $${station.cost_usd.toFixed(4)}`);
    }
    if (station.eval) {
      console.log(`   Eval: ${station.eval.pass ? "✓ pass" : "✗ fail"}${station.eval.score !== undefined ? ` (score: ${station.eval.score})` : ""}${station.eval.cost_usd ? ` ��� $${station.eval.cost_usd.toFixed(4)}` : ""}`);
    }

    if (station.content) {
      console.log(`\n── Content ──────────────────────────`);
      console.log(station.content);
    }

    if (station.data) {
      console.log(`\n── Data ─────────────────────────────`);
      console.log(JSON.stringify(station.data, null, 2));
    }
  } else {
    // Full workpiece overview
    console.log(`\n🏭 Workpiece: ${workpiece.id}`);
    console.log(`   Line: ${workpiece.line}`);
    console.log(`   Task: ${workpiece.task}`);
    if (Object.keys(workpiece.input).length > 0) {
      console.log(`   Input: ${JSON.stringify(workpiece.input)}`);
    }

    console.log(`\n── Stations ─────────────────────────`);
    for (const [name, station] of Object.entries(workpiece.stations)) {
      const icon = station.status === "done" ? "✓" : station.status === "escalated" ? "🚨" : "✗";
      const tokens = `${station.tokens.in + station.tokens.out} tokens`;
      const cost = station.cost_usd !== undefined ? ` · $${station.cost_usd.toFixed(4)}` : "";
      console.log(`   ${icon} ${name}: ${station.summary} (${tokens}${cost})`);
    }

    if (workpiece.totals) {
      console.log(`\n── Totals ───────────────────────────`);
      console.log(`   Tokens: ${workpiece.totals.tokens.in} in / ${workpiece.totals.tokens.out} out`);
      console.log(`   Cost: $${workpiece.totals.cost_usd.toFixed(4)}`);
    }
    console.log();
  }
}

function handleList() {
  console.log(`\n🏭 Available Lines\n`);

  let found = 0;
  const seenNames = new Set<string>();
  for (const [label, dir] of lineSearchDirsWithLabels()) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() && existsSync(resolve(dir, e.name, "line.yaml"))
      )
      .map((e) => e.name);

    if (entries.length > 0) {
      console.log(`  ${label}`);
      for (const name of entries) {
        // Flag shadowed names — earlier dirs win in resolveLinePath.
        const shadowed = seenNames.has(name);
        console.log(`    • ${name}${shadowed ? "  (shadowed)" : ""}`);
        seenNames.add(name);
        found++;
      }
      console.log();
    }
  }

  if (found === 0) {
    console.log("  No lines found. Create one with:\n");
    console.log("    mkdir -p ~/.assembly/lines/my-line/stations/my-station");
    console.log("    # Edit ~/.assembly/lines/my-line/line.yaml");
    console.log(
      "    # Edit ~/.assembly/lines/my-line/stations/my-station/AGENT.md\n"
    );
  }

  console.log(`  Runs: ${GLOBAL_RUNS_DIR}\n`);
}

async function handleInit() {
  const { mkdirSync, writeFileSync } = await import("fs");

  const dirs = [ASSEMBLY_HOME, GLOBAL_LINES_DIR, GLOBAL_STATIONS_DIR, GLOBAL_RUNS_DIR];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Create .env template if it doesn't exist
  const envPath = resolve(ASSEMBLY_HOME, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(
      envPath,
      `# Assembly environment variables\n# ASSEMBLY_ANTHROPIC_API_KEY=sk-ant-...\n`
    );
  }

  console.log(`\n✅ Assembly initialized at ${ASSEMBLY_HOME}`);
  console.log(`\n  ~/.assembly/`);
  console.log(`  ├── .env          ← API keys`);
  console.log(`  ├── lines/        ← Your pipelines`);
  console.log(`  ├── stations/     ← Shared/reusable stations`);
  console.log(`  └── runs/         ← Execution history\n`);
}

async function handleValidate(args: string[]) {
  const lineRef = args[0];
  if (!lineRef) {
    console.error("Error: line required");
    process.exit(1);
  }

  const linePath = resolveLinePath(lineRef);
  console.log(`\n🔍 Validating line at: ${linePath}\n`);
  const errors = await validateLine(linePath);

  if (errors.length === 0) {
    console.log("✅ Line is valid!\n");
  } else {
    console.log("❌ Validation errors:\n");
    for (const err of errors) {
      console.log(`   • ${err}`);
    }
    console.log();
    process.exit(1);
  }
}

async function handleEnqueue(args: string[]) {
  const lineRef = args[0];
  if (!lineRef) {
    console.error(
      "Error: line required. Usage: assembly enqueue <line> --task '...'"
    );
    process.exit(1);
  }

  const task = getFlag(args, "--task");
  if (!task) {
    console.error("Error: --task is required");
    process.exit(1);
  }

  const inputRaw = getFlag(args, "--input");
  let input: Record<string, unknown> = {};
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw);
    } catch {
      console.error("Error: --input must be valid JSON");
      process.exit(1);
    }
  }

  const hold = args.includes("--hold");
  const taskKey = getFlag(args, "--key");
  const dependsOnRaw = getFlag(args, "--depends-on");
  const dependsOn = dependsOnRaw
    ? dependsOnRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  // Keys become filenames in queues/*/, so reject anything that isn't a
  // safe basename. Dependencies match keys (or default `task-<ts>` ids), so
  // they must be sane too.
  const VALID_KEY = /^[A-Za-z0-9._-]+$/;
  if (taskKey !== null && !VALID_KEY.test(taskKey)) {
    console.error("Error: --key must be alphanumeric with . _ -");
    process.exit(1);
  }
  if (dependsOn) {
    for (const dep of dependsOn) {
      if (!VALID_KEY.test(dep)) {
        console.error(`Error: --depends-on entry '${dep}' must be alphanumeric with . _ -`);
        process.exit(1);
      }
    }
  }

  const linePath = resolveLinePath(lineRef);

  // Guard: refuse to create a queue dir under a path that isn't a real line.
  // resolveLinePath falls through to `resolve(nameOrPath)` when nothing
  // matches (paths.ts:47). Without this check, mkdirSync silently
  // materializes an orphan `<wrong-path>/queues/inbox/` that the daemon
  // never watches — tasks land there and disappear. Observed failure modes:
  //   - `assembly enqueue <name>` run from inside a sibling dir
  //     (rather than the repo root) creates `<cwd>/<name>/queues/inbox/`.
  //   - `assembly enqueue --line <name>` passes the literal string "--line"
  //     as the positional, creating `<cwd>/--line/queues/inbox/`.
  if (!existsSync(resolve(linePath, "line.yaml"))) {
    console.error(
      `Error: '${lineRef}' does not resolve to a line (no line.yaml at ${linePath}).\n` +
      `Pass a full path to the line directory, or run from a cwd where the line is discoverable:\n` +
      `  - exact path to a directory containing line.yaml\n` +
      `  - <cwd>/.assembly/lines/<name>/   (project-local)\n` +
      `  - ${homedir()}/.assembly/lines/<name>/   (global)`
    );
    process.exit(1);
  }

  const destDir = resolve(linePath, "queues", hold ? "held" : "inbox");
  const { mkdirSync } = await import("fs");
  mkdirSync(destDir, { recursive: true });

  // Create task file. We must guarantee the manifest entry is on disk
  // *before* the file is visible to the inbox watcher, otherwise the
  // daemon's drain races us, sees an "unverified" workpiece, and
  // quarantines it. Pattern: write to `.tmp`, append manifest, then
  // atomic rename. The rename is the moment the watcher fires, and at
  // that point the manifest already contains the final filename.
  const taskData: Record<string, unknown> = { schema_version: CURRENT_INBOX_PAYLOAD_VERSION, task, input };
  if (taskKey) taskData.taskKey = taskKey;
  if (dependsOn && dependsOn.length > 0) taskData.dependsOn = dependsOn;
  const fileName = `${taskKey ?? `task-${Date.now()}`}.json`;
  const filePath = resolve(destDir, fileName);

  // Collision check: a duplicate --key would silently overwrite the
  // earlier task. The held/ and inbox/ folders share a namespace via
  // release, so guard both.
  if (taskKey) {
    const inboxPath = resolve(linePath, "queues", "inbox", fileName);
    const heldPath = resolve(linePath, "queues", "held", fileName);
    const donePath = resolve(linePath, "queues", "done", fileName);
    if (existsSync(filePath) || existsSync(inboxPath) || existsSync(heldPath) || existsSync(donePath)) {
      console.error(`Error: task key '${taskKey}' already exists in this line`);
      process.exit(1);
    }
  }

  if (hold) {
    // `held/` files don't need recording — the inbox watcher never sees
    // them; held → inbox release records the destination separately via
    // held.ts.
    writeFileSync(filePath, JSON.stringify(taskData, null, 2));
  } else {
    // Match the existing atomic-write convention from queue.ts:
    // the inbox watcher's filter ignores names containing `.tmp.<pid>`.
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(taskData, null, 2));
    recordEmit(destDir, fileName, "cli");
    const { renameSync } = await import("fs");
    renameSync(tmpPath, filePath);
  }

  if (hold) {
    console.log(`\n  Task held (not released): ${filePath}`);
  } else {
    console.log(`\n  Task enqueued: ${filePath}`);
  }
  console.log(`  Task: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}\n`);
}

function handleHeld(args: string[]) {
  const lineRef = args[0];
  if (!lineRef) {
    console.error("Error: line required. Usage: assembly held <line>");
    process.exit(1);
  }

  const linePath = resolveLinePath(lineRef);
  const tasks = listHeld(linePath);

  if (tasks.length === 0) {
    console.log("No held tasks.");
    return;
  }

  console.log(`\n🔒 Held tasks (${tasks.length})\n`);
  for (const t of tasks) {
    const excerpt = t.task.slice(0, 60);
    console.log(`  • ${t.fileName}  —  ${excerpt}`);
  }
  console.log();
}

function handleRelease(args: string[]) {
  const lineRef = args[0];
  if (!lineRef) {
    console.error(
      "Error: line required. Usage: assembly release <line> <taskFile>|--all"
    );
    process.exit(1);
  }

  const all = args.includes("--all");
  // Second positional arg (not starting with --) is the file
  const file =
    args[1] && !args[1].startsWith("--") ? args[1] : undefined;

  if (!all && !file) {
    console.error(
      "Error: provide a task filename or --all.\n" +
        "Usage: assembly release <line> <taskFile>|--all"
    );
    process.exit(1);
  }

  const linePath = resolveLinePath(lineRef);

  let result;
  try {
    result = releaseHeldTasks(linePath, { file, all });
  } catch (err) {
    if (err instanceof InvalidTaskFileError) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(
    `Released: ${result.released.length} | Skipped: ${result.skipped.length} | Errors: ${result.errors.length}`
  );
  if (result.released.length > 0) {
    for (const f of result.released) console.log(`  ✓ ${f}`);
  }
  if (result.skipped.length > 0) {
    for (const f of result.skipped) console.log(`  ~ ${f} (already moved)`);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.log(`  ✗ ${e.file}: ${e.message}`);
  }
}

// ─── Daemon Commands ───────────────────────────────────────────────

async function handleDaemon(args: string[]) {
  const subcommand = args[0] ?? "start";

  switch (subcommand) {
    case "start":
      await handleDaemonStart(args.slice(1));
      break;
    case "stop":
      handleDaemonStop();
      break;
    case "reload":
      await handleDaemonReload(args.slice(1));
      break;
    case "_resume":
      // Internal: re-exec target invoked by an old daemon during reload.
      // Behaves identically to `start` but inherits ASSEMBLY_RELOAD_FROM_PID
      // env var so global-orchestrator skips its PID-file refusal.
      await handleDaemonStart(args.slice(1));
      break;
    case "status":
      await handleDaemonStatus();
      break;
    default:
      console.error(`Unknown daemon subcommand: ${subcommand}`);
      console.log("Usage: assembly daemon [start|stop|reload|status]");
      process.exit(1);
  }
}

async function handleDaemonStart(_args: string[]) {
  console.log(`\n🏭 Assembly — Daemon Mode\n`);

  let handle;
  try {
    handle = await startGlobalOrchestrator();
  } catch (err) {
    const msg = (err as Error).message;
    // "Already running" is a benign no-op for systemd, which retries this
    // unit every RestartSec on failure. Exit 0 so the unit reaches `active`
    // rather than churning the restart counter. The existing daemon stays
    // in charge; the operator must `daemon stop` to hand over.
    if (msg.includes("already running")) {
      console.log(`  ${msg}`);
      console.log(`  (Existing daemon remains in charge; exiting 0 as a no-op.)\n`);
      process.exit(0);
    }
    console.error(`  Error: ${msg}\n`);
    process.exit(1);
  }

  console.log(`  Lines discovered: ${handle.managedLines.size}`);
  for (const ml of handle.managedLines.values()) {
    const status =
      ml.status === "running"
        ? "✓ running"
        : `✗ error: ${ml.error?.slice(0, 60)}`;
    console.log(`    • ${ml.lineName} — ${status}`);
  }
  console.log(`\n  Orchestrator running (headless — no dashboard).`);
  console.log(`  Start dashboard separately: assembly dashboard\n`);
  console.log(`  Press Ctrl+C to stop.\n`);

  // Handle shutdown — await stop() so the SIGUSR2 → flush_grace → SIGKILL
  // ladder gets to run before the daemon exits. Without the await,
  // process.exit() would land before workers had any chance to flush
  // `aborted` failure envelopes, and we'd see phantom timeouts on restart.
  process.on("SIGINT", async () => {
    console.log("\n  Shutting down daemon...");
    try { await handle.stop(); } catch {}
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    try { await handle.stop(); } catch {}
    process.exit(0);
  });

  // SIGHUP: graceful reload. Hand off in-flight workers to a new daemon
  // process (`assembly daemon _resume`) without killing them. See
  // assembly-hot-reload-daemon.md for the full design.
  let reloadingInProgress = false;
  process.on("SIGHUP", async () => {
    if (reloadingInProgress) return;
    reloadingInProgress = true;
    try {
      await performHandoffReload(handle);
      process.exit(0);
    } catch (err) {
      console.error(`\n  Reload failed: ${(err as Error).message}`);
      console.error(`  Workers were NOT signaled — daemon continues running.`);
      reloadingInProgress = false;
    }
  });

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Cache for systemd-run availability check.
 */
let _systemdRunAvailable: boolean | null = null;

/**
 * Check if systemd-run is available on this system.
 */
async function isSystemdRunAvailable(): Promise<boolean> {
  if (_systemdRunAvailable !== null) return _systemdRunAvailable;
  try {
    const proc = Bun.spawn(["which", "systemd-run"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    _systemdRunAvailable = exitCode === 0;
    return _systemdRunAvailable;
  } catch {
    _systemdRunAvailable = false;
    return false;
  }
}

/**
 * The handoff sequence run inside the old daemon when SIGHUP fires.
 * Returns when it's safe to exit; throws if the new daemon didn't come up
 * (caller keeps the old daemon running rather than orphaning workers).
 */
async function performHandoffReload(
  handle: Awaited<ReturnType<typeof startGlobalOrchestrator>>,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  console.log(`\n  [reload] writing handoff state...`);
  const handoffPath = handle.writeHandoff();
  console.log(`  [reload] handoff written: ${handoffPath}`);

  // Spawn successor daemon. When under systemd, use systemd-run --scope to
  // escape the parent service's cgroup. Otherwise use detached spawn.
  //
  // Run from the same entry point as the current process — process.argv[1]
  // is the script `bun` is executing. In production that's dist/cli.js (the
  // built bundle); in dev/tests it's src/cli.ts. Picking the same entry
  // means whatever code we were running, the successor runs the latest
  // version of the same file. (For a true "swap in new code" reload, the
  // operator rebuilds dist/ before invoking `assembly daemon reload`.)
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot determine current CLI entry point (process.argv[1] empty)");
  }

  // Detect systemd context via INVOCATION_ID env var.
  const underSystemd = !!process.env.INVOCATION_ID;
  const systemdRunAvailable = underSystemd ? await isSystemdRunAvailable() : false;

  let child: any;

  if (underSystemd && systemdRunAvailable) {
    // Systemd context: spawn via systemd-run --scope to escape the parent
    // service's cgroup. The successor will run in a transient scope unit.
    // Build --setenv args for critical env vars that must be propagated.
    console.log(`  [reload] spawning successor via systemd-run (systemd context detected)`);
    const criticalEnvVars = [
      "ASSEMBLY_RELOAD_FROM_PID=" + process.pid,
      "HOME=" + process.env.HOME,
      "PATH=" + process.env.PATH,
    ];
    // Add any ASSEMBLY_* vars that exist in the current environment.
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("ASSEMBLY_") && key !== "ASSEMBLY_RELOAD_FROM_PID" && value !== undefined) {
        criticalEnvVars.push(`${key}=${value}`);
      }
    }
    const setenvArgs = criticalEnvVars.flatMap((v) => ["--setenv", v]);
    child = Bun.spawn([
      "systemd-run",
      "--scope",
      "--collect",
      "--quiet",
      "--unit=assembly-reload-" + Date.now(),
      ...setenvArgs,
      "bun",
      "run",
      entry,
      "daemon",
      "_resume",
    ], {
      stdout: "inherit",
      stderr: "inherit",
    });
  } else if (underSystemd && !systemdRunAvailable) {
    // Systemd detected but systemd-run not available: fall back with warning.
    console.warn(`  [reload] WARNING: running under systemd but systemd-run not found — successor may be killed by cgroup cleanup`);
    const env = { ...process.env, ASSEMBLY_RELOAD_FROM_PID: String(process.pid) };
    child = Bun.spawn(["bun", "run", entry, "daemon", "_resume"], {
      env,
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
  } else {
    // Non-systemd context: use detached spawn (dev/test path).
    console.log(`  [reload] spawning successor (detached, non-systemd context)`);
    const env = { ...process.env, ASSEMBLY_RELOAD_FROM_PID: String(process.pid) };
    child = Bun.spawn(["bun", "run", entry, "daemon", "_resume"], {
      env,
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
  }

  // Give systemd-run a moment to fail if it's going to (e.g., D-Bus down).
  if (underSystemd && systemdRunAvailable) {
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode !== null && child.exitCode !== 0) {
      console.warn(`  [reload] systemd-run failed (exit ${child.exitCode}), falling back to detached spawn`);
      const env = { ...process.env, ASSEMBLY_RELOAD_FROM_PID: String(process.pid) };
      child = Bun.spawn(["bun", "run", entry, "daemon", "_resume"], {
        env,
        stdout: "inherit",
        stderr: "inherit",
        detached: true,
      });
    }
  }

  const newPid = child.pid!;
  console.log(`  [reload] successor spawned: pid=${newPid}`);

  // Wait for the successor's ready file. It writes this after adopting workers
  // and before taking the PID file.
  const { orchestratorReadyFileFor } = require("./paths");
  const readyPath = orchestratorReadyFileFor(newPid);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(readyPath)) break;
    // Bail early if the successor died.
    try { process.kill(newPid, 0); } catch {
      throw new Error(`successor pid=${newPid} died before signaling ready`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(readyPath)) {
    throw new Error(`successor pid=${newPid} did not signal ready within ${timeoutMs}ms`);
  }
  console.log(`  [reload] successor ready — stepping down...`);

  // Tell our orchestrator: stop watchers, don't touch workers.
  await handle.stop({ handoff: true });

  // Release the PID file so the successor can claim it. The successor
  // polls for this and atomically writes its own.
  const { ORCHESTRATOR_PID_FILE } = require("./paths");
  try { require("fs").unlinkSync(ORCHESTRATOR_PID_FILE); } catch {}

  console.log(`  [reload] handoff complete, exiting pid=${process.pid}.`);
}

async function handleDaemonReload(args: string[]) {
  const timeoutStr = getFlag(args, "--timeout");
  const timeoutS = timeoutStr ? parseInt(timeoutStr, 10) : 30;
  if (!existsSync(ORCHESTRATOR_PID_FILE)) {
    console.error("Daemon is not running — nothing to reload. Use `assembly daemon start`.");
    process.exit(1);
  }
  let pid: number;
  try {
    const pidData = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));
    pid = pidData.pid;
    process.kill(pid, 0); // alive?
  } catch {
    console.error("Daemon PID file is stale — daemon is not running. Use `assembly daemon start`.");
    try { unlinkSync(ORCHESTRATOR_PID_FILE); } catch {}
    process.exit(1);
  }

  console.log(`\n🏭 Assembly — reloading daemon (pid=${pid})\n`);
  try {
    process.kill(pid, "SIGHUP");
  } catch (err) {
    console.error(`Failed to signal daemon: ${(err as Error).message}`);
    process.exit(1);
  }

  // Wait for the old daemon to exit (its successor will replace it). We poll
  // the PID file: when its `pid` changes from the old value to a new one,
  // reload is complete.
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (!existsSync(ORCHESTRATOR_PID_FILE)) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    try {
      const cur = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));
      if (cur.pid !== pid) {
        console.log(`  ✓ daemon reloaded: pid=${pid} → pid=${cur.pid}\n`);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  // Distinguish: did the successor come up and die, or never come up?
  let successorDied = false;
  let successorPid: number | null = null;
  try {
    if (existsSync(ORCHESTRATOR_PID_FILE)) {
      const cur = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));
      if (cur.pid !== pid) {
        successorPid = cur.pid;
        try {
          process.kill(cur.pid, 0);
        } catch {
          successorDied = true;
        }
      }
    }
  } catch {}

  if (successorDied) {
    console.error(`  Reload handed off to successor (pid=${successorPid}) but it died shortly after.`);
    console.error(`  This typically happens when systemd's cgroup cleanup kills the successor.`);
    console.error(`  Restart manually: systemctl restart assembly`);
  } else {
    console.error(`  Reload did not complete within ${timeoutS}s.`);
    console.error(`  The successor may have failed to start. Check daemon logs.`);
  }
  process.exit(1);
}

function handleDaemonStop() {
  if (!existsSync(ORCHESTRATOR_PID_FILE)) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    const { readFileSync } = require("fs");
    const pidData = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));

    try {
      process.kill(pidData.pid, 0);
    } catch {
      // Process not running — stale PID file
      unlinkSync(ORCHESTRATOR_PID_FILE);
      console.log("Daemon is not running (stale PID file cleaned up).");
      return;
    }

    process.kill(pidData.pid, "SIGTERM");
    unlinkSync(ORCHESTRATOR_PID_FILE);
    console.log(`Daemon stopped (PID: ${pidData.pid}).`);
  } catch (err) {
    console.error(`Error stopping daemon: ${(err as Error).message}`);
  }
}

async function handleDaemonStatus() {
  if (!existsSync(ORCHESTRATOR_PID_FILE)) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    const { readFileSync } = require("fs");
    const pidData = JSON.parse(readFileSync(ORCHESTRATOR_PID_FILE, "utf-8"));

    try {
      process.kill(pidData.pid, 0);
    } catch {
      unlinkSync(ORCHESTRATOR_PID_FILE);
      console.log("Daemon is not running (stale PID file cleaned up).");
      return;
    }

    console.log(`\n🏭 Assembly Daemon`);
    console.log(`  PID: ${pidData.pid}`);
    console.log(`  Status: running`);

    // Check dashboard status too
    if (existsSync(DASHBOARD_PID_FILE)) {
      try {
        const dashPid = JSON.parse(readFileSync(DASHBOARD_PID_FILE, "utf-8"));
        process.kill(dashPid.pid, 0);
        console.log(`  Dashboard: http://${dashPid.host ?? "localhost"}:${dashPid.port} (PID: ${dashPid.pid})`);
      } catch {
        console.log(`  Dashboard: not running`);
      }
    } else {
      console.log(`  Dashboard: not running`);
    }

    console.log();
  } catch (err) {
    console.error(`Error reading daemon status: ${(err as Error).message}`);
  }
}

// ─── Dashboard Commands ─────────────────────────────────────────────

async function handleDashboardCommand(args: string[]) {
  const subcommand = args[0] ?? "start";

  switch (subcommand) {
    case "start":
      await handleDashboardStart(args.slice(1));
      break;
    case "stop":
      handleDashboardStop();
      break;
    case "status":
      handleDashboardStatusCmd();
      break;
    default:
      // If the first arg looks like a flag (--port), treat as start
      if (subcommand.startsWith("--")) {
        await handleDashboardStart(args);
      } else {
        console.error(`Unknown dashboard subcommand: ${subcommand}`);
        console.log("Usage: assembly dashboard [start|stop|status] [--port N] [--host HOST]");
        process.exit(1);
      }
  }
}

async function handleDashboardStart(args: string[]) {
  const portStr = getFlag(args, "--port");
  const port = portStr ? parseInt(portStr, 10) : 4111;
  const host = getFlag(args, "--host") ?? "127.0.0.1";

  console.log(`\n🏭 Assembly — Dashboard\n`);

  // PID file check — verify the PID is actually a dashboard process before
  // trusting it. `process.kill(pid, 0)` only confirms *something* owns the PID,
  // and PID recycling on busy systems (many short-lived bun workers) makes that
  // a false-positive trap. Confirm via /proc/<pid>/cmdline.
  if (existsSync(DASHBOARD_PID_FILE)) {
    try {
      const pidData = JSON.parse(readFileSync(DASHBOARD_PID_FILE, "utf-8"));
      process.kill(pidData.pid, 0);
      const cmdline = readFileSync(`/proc/${pidData.pid}/cmdline`, "utf-8");
      if (cmdline.includes("dashboard")) {
        console.error(
          `  Dashboard already running (PID: ${pidData.pid}). Use 'assembly dashboard stop' first.\n`
        );
        process.exit(1);
      }
    } catch {}
    try {
      unlinkSync(DASHBOARD_PID_FILE);
    } catch {}
  }

  const dashboard = startGlobalDashboard({ port, host });

  writeFileSync(
    DASHBOARD_PID_FILE,
    JSON.stringify({ pid: process.pid, port, host })
  );

  const cleanup = () => {
    try {
      unlinkSync(DASHBOARD_PID_FILE);
    } catch {}
  };
  process.on("exit", cleanup);

  console.log(`  Dashboard: http://${host}:${port}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  process.on("SIGINT", () => {
    console.log("\n  Shutting down dashboard...");
    dashboard.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    dashboard.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

function handleDashboardStop() {
  if (!existsSync(DASHBOARD_PID_FILE)) {
    console.log("Dashboard is not running.");
    return;
  }

  try {
    const pidData = JSON.parse(readFileSync(DASHBOARD_PID_FILE, "utf-8"));
    try {
      process.kill(pidData.pid, 0);
    } catch {
      unlinkSync(DASHBOARD_PID_FILE);
      console.log("Dashboard is not running (stale PID file cleaned up).");
      return;
    }
    process.kill(pidData.pid, "SIGTERM");
    unlinkSync(DASHBOARD_PID_FILE);
    console.log(`Dashboard stopped (PID: ${pidData.pid}).`);
  } catch (err) {
    console.error(`Error stopping dashboard: ${(err as Error).message}`);
  }
}

function handleDashboardStatusCmd() {
  if (!existsSync(DASHBOARD_PID_FILE)) {
    console.log("Dashboard is not running.");
    return;
  }

  try {
    const pidData = JSON.parse(readFileSync(DASHBOARD_PID_FILE, "utf-8"));
    try {
      process.kill(pidData.pid, 0);
    } catch {
      unlinkSync(DASHBOARD_PID_FILE);
      console.log("Dashboard is not running (stale PID file cleaned up).");
      return;
    }
    console.log(`\n🏭 Assembly Dashboard`);
    console.log(`  PID: ${pidData.pid}`);
    console.log(`  URL: http://${pidData.host ?? "localhost"}:${pidData.port}\n`);
  } catch (err) {
    console.error(`Error reading dashboard status: ${(err as Error).message}`);
  }
}

/**
 * Get a flag value from args: --flag value
 */
function getFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}\n`);
  process.exit(1);
});
