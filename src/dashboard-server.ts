#!/usr/bin/env bun

/**
 * Standalone dashboard server entry point.
 *
 * This is the ExecStart target for assembly-dashboard.service.
 * It handles PID management, signal handling, and delegates to
 * startGlobalDashboard() for the actual HTTP server.
 *
 * Usage:
 *   bun run src/dashboard-server.ts [--host 127.0.0.1] [--port 4111]
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { startGlobalDashboard } from "./global-dashboard";
import { loadEnvFiles, DASHBOARD_PID_FILE } from "./paths";

// Parse --port flag
function getPort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    const p = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(p)) return p;
  }
  return 4111;
}

function getHost(): string {
  const idx = process.argv.indexOf("--host");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return "127.0.0.1";
}

loadEnvFiles();

const port = getPort();
const host = getHost();

// PID file management — prevent double-start
if (existsSync(DASHBOARD_PID_FILE)) {
  try {
    const pidData = JSON.parse(readFileSync(DASHBOARD_PID_FILE, "utf-8"));
    process.kill(pidData.pid, 0); // throws if not alive
    console.error(
      `Dashboard already running (PID: ${pidData.pid}). Stop it first.`
    );
    process.exit(1);
  } catch (err) {
    if ((err as Error).message.includes("already running")) {
      process.exit(1);
    }
    // Stale PID file — clean up and continue
    try {
      unlinkSync(DASHBOARD_PID_FILE);
    } catch {}
  }
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
process.on("SIGINT", () => {
  console.log("\n  Dashboard stopped.");
  dashboard.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  dashboard.stop();
  process.exit(0);
});
