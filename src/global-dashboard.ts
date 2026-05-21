import { discoverLines, type GlobalState } from "./global-orchestrator";
import { getFullState, findWorkpiece, getWorkpieceActivity, getHistory, getKanbanState, getTaskEventStations, getTaskEvents, computeFlowMetrics } from "./dashboard-data";
import { dismissFilenames, undismissFilenames } from "./error-dismiss";
import { releaseHeldTasks, InvalidTaskFileError } from "./held";
import {
  retryErroredWorkpiece,
  InvalidRetryFileNameError,
  ErrorFileNotFoundError,
} from "./retry-manual";
import { loadLine } from "./line";
import { basename, resolve } from "path";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { readUsageSnapshot } from "./usage-snapshot";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const MORPHDOM_UMD = readFileSync(_require.resolve("morphdom/dist/morphdom-umd.min.js"), "utf-8");
const DASHBOARD_CLIENT_JS = readFileSync(resolve(import.meta.dir, "dashboard-client.js"), "utf-8");

// ─── Types ─────────────────────────────────────────────────────────

export interface GlobalDashboardOptions {
  port: number;
}

interface DiscoveredLine {
  linePath: string;
  lineName: string;
}

// ─── Line Discovery ─────────────────────────────────────────────────

async function discoverAndMapLines(): Promise<DiscoveredLine[]> {
  const paths = discoverLines();
  const lines: DiscoveredLine[] = [];
  for (const linePath of paths) {
    try {
      const { config } = await loadLine(linePath);
      lines.push({ linePath, lineName: config.name });
    } catch {
      lines.push({ linePath, lineName: basename(linePath) });
    }
  }
  return lines;
}

async function buildGlobalState(lines: DiscoveredLine[]): Promise<GlobalState> {
  const lineStates: GlobalState["lines"] = [];
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

  for (const dl of lines) {
    totals.lines++;
    try {
      const state = await getFullState(dl.linePath);
      if ("error" in state) {
        totals.linesErrored++;
        lineStates.push({
          name: dl.lineName,
          path: dl.linePath,
          status: "error",
          error: (state as { error: string }).error,
          startedAt: "",
          state: null,
        });
      } else {
        totals.linesRunning++;
        const s = state as GlobalState["lines"][0]["state"];
        if (s) {
          totals.totalInbox += s.lineQueue.inbox;
          totals.totalDone += s.lineQueue.done;
          totals.totalErrors += s.lineQueue.errorActive;
          totals.totalReview += s.lineQueue.review;
          if (s.sessionTotals) {
            totals.totalCostUsd += s.sessionTotals.cost_usd;
          }
          if (s.throughput) {
            totals.totalThroughput1h += s.throughput.last_1h;
            totals.totalThroughput24h += s.throughput.last_24h;
          }
        }
        lineStates.push({
          name: dl.lineName,
          path: dl.linePath,
          status: "running",
          startedAt: "",
          state: s,
        });
      }
    } catch (err) {
      totals.linesErrored++;
      lineStates.push({
        name: dl.lineName,
        path: dl.linePath,
        status: "error",
        error: (err as Error).message,
        startedAt: "",
        state: null,
      });
    }
  }

  return { lines: lineStates, totals, timestamp: new Date().toISOString() };
}

// ─── Dashboard Server ──────────────────────────────────────────────

/**
 * Start the unified multi-line dashboard HTTP server.
 * Discovers lines independently and reads all state from the filesystem.
 */
export function startGlobalDashboard(options: GlobalDashboardOptions): {
  stop: () => void;
  port: number;
} {
  // Discover lines on startup and refresh periodically
  let discoveredLines: DiscoveredLine[] = [];
  let linesByName: Map<string, DiscoveredLine> = new Map();

  async function refreshLines() {
    discoveredLines = await discoverAndMapLines();
    linesByName = new Map(discoveredLines.map(dl => [dl.lineName, dl]));
  }

  // Initial discovery (async, but server starts immediately)
  refreshLines();

  // Re-discover lines every 30 seconds
  const refreshInterval = setInterval(refreshLines, 30000);

  const server = Bun.serve({
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);

      // Global state API
      if (url.pathname === "/api/state") {
        const state = await buildGlobalState(discoveredLines);
        return Response.json(state);
      }

      // Usage-limits snapshot — sourced from ~/.assembly/usage-status.json,
      // written out of band by the orchestrator's gate. 200 always; UI
      // treats missing/malformed as "unknown".
      if (url.pathname === "/api/usage") {
        const snapshot = readUsageSnapshot();
        if (!snapshot) {
          return Response.json({
            state: "unknown",
            reason: "no snapshot found — orchestrator not running or hasn't checked yet",
          });
        }
        const checkedMs = new Date(snapshot.checkedAt).getTime();
        const ageMs = Number.isFinite(checkedMs) ? Date.now() - checkedMs : null;
        return Response.json({ ...snapshot, ageMs });
      }

      // Dismiss errors API
      if (url.pathname.match(/^\/api\/line\/[^/]+\/errors\/dismiss$/) && req.method === "POST") {
        const lineName = decodeURIComponent(url.pathname.split("/")[3]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const body = await req.json() as { fileNames?: string[] };
          if (!body.fileNames || !Array.isArray(body.fileNames)) {
            return Response.json({ error: "fileNames array required" }, { status: 400 });
          }
          const updated = dismissFilenames(dl.linePath, body.fileNames);
          return Response.json({ dismissed: updated });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Undismiss errors API
      if (url.pathname.match(/^\/api\/line\/[^/]+\/errors\/undismiss$/) && req.method === "POST") {
        const lineName = decodeURIComponent(url.pathname.split("/")[3]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const body = await req.json() as { fileNames?: string[] };
          if (!body.fileNames || !Array.isArray(body.fileNames)) {
            return Response.json({ error: "fileNames array required" }, { status: 400 });
          }
          const updated = undismissFilenames(dl.linePath, body.fileNames);
          return Response.json({ dismissed: updated });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Release held tasks API
      if (url.pathname.match(/^\/api\/line\/[^/]+\/release$/) && req.method === "POST") {
        const lineName = decodeURIComponent(url.pathname.split("/")[3]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const body = await req.json() as { taskFile?: string; all?: boolean };
          const { taskFile, all } = body;
          if (!taskFile && !all) {
            return Response.json({ error: "taskFile or all required" }, { status: 400 });
          }
          if (taskFile !== undefined) {
            const base = basename(taskFile);
            if (
              base !== taskFile ||
              !taskFile.endsWith(".json") ||
              taskFile.includes("..") ||
              taskFile.includes("/") ||
              taskFile.includes("\\")
            ) {
              return Response.json({ error: "Invalid taskFile" }, { status: 400 });
            }
          }
          const result = releaseHeldTasks(dl.linePath, { file: taskFile, all });
          return Response.json(result);
        } catch (err) {
          if (err instanceof InvalidTaskFileError) {
            return Response.json({ error: (err as Error).message }, { status: 400 });
          }
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Retry an errored workpiece — copy to inbox with fresh id, auto-dismiss original
      if (url.pathname.match(/^\/api\/line\/[^/]+\/retry$/) && req.method === "POST") {
        const lineName = decodeURIComponent(url.pathname.split("/")[3]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const body = await req.json() as { fileName?: string };
          const fileName = body?.fileName;
          if (!fileName || typeof fileName !== "string") {
            return Response.json({ error: "fileName required" }, { status: 400 });
          }
          const result = retryErroredWorkpiece(dl.linePath, fileName);
          try {
            const logDir = resolve(dl.linePath, "queues");
            mkdirSync(logDir, { recursive: true });
            const logPath = resolve(logDir, "activity.jsonl");
            appendFileSync(
              logPath,
              JSON.stringify({
                ts: new Date().toISOString(),
                event: "retry_manual",
                workpiece: result.newId,
                parent_run_id: result.originalId,
                source_file: fileName,
              }) + "\n"
            );
          } catch {}
          return Response.json({ ok: true, newId: result.newId, newFileName: result.newFileName });
        } catch (err) {
          if (err instanceof InvalidRetryFileNameError) {
            return Response.json({ error: err.message }, { status: 400 });
          }
          if (err instanceof ErrorFileNotFoundError) {
            return Response.json({ error: err.message }, { status: 404 });
          }
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Progress API — live station progress events
      const progressMatch = url.pathname.match(/^\/api\/progress\/([^/]+)\/([^/]+)$/);
      if (progressMatch) {
        const lineName = decodeURIComponent(progressMatch[1]);
        const stationName = decodeURIComponent(progressMatch[2]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });

        try {
          const stationDir = resolve(dl.linePath, "stations", stationName, "queue", "processing");
          if (!existsSync(stationDir)) return Response.json({ events: [] });
          const files = readdirSync(stationDir).filter((f: string) => f.endsWith(".progress.jsonl"));
          if (files.length === 0) return Response.json({ events: [] });

          const progressFile = resolve(stationDir, files[files.length - 1]);
          const content = readFileSync(progressFile, "utf-8");
          const events = content.trim().split("\n").filter(Boolean).map((line: string) => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          return Response.json({ events });
        } catch {
          return Response.json({ events: [] });
        }
      }

      // Per-line kanban state API
      const kanbanMatch = url.pathname.match(/^\/api\/line\/([^/]+)\/kanban$/);
      if (kanbanMatch && req.method === "GET") {
        const lineName = decodeURIComponent(kanbanMatch[1]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const kb = await getKanbanState(dl.linePath);
          return Response.json(kb);
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Per-line history API (Tier 4 #17)
      const historyMatch = url.pathname.match(/^\/api\/line\/([^/]+)\/history$/);
      if (historyMatch) {
        const lineName = decodeURIComponent(historyMatch[1]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 10) : 10;
        const includeRaw = url.searchParams.get("include") || "done";
        const include = includeRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is "done" | "error" => s === "done" || s === "error");
        try {
          const hist = await getHistory(dl.linePath, { limit, include });
          return Response.json(hist);
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Per-line flow metrics API (Tier 4 #29)
      const flowMetricsMatch = url.pathname.match(/^\/api\/line\/([^/]+)\/flow-metrics$/);
      if (flowMetricsMatch && req.method === "GET") {
        const lineName = decodeURIComponent(flowMetricsMatch[1]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const { config } = await loadLine(dl.linePath);
          const sequence: string[] = [];
          for (const step of config.sequence) {
            if (typeof step === "string") sequence.push(step);
            else if ("parallel" in step) sequence.push(...step.parallel);
            else if ("station" in step) sequence.push((step as { station: { name: string } }).station.name);
          }
          const metrics = computeFlowMetrics(dl.linePath, sequence);
          return Response.json(metrics);
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Per-line state API
      if (url.pathname.startsWith("/api/line/")) {
        const lineName = decodeURIComponent(
          url.pathname.replace("/api/line/", "")
        );
        const dl = linesByName.get(lineName);
        if (!dl) {
          return Response.json(
            { error: `Line "${lineName}" not found` },
            { status: 404 }
          );
        }
        try {
          const state = await getFullState(dl.linePath);
          return Response.json(state);
        } catch (err) {
          return Response.json(
            { error: (err as Error).message },
            { status: 500 }
          );
        }
      }

      // Task events API — station list for a workpiece
      const taskEventsBaseMatch = url.pathname.match(/^\/api\/task-events\/([^/]+)\/([^/]+)$/);
      if (taskEventsBaseMatch) {
        const lineName = decodeURIComponent(taskEventsBaseMatch[1]);
        const wpId = decodeURIComponent(taskEventsBaseMatch[2]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const stations = getTaskEventStations(dl.linePath, wpId);
          return Response.json({ stations });
        } catch {
          return Response.json({ stations: [] });
        }
      }

      // Task events API — event stream for a specific station
      const taskEventsStationMatch = url.pathname.match(/^\/api\/task-events\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (taskEventsStationMatch) {
        const lineName = decodeURIComponent(taskEventsStationMatch[1]);
        const wpId = decodeURIComponent(taskEventsStationMatch[2]);
        const stationName = decodeURIComponent(taskEventsStationMatch[3]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        const afterRaw = url.searchParams.get("after");
        const beforeRaw = url.searchParams.get("before");
        const limitRaw = url.searchParams.get("limit");
        const opts: { after?: number; before?: number; limit?: number } = {};
        if (afterRaw !== null) opts.after = parseInt(afterRaw, 10);
        if (beforeRaw !== null) opts.before = parseInt(beforeRaw, 10);
        if (limitRaw !== null) opts.limit = Math.min(500, Math.max(1, parseInt(limitRaw, 10) || 100));
        try {
          const page = getTaskEvents(dl.linePath, wpId, stationName, opts);
          return Response.json(page);
        } catch {
          return Response.json({ events: [], next_cursor: 0, total: 0, has_more: false });
        }
      }

      // Per-line workpiece API
      if (url.pathname.startsWith("/api/workpiece/")) {
        const parts = url.pathname.replace("/api/workpiece/", "").split("/");
        if (parts.length >= 2) {
          const lineName = decodeURIComponent(parts[0]);
          const fileName = decodeURIComponent(parts.slice(1).join("/"));
          const dl = linesByName.get(lineName);
          if (!dl) {
            return Response.json(
              { error: `Line "${lineName}" not found` },
              { status: 404 }
            );
          }
          const wp = await findWorkpiece(dl.linePath, fileName);
          if (wp) {
            const activity = getWorkpieceActivity(dl.linePath, wp.id);
            const taskEventStations = getTaskEventStations(dl.linePath, wp.id);
            return Response.json({ ...wp, _activity: activity, _taskEventStations: taskEventStations });
          }
          return Response.json(
            { error: "Workpiece not found" },
            { status: 404 }
          );
        }
        return Response.json({ error: "Invalid path" }, { status: 400 });
      }

      // SPA catch-all: serve dashboard HTML for any non-API path
      return new Response(GLOBAL_DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  console.log(`\n  Dashboard: http://localhost:${options.port}\n`);

  return {
    stop: () => {
      clearInterval(refreshInterval);
      server.stop();
    },
    port: options.port,
  };
}

// ─── Embedded Dashboard HTML ───────────────────────────────────────

const GLOBAL_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Assembly — Global Dashboard</title>
  <style>
    :root {
      /* Backgrounds */
      --bg-base: #0f1117;
      --bg-surface: #1a1d27;
      --bg-elevated: #252a36;
      --border-default: #2a2e3d;
      --border-subtle: #1f2233;

      /* Status */
      --color-success: #22c55e;
      --color-success-dim: #132b1a;
      --color-error: #ef4444;
      --color-error-dim: #2d1316;
      --color-warning: #f59e0b;
      --color-warning-dim: #2b2210;
      --color-info: #3b82f6;
      --color-info-dim: #151f33;
      --color-idle: #6b7280;

      /* Text */
      --text-primary: #f0f1f4;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      --text-dim: #4b5563;

      /* Typography */
      --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;

      /* Spacing */
      --space-xs: 4px;
      --space-sm: 8px;
      --space-md: 12px;
      --space-lg: 16px;
      --space-xl: 24px;
      --space-2xl: 32px;

      /* Radii */
      --radius-sm: 6px;
      --radius-md: 10px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--font-ui); background: var(--bg-base); color: var(--text-primary); padding: var(--space-xl); line-height: 1.5; }
    h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: var(--space-xs); }
    h2 { font-size: 14px; font-weight: 600; margin-bottom: var(--space-md); }
    .subtitle { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); margin-bottom: var(--space-xl); display: flex; align-items: center; gap: var(--space-sm); }
    /* Connection health indicator */
    .conn-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; transition: background-color 150ms ease; }
    .conn-dot.conn-live { background: var(--color-success); animation: conn-pulse 2s infinite; }
    .conn-dot.conn-stale { background: var(--color-warning); }
    .conn-dot.conn-disconnected { background: var(--color-error); }
    .conn-label { font-family: var(--font-ui); font-size: 12px; color: var(--text-primary); }
    .conn-label.conn-stale { color: var(--color-warning); }
    .conn-label.conn-disconnected { color: var(--color-error); }
    .conn-ts { color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; margin-left: var(--space-sm); }
    @keyframes conn-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Summary bar */
    .summary-bar { display: flex; gap: var(--space-lg); margin-bottom: var(--space-xl); flex-wrap: wrap; }
    .metric-card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: var(--space-md) var(--space-lg); min-width: 100px; }
    .metric-card .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 500; letter-spacing: 0.05em; }
    .metric-card .count { font-size: 28px; font-weight: 700; font-family: var(--font-mono); margin-top: var(--space-xs); color: var(--text-primary); }
    .metric-card.running .count { color: var(--color-success); }
    .metric-card.inbox .count { color: var(--color-info); }
    .metric-card.done .count { color: var(--color-success); }
    .metric-card.error .count { color: var(--color-error); }
    .metric-card.review .count { color: var(--color-warning); }

    /* Line grid */
    .line-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--space-lg);
      margin-bottom: var(--space-xl);
    }
    .line-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .line-card:hover { border-color: var(--color-info); }
    .line-card.error-card { border-left: 3px solid var(--color-error); }
    .line-card .line-name { font-size: 14px; font-weight: 600; margin-bottom: var(--space-sm); }
    .line-card .line-metrics { font-size: 12px; font-family: var(--font-mono); color: var(--text-secondary); margin-bottom: var(--space-sm); }
    .status-badge { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-sm); display: inline-block; margin-bottom: var(--space-sm); }
    .status-badge.running { background: var(--color-success-dim); color: var(--color-success); }
    .status-badge.error { background: var(--color-error-dim); color: var(--color-error); }

    /* Error alert banner */
    .error-banner {
      background: var(--color-error);
      color: #fff;
      padding: var(--space-md) var(--space-lg);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-lg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-family: var(--font-mono);
      animation: bannerSlideIn 0.2s ease-out;
    }
    @keyframes bannerSlideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
    .error-banner-content {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      cursor: pointer;
      flex: 1;
    }
    .error-banner-content:hover { text-decoration: underline; }
    .error-banner-icon { font-size: 16px; flex-shrink: 0; }
    .error-banner-dismiss {
      background: none;
      border: none;
      color: rgba(255,255,255,0.7);
      font-size: 18px;
      cursor: pointer;
      padding: 0 0 0 var(--space-md);
      line-height: 1;
      flex-shrink: 0;
    }
    .error-banner-dismiss:hover { color: #fff; }
    .error-banner.severity-critical { background: var(--color-error); }
    .error-banner.severity-warning { background: var(--color-warning); color: #000; }
    .error-banner.severity-warning .error-banner-dismiss { color: rgba(0,0,0,0.5); }
    .error-banner.severity-warning .error-banner-dismiss:hover { color: #000; }
    .error-banner-freshness { font-size: 11px; opacity: 0.7; margin-left: var(--space-sm); }
    .error-banner-severity-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-right: var(--space-sm); }
    #error-banner-mount { transition: opacity 0.2s ease, max-height 0.2s ease; overflow: hidden; }
    #error-banner-mount.hiding { opacity: 0; max-height: 0; margin-bottom: 0; }
    @media (prefers-reduced-motion: reduce) {
      .error-banner, #error-banner-mount { animation: none !important; transition: none !important; }
    }

    /* Usage-limits panel */
    #usage-panel-mount { margin-bottom: var(--space-lg); }
    .usage-panel {
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      padding: var(--space-md) var(--space-lg);
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
    }
    .usage-panel.state-paused { border-left: 3px solid var(--color-error); }
    .usage-panel.state-warn { border-left: 3px solid var(--color-warning); }
    .usage-panel.state-healthy { border-left: 3px solid var(--color-success); }
    .usage-panel.state-unknown { border-left: 3px solid var(--color-idle); }
    .usage-header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-md);
      margin-bottom: var(--space-sm);
    }
    .usage-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
    }
    .usage-chip.state-paused { background: var(--color-error-dim); color: var(--color-error); }
    .usage-chip.state-warn { background: var(--color-warning-dim); color: var(--color-warning); }
    .usage-chip.state-healthy { background: var(--color-success-dim); color: var(--color-success); }
    .usage-chip.state-unknown { background: var(--bg-elevated); color: var(--color-idle); }
    .usage-meta { color: var(--text-muted); font-size: 11px; }
    .usage-meta-sep { color: var(--text-dim); margin: 0 var(--space-xs); }
    .usage-reason {
      color: var(--color-error);
      font-size: 11px;
      margin-bottom: var(--space-sm);
      word-break: break-word;
    }
    .usage-buckets { display: grid; gap: 4px; }
    .usage-bucket {
      display: grid;
      grid-template-columns: 120px 1fr 60px 140px;
      align-items: center;
      gap: var(--space-md);
      font-size: 11px;
    }
    .usage-bucket-label { color: var(--text-secondary); }
    .usage-bar-wrap {
      position: relative;
      height: 8px;
      background: var(--bg-elevated);
      border-radius: 4px;
      overflow: hidden;
    }
    .usage-bar-fill {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: var(--color-success);
      transition: width 200ms ease;
    }
    .usage-bar-fill.warn { background: var(--color-warning); }
    .usage-bar-fill.over { background: var(--color-error); }
    .usage-bar-tick {
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 2px;
      background: var(--text-muted);
      opacity: 0.8;
    }
    .usage-bucket-util { color: var(--text-primary); font-variant-numeric: tabular-nums; text-align: right; }
    .usage-bucket-reset { color: var(--text-muted); text-align: right; }

    /* Compact usage indicator — shown on line detail pages only.
       Lets the full usage card reclaim header real-estate for the kanban. */
    body.view-detail #usage-panel-mount { display: none; }
    body:not(.view-detail) #usage-compact-mount { display: none; }
    #usage-compact-mount { margin-left: auto; position: relative; }
    .usage-compact {
      position: relative;
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-xs);
      padding: 3px 10px;
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      cursor: pointer;
      user-select: none;
    }
    .usage-compact:hover,
    .usage-compact:focus-visible { border-color: var(--text-secondary); outline: none; }
    .usage-compact.state-paused { border-color: var(--color-error); }
    .usage-compact.state-warn { border-color: var(--color-warning); }
    .usage-compact-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .usage-compact-dot.state-healthy { background: var(--color-success); }
    .usage-compact-dot.state-warn { background: var(--color-warning); }
    .usage-compact-dot.state-paused { background: var(--color-error); }
    .usage-compact-dot.state-unknown { background: var(--color-idle); }
    .usage-compact-label { color: var(--text-primary); font-weight: 600; }
    .usage-compact.state-warn .usage-compact-label { color: var(--color-warning); }
    .usage-compact.state-paused .usage-compact-label { color: var(--color-error); }
    .usage-compact.state-unknown .usage-compact-label { color: var(--color-idle); }
    .usage-compact-sep { color: var(--text-dim); }
    .usage-compact-bucket { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .usage-compact-bucket.warn { color: var(--color-warning); }
    .usage-compact-bucket.over { color: var(--color-error); }
    .usage-compact-reset { color: var(--text-muted); }
    .usage-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 100;
      min-width: 440px;
      padding: var(--space-md) var(--space-lg);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      opacity: 0;
      visibility: hidden;
      transform: translateY(-4px);
      transition: opacity 150ms ease, transform 150ms ease, visibility 150ms;
      pointer-events: none;
      cursor: default;
    }
    .usage-popover .usage-panel {
      background: transparent;
      border: none;
      padding: 0;
    }
    .usage-compact:hover .usage-popover,
    .usage-compact:focus-within .usage-popover,
    .usage-compact[aria-expanded="true"] .usage-popover {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
      pointer-events: auto;
    }
    @media (prefers-reduced-motion: reduce) {
      .usage-popover { transition: opacity 0ms, visibility 0ms; transform: none; }
      .usage-compact:hover .usage-popover,
      .usage-compact:focus-within .usage-popover,
      .usage-compact[aria-expanded="true"] .usage-popover { transform: none; }
    }

    /* Health status chip (overview line cards) */
    .health-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      margin-top: var(--space-sm);
    }
    .health-chip .health-icon { font-size: 11px; }
    .health-chip.idle { background: var(--bg-elevated); color: var(--color-idle); }
    .health-chip.processing { background: var(--color-info-dim); color: var(--color-info); }
    .health-chip.queued { background: var(--color-warning-dim); color: var(--color-warning); }
    .health-chip.errors { background: var(--color-error-dim); color: var(--color-error); }

    /* Pipeline dots */
    .pipeline-dots {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      margin-top: var(--space-sm);
    }
    .pipeline-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--border-default);
    }
    .pipeline-dot.active { background: var(--color-success); }
    .pipeline-dot.queued { background: var(--color-warning); }
    .pipeline-connector {
      width: 12px;
      height: 1px;
      background: var(--border-default);
    }

    /* Activity */
    .activity { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: var(--space-lg); max-height: 400px; overflow-y: auto; }
    .activity h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); margin-bottom: var(--space-md); }
    .activity-entry { font-size: 12px; font-family: var(--font-mono); padding: var(--space-xs) 0; border-bottom: 1px solid var(--border-subtle); display: flex; gap: var(--space-md); }
    .activity-entry:last-child { border-bottom: none; }
    .activity-entry .time { color: var(--text-dim); min-width: 60px; }
    .activity-entry .line-tag { color: var(--color-info); min-width: 100px; font-size: 11px; }
    .activity-entry .event { color: var(--text-muted); min-width: 100px; }
    .activity-entry .detail { color: var(--text-secondary); }
    .activity-entry.error .event { color: var(--color-error); }
    .activity-entry.done .event { color: var(--color-success); }
    .activity-entry.routed .event { color: var(--color-info); }
    .activity-entry.escalated .event { color: var(--color-warning); }
    .activity-entry.trigger .event { color: #a78bfa; }

    /* Activity filter bar */
    .activity-filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-xs);
      margin-bottom: var(--space-md);
    }
    .activity-filter-btn {
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
    }
    .activity-filter-btn:hover {
      border-color: var(--text-secondary);
      color: var(--text-secondary);
    }
    .activity-filter-btn.active {
      background: var(--bg-elevated);
      border-color: var(--color-info);
      color: var(--color-info);
    }

    /* Clickable workpiece ID in activity */
    .activity-entry .wp-id-link {
      color: var(--color-info);
      cursor: pointer;
      font-size: 11px;
      min-width: 70px;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activity-entry .wp-id-link:hover { text-decoration: underline; }

    /* Collapsed retry group */
    .retry-group-header {
      font-size: 12px;
      font-family: var(--font-mono);
      padding: var(--space-xs) 0;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      gap: var(--space-md);
      cursor: pointer;
      color: var(--text-secondary);
    }
    .retry-group-header:hover { background: var(--bg-elevated); }
    .retry-group-header .retry-toggle {
      color: var(--text-dim);
      font-size: 10px;
      transition: transform 0.15s ease;
    }
    .retry-group-header .retry-toggle.expanded { transform: rotate(90deg); }
    .retry-group-header .wp-id-link {
      color: var(--color-info);
      cursor: pointer;
      font-size: 11px;
      min-width: 70px;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .retry-group-header .wp-id-link:hover { text-decoration: underline; }
    .retry-group-entries {
      display: none;
      padding-left: var(--space-lg);
      border-left: 2px solid var(--border-subtle);
      margin-left: var(--space-md);
    }
    .retry-group-entries.expanded { display: block; }

    /* Line detail header strip */
    .line-detail-header {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
      min-height: 32px;
      flex-wrap: wrap;
    }
    .ldh-nav {
      color: var(--color-info);
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ldh-nav:hover,
    .ldh-nav:focus-visible {
      text-decoration: underline;
    }
    .ldh-nav:focus-visible {
      outline: 2px solid var(--color-info);
      outline-offset: 2px;
      border-radius: 2px;
    }
    .ldh-title {
      display: flex;
      align-items: baseline;
      gap: var(--space-xs);
      min-width: 0;
      overflow: hidden;
    }
    .ldh-line-name {
      font-weight: 600;
      font-size: 15px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ldh-sep {
      color: var(--text-dim);
      flex-shrink: 0;
    }
    .ldh-description {
      color: var(--text-muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ldh-meta {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      flex-shrink: 0;
      font-size: 12px;
    }
    .ldh-meta .health-chip {
      margin: 0;
      font-size: 11px;
    }
    .ldh-timestamp {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    /* Kanban board */
    :root {
      --card-bg: var(--bg-elevated);
      --card-border: var(--border-default);
      --card-shadow: 0 1px 2px rgba(0,0,0,0.25);
      --lane-divider: var(--border-subtle);
      --status-info: var(--color-info);
      --status-muted: var(--text-muted);
      --status-active: var(--color-success);
      --status-check: #22d3ee;
      --status-warn: var(--color-warning);
      --status-ready: var(--color-info);
      --status-ok: var(--color-success);
      --status-danger: var(--color-error);
    }
    .kanban-board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 280px;
      gap: var(--space-sm);
      margin-bottom: var(--space-xl);
      padding: var(--space-md);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      overflow-x: auto;
      align-items: stretch;
      scroll-snap-type: x proximity;
    }
    .kanban-col {
      display: flex;
      flex-direction: column;
      min-width: 280px;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: var(--space-sm);
      scroll-snap-align: start;
    }
    .kanban-col.station-group { padding: 0; background: var(--bg-base); }
    .kanban-col-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: var(--space-xs);
      font-size: 12px;
      color: var(--text-secondary);
    }
    .kanban-col-header .col-title {
      font-weight: 600;
      color: var(--text-primary);
      text-transform: capitalize;
      letter-spacing: 0.01em;
    }
    .kanban-col-header .col-count {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .col-info {
      font-size: 11px;
      color: var(--text-dim);
      cursor: help;
      margin-left: 4px;
      opacity: 0.6;
    }
    .col-info:hover {
      opacity: 1;
    }
    .kanban-col.hot .kanban-col-header { color: var(--color-warning); }
    .kanban-col.over .kanban-col-header { color: var(--color-error); }
    .kanban-col.hot { border-color: var(--color-warning); background: var(--color-warning-dim); }
    .kanban-col.over { border-color: var(--color-error); background: var(--color-error-dim); }
    .kanban-col[data-col-key="held"] {
      border-left: 3px solid var(--status-info);
    }
    .kanban-col[data-col-key="held"] .kanban-empty {
      color: var(--text-muted);
      font-style: italic;
    }
    .kanban-station {
      display: grid;
      grid-template-rows: auto 1fr;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-base);
      min-width: 0;
      overflow: hidden;
    }
    .kanban-station-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: var(--space-sm);
      border-bottom: 1px solid var(--lane-divider);
      font-size: 13px;
    }
    .kanban-station-header .station-name {
      font-weight: 600;
      color: var(--text-primary);
    }
    .kanban-station-header .station-count {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .kanban-station.hot .kanban-station-header { background: var(--color-warning-dim); color: var(--color-warning); }
    .kanban-station.over .kanban-station-header { background: var(--color-error-dim); color: var(--color-error); }
    .kanban-station.hottest { box-shadow: 0 0 0 1px var(--color-warning); }

    /* Station freshness indicator */
    .station-freshness {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: var(--space-xs);
      cursor: default;
    }
    .station-freshness-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      transition: background-color 300ms ease;
    }
    .station-freshness-icon {
      font-size: 10px;
      line-height: 1;
    }
    .station-freshness.fresh .station-freshness-dot { background: var(--color-success); }
    .station-freshness.fresh .station-freshness-icon { color: var(--color-success); }
    .station-freshness.stale .station-freshness-dot { background: var(--color-warning); }
    .station-freshness.stale .station-freshness-icon { color: var(--color-warning); }
    .station-freshness.disconnected .station-freshness-dot { background: var(--color-error); }
    .station-freshness.disconnected .station-freshness-icon { color: var(--color-error); }
    .station-freshness.completed .station-freshness-dot { background: var(--text-dim); opacity: 0.5; }
    .station-freshness.completed .station-freshness-icon { color: var(--text-dim); }

    .kanban-lanes {
      display: flex;
      flex-direction: column;
      gap: 0;
      min-width: 0;
    }
    .kanban-lane {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm);
      min-height: 32px;
      border-bottom: 1px solid var(--lane-divider);
      min-width: 0;
    }
    .kanban-lane:last-child { border-bottom: none; }
    .kanban-col-body {
      min-width: 0;
      overflow: hidden;
    }
    .kanban-lane-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      font-family: var(--font-mono);
      margin-bottom: var(--space-xs);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .kanban-lane-label .lane-count {
      color: var(--text-muted);
    }
    .kanban-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-sm);
      font-size: 12px;
      cursor: pointer;
      box-shadow: var(--card-shadow);
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      overflow: hidden;
      transition: transform 300ms ease-out, opacity 300ms ease-out, border-color 150ms ease;
    }
    .kanban-card:hover { border-color: var(--color-info); }
    .kanban-card:focus-visible { outline: 2px solid var(--color-info); outline-offset: 1px; }
    .kanban-card .card-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-xs);
    }
    .kanban-card .card-id {
      font-family: var(--font-mono);
      color: var(--text-muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .kanban-card .card-state {
      font-family: var(--font-mono);
      font-size: 11px;
      flex-shrink: 0;
    }
    .kanban-card .card-title {
      color: var(--text-primary);
      font-size: 12px;
      line-height: 1.3;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-word;
    }
    .kanban-card .card-preview {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }
    .kanban-card .card-foot {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      gap: var(--space-sm);
      flex-wrap: wrap;
    }
    .kanban-card.state-running .card-state { color: var(--status-active); animation: kanban-pulse 2s infinite; }
    .kanban-card.state-evaluating .card-state { color: var(--status-check); }
    .kanban-card.state-retrying .card-state { color: var(--status-warn); }
    .kanban-card.state-waiting .card-state { color: var(--status-muted); }
    .kanban-card.state-held .card-state { color: var(--status-info); }
    .kanban-card.state-routed .card-state { color: var(--status-ready); }
    .kanban-card.state-done .card-state { color: var(--status-ok); }
    .kanban-card.state-failed { border-left: 3px solid var(--status-danger); }
    .kanban-card.state-failed .card-state { color: var(--status-danger); }
    .kanban-card.state-escalated .card-state { color: var(--status-warn); }
    .kanban-card.stuck { border-left: 3px solid var(--color-warning); }
    .kanban-card.in-flight { opacity: 0.5; }
    /* Done-card variant: title-first layout */
    .kanban-card.state-done .card-head-done {
      display: flex;
      align-items: baseline;
      gap: var(--space-xs);
    }
    .kanban-card.state-done .card-head-done .card-state {
      flex-shrink: 0;
      font-size: 13px;
    }
    .kanban-card.state-done .card-head-done .card-title-primary {
      color: var(--text-primary);
      font-weight: 600;
      font-size: 12px;
      line-height: 1.3;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-word;
      flex: 1;
    }
    .kanban-card.state-done .card-meta {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      gap: var(--space-sm);
      flex-wrap: wrap;
    }
    .kanban-card.state-done .card-id-row {
      display: flex;
      align-items: center;
      gap: 4px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-dim);
      overflow: hidden;
    }
    .kanban-card.state-done .card-id-row .card-id-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .kanban-card.state-done .copy-id-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-dim);
      font-size: 10px;
      padding: 0 2px;
      line-height: 1;
      opacity: 0.6;
      transition: opacity 150ms;
      flex-shrink: 0;
    }
    .kanban-card.state-done .copy-id-btn:hover {
      opacity: 1;
      color: var(--color-info);
    }
    .kanban-card.state-done .copy-id-btn.copied {
      color: var(--status-ok);
    }
    .kanban-card.entering { opacity: 0; transform: translateY(-4px); }
    .kanban-card.leaving { opacity: 0; transform: translateY(4px); }
    .kanban-empty {
      color: var(--text-dim);
      font-size: 10px;
      font-family: var(--font-mono);
      font-style: italic;
      padding: 2px 0;
      text-align: center;
    }
    .kanban-col-actions {
      display: flex;
      gap: var(--space-xs);
      margin-top: var(--space-sm);
    }
    .kanban-col-actions .release-all-btn { margin: 0; }

    /* Flow metrics row (Tier 4 #29) */
    .flow-metrics-row {
      display: flex;
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
      flex-wrap: wrap;
    }
    .flow-metric-tile {
      flex: 1 1 0;
      min-width: 140px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      padding: var(--space-md);
      cursor: default;
      transition: border-color 150ms;
    }
    .flow-metric-tile:hover {
      border-color: var(--color-info);
    }
    .flow-metric-tile .metric-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 500;
      letter-spacing: 0.05em;
      margin-bottom: var(--space-xs);
    }
    .flow-metric-tile .metric-value {
      font-size: 28px;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text-primary);
      line-height: 1.1;
    }
    .flow-metric-tile .metric-context {
      margin-top: var(--space-xs);
      font-size: 12px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: var(--space-xs);
    }
    .metric-delta.positive { color: var(--color-success); }
    .metric-delta.negative { color: var(--color-error); }
    .metric-context-live { color: var(--color-info); font-size: 11px; }
    .metric-sparkline svg { display: block; }

    /* Skeleton loading */
    .flow-metrics-skeleton {
      display: flex;
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
      flex-wrap: wrap;
    }
    .flow-metrics-skeleton .flow-metric-tile {
      position: relative;
      overflow: hidden;
    }
    .flow-metrics-skeleton .skeleton-line {
      height: 14px;
      background: var(--bg-elevated);
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .flow-metrics-skeleton .skeleton-line.large {
      height: 28px;
      width: 60%;
    }
    .flow-metrics-skeleton .skeleton-line.small {
      height: 10px;
      width: 40%;
    }
    @keyframes shimmer {
      0% { background-position: -200px 0; }
      100% { background-position: 200px 0; }
    }
    .flow-metrics-skeleton .skeleton-line {
      background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-surface) 50%, var(--bg-elevated) 75%);
      background-size: 200px 100%;
      animation: shimmer 1.5s infinite;
    }

    /* Empty state */
    .flow-metrics-empty {
      width: 100%;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      padding: var(--space-md);
      background: var(--bg-surface);
      border: 1px dashed var(--border-default);
      border-radius: var(--radius-sm);
      margin-bottom: var(--space-lg);
    }

    /* Responsive */
    @media (max-width: 900px) {
      .flow-metrics-row, .flow-metrics-skeleton { gap: var(--space-sm); }
      .flow-metric-tile { min-width: calc(50% - var(--space-sm)); flex: 0 0 calc(50% - var(--space-sm)); }
      .flow-metric-tile .metric-value { font-size: 24px; }
    }
    @media (max-width: 600px) {
      .flow-metric-tile { min-width: 100%; flex: 0 0 100%; }
    }

    /* Retry visualization */
    .retry-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--color-warning-dim);
      color: var(--color-warning);
      border: 1px solid var(--color-warning);
      line-height: 1.3;
    }
    .retry-badge::before { content: "\\21BB"; font-size: 12px; }
    .retry-badge.exhausted {
      background: var(--color-error-dim);
      color: var(--color-error);
      border-color: var(--color-error);
    }
    .retry-badge.exhausted::before { content: "\\2717"; }
    .backoff-timer {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-warning);
      margin-left: 6px;
    }
    .kanban-card.card-backoff { border: 1px dashed var(--color-warning); }
    .kanban-card.card-exhausted { border: 1px solid var(--color-error); }
    .card-retry-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 2px;
    }
    .col-retry-chip {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-warning);
      margin-left: 6px;
    }
    .col-retry-chip.exhausted { color: var(--color-error); }
    @keyframes kanban-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @media (prefers-reduced-motion: reduce) {
      .kanban-card, .kanban-card.state-running .card-state {
        transition: none !important;
        animation: none !important;
      }
      .kanban-card.entering, .kanban-card.leaving { opacity: 1; transform: none; }
      .retry-badge { transition: none; }
    }

    .silent-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-left: 4px;
      vertical-align: middle;
    }
    .silent-indicator.green { background: var(--color-success); }
    .silent-indicator.yellow { background: var(--color-warning); }
    .silent-indicator.red { background: var(--color-error); animation: pulse 1s infinite; }

    /* Drawer cost subline */
    .timeline-cost-line {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-dim);
      margin-top: 2px;
    }

    /* Drawer per-station tool-rounds subline */
    .timeline-rounds {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-muted);
      margin-top: 2px;
    }
    .timeline-rounds-turns {
      color: var(--text-secondary);
      font-weight: 500;
    }

    /* Prior attempts (retry history) */
    .timeline-prior-attempts {
      margin-top: 4px;
      font-size: 11px;
      color: var(--text-dim);
    }
    .timeline-prior-attempts details > summary {
      cursor: pointer;
      color: var(--text-muted);
      font-weight: 500;
    }
    .timeline-prior-attempts ol {
      margin: 4px 0 0 16px;
      padding: 0;
    }
    .timeline-prior-attempts li {
      margin-bottom: 2px;
    }

    /* Drawer totals footer */
    .drawer-totals {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      padding: var(--space-sm) var(--space-md);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      margin-bottom: var(--space-md);
      font-weight: 600;
    }

    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); margin-top: var(--space-lg); }
    @media (max-width: 800px) {
      .two-col { grid-template-columns: 1fr; }
      .line-grid { grid-template-columns: 1fr; }
    }

    /* Drawer overlay */
    .drawer-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 100;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }
    .drawer-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }

    /* Drawer panel */
    .drawer-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(560px, 90vw);
      background: var(--bg-base);
      border-left: 1px solid var(--border-default);
      z-index: 101;
      transform: translateX(100%);
      transition: transform 0.25s ease;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .drawer-panel.open {
      transform: translateX(0);
    }

    /* Drawer header */
    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: var(--space-lg) var(--space-xl);
      border-bottom: 1px solid var(--border-default);
      flex-shrink: 0;
    }
    .drawer-title {
      font-size: 14px;
      font-family: var(--font-mono);
      font-weight: 600;
      word-break: break-all;
    }
    .drawer-close {
      background: none;
      border: 1px solid var(--border-default);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 18px;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      line-height: 1;
      flex-shrink: 0;
    }
    .drawer-close:hover {
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    /* Drawer body */
    .drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--space-xl);
    }

    /* Drawer sections */
    .drawer-section {
      margin-bottom: var(--space-xl);
    }
    .drawer-section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: var(--space-md);
    }

    /* Drawer action bar (errored workpieces) */
    .drawer-actions {
      display: flex;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
    }
    .drawer-action-primary {
      background: var(--color-info);
      color: white;
      border: none;
      border-radius: var(--radius-sm);
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
    }
    .drawer-action-primary:hover { filter: brightness(1.1); }
    .drawer-action-primary:disabled { opacity: 0.5; cursor: default; }
    .drawer-action-danger {
      background: transparent;
      color: var(--color-error);
      border: 1px solid var(--color-error);
      border-radius: var(--radius-sm);
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
    }
    .drawer-action-danger:hover { background: var(--color-error-dim); }
    .drawer-action-danger.confirming { background: var(--color-error); color: white; }

    /* Workpiece meta */
    .drawer-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-sm) var(--space-lg);
      margin-bottom: var(--space-xl);
      padding: var(--space-md);
      background: var(--bg-surface);
      border-radius: var(--radius-sm);
    }
    .drawer-meta-item {
      font-size: 12px;
    }
    .drawer-meta-label {
      color: var(--text-muted);
      font-size: 11px;
    }
    .drawer-meta-value {
      font-family: var(--font-mono);
      color: var(--text-primary);
    }

    /* Task content */
    .drawer-task {
      font-size: 13px;
      color: var(--text-secondary);
      padding: var(--space-md);
      background: var(--bg-surface);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
    }

    /* Station timeline */
    .station-timeline {
      position: relative;
      padding-left: 20px;
    }
    .station-timeline::before {
      content: '';
      position: absolute;
      left: 5px;
      top: 8px;
      bottom: 8px;
      width: 2px;
      background: var(--border-default);
    }
    .timeline-entry {
      position: relative;
      margin-bottom: var(--space-lg);
      padding: var(--space-md);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
    }
    .timeline-entry:last-child {
      margin-bottom: 0;
    }
    .timeline-dot {
      position: absolute;
      left: -19px;
      top: 14px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid var(--border-default);
      background: var(--bg-base);
    }
    .timeline-entry.done .timeline-dot {
      background: var(--color-success);
      border-color: var(--color-success);
    }
    .timeline-entry.failed .timeline-dot {
      background: var(--color-error);
      border-color: var(--color-error);
    }
    .timeline-entry.escalated .timeline-dot {
      background: var(--color-warning);
      border-color: var(--color-warning);
    }
    .timeline-entry.skipped .timeline-dot {
      background: var(--text-dim);
      border-color: var(--text-dim);
    }
    .timeline-station-name {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-sm);
    }
    .timeline-status {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 500;
    }
    .timeline-status.done {
      background: var(--color-success-dim);
      color: var(--color-success);
    }
    .timeline-status.failed {
      background: var(--color-error-dim);
      color: var(--color-error);
    }
    .timeline-status.escalated {
      background: var(--color-warning-dim);
      color: var(--color-warning);
    }
    .timeline-status.skipped {
      background: var(--bg-elevated);
      color: var(--text-muted);
    }
    .timeline-metrics {
      display: flex;
      gap: var(--space-lg);
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      margin-bottom: var(--space-sm);
      flex-wrap: wrap;
    }
    .timeline-summary {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: var(--space-xs);
    }

    /* Eval result within timeline entry */
    .timeline-eval {
      margin-top: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      font-size: 11px;
    }
    .timeline-eval-header {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-xs);
      font-weight: 500;
    }
    .timeline-eval-pass {
      color: var(--color-success);
    }
    .timeline-eval-fail {
      color: var(--color-error);
    }
    .timeline-eval-feedback {
      color: var(--text-muted);
      font-size: 11px;
    }

    /* Error details */
    .drawer-error-detail {
      padding: var(--space-md);
      background: var(--color-error-dim);
      border: 1px solid var(--color-error);
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--text-primary);
      font-family: var(--font-mono);
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Retry history */
    .drawer-retry-entry {
      font-size: 12px;
      font-family: var(--font-mono);
      padding: var(--space-xs) 0;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }
    .drawer-retry-entry:last-child {
      border-bottom: none;
    }
    .drawer-retry-entry .time {
      color: var(--text-dim);
    }

    /* ─── Station Events (AI heartbeat stream) ────────────────────── */
    .station-events {
      margin-top: var(--space-sm);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-base);
      font-size: 11px;
    }
    .station-events > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      cursor: pointer;
      user-select: none;
      color: var(--text-secondary);
      list-style: none;
      font-weight: 500;
    }
    .station-events > summary::-webkit-details-marker { display: none; }
    .station-events > summary::before {
      content: '▶';
      font-size: 9px;
      color: var(--text-dim);
      transition: transform 0.15s;
    }
    .station-events[open] > summary::before { transform: rotate(90deg); }
    .station-events-count {
      margin-left: auto;
      color: var(--text-dim);
      font-size: 10px;
    }
    .freshness-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--text-dim);
    }
    .freshness-dot.live { background: #22c55e; }
    .freshness-dot.silent { background: #f59e0b; }
    .freshness-dot.done { background: var(--text-dim); }
    .freshness-dot.error { background: var(--color-error); }

    .station-events-body {
      max-height: 320px;
      overflow-y: auto;
      position: relative;
      padding: 4px 0;
    }
    .station-events-load-earlier {
      text-align: center;
      padding: 4px 8px;
      font-size: 10px;
      color: var(--color-info);
      cursor: pointer;
      border-bottom: 1px solid var(--border-subtle);
    }
    .station-events-load-earlier:hover { text-decoration: underline; }
    .station-events-rows { }
    .station-events-jump {
      position: sticky;
      bottom: 4px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      padding: 3px 10px;
      font-size: 10px;
      cursor: pointer;
      color: var(--text-secondary);
      display: none;
      width: fit-content;
      margin: 0 auto;
    }

    .event-row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 3px 8px;
      border-bottom: 1px solid var(--border-subtle);
      animation: evFadeIn 250ms ease;
    }
    .event-row:last-child { border-bottom: none; }
    @keyframes evFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .event-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
      font-size: 11px;
      margin-top: 1px;
    }
    .event-ts {
      flex-shrink: 0;
      color: var(--text-dim);
      font-size: 10px;
      min-width: 48px;
      margin-top: 1px;
    }
    .event-summary {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .event-summary:hover { text-decoration: underline; }
    .event-detail {
      display: none;
      margin-top: 3px;
      padding: 4px 6px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }
    .event-row.expanded .event-detail { display: block; }
    .event-row.expanded .event-summary { white-space: normal; }

    .event-row.kind-message .event-icon { color: var(--text-muted); }
    .event-row.kind-message .event-summary { color: var(--text-secondary); }
    .event-row.kind-tool_call .event-icon { color: #60a5fa; }
    .event-row.kind-tool_call .event-summary { color: #93c5fd; }
    .event-row.kind-tool_result-ok .event-icon { color: #22c55e; }
    .event-row.kind-tool_result-ok .event-summary { color: #86efac; }
    .event-row.kind-tool_result-err .event-icon { color: var(--color-error); }
    .event-row.kind-tool_result-err .event-summary { color: var(--color-error); }
    .event-row.kind-heartbeat .event-icon { color: var(--text-dim); }
    .event-row.kind-heartbeat .event-summary { color: var(--text-dim); }
    .event-row.kind-lifecycle .event-icon { color: #a78bfa; }
    .event-row.kind-lifecycle .event-summary { color: #c4b5fd; font-weight: 600; }

    .station-events-skeleton .skeleton-row {
      height: 20px;
      background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-surface) 50%, var(--bg-elevated) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.2s infinite;
      border-radius: 3px;
      margin: 4px 8px;
    }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .station-events-empty {
      padding: 8px;
      color: var(--text-dim);
      font-size: 10px;
      text-align: center;
    }
    .station-events-error {
      padding: 6px 8px;
      color: var(--color-error);
      font-size: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .station-events-retry-btn {
      font-size: 10px;
      color: var(--color-info);
      cursor: pointer;
      background: none;
      border: none;
      padding: 0;
      text-decoration: underline;
    }

    /* Clickable workpiece reference */
    .wp-ref {
      color: var(--color-info);
      cursor: pointer;
      text-decoration: none;
    }
    .wp-ref:hover {
      text-decoration: underline;
    }

    /* Completed/Error list items in detail view */
    .wp-list {
      margin-top: var(--space-md);
    }
    .wp-list-item {
      display: flex;
      align-items: flex-start;
      gap: var(--space-md);
      padding: var(--space-sm) var(--space-md);
      border-bottom: 1px solid var(--border-subtle);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .wp-list-item:hover {
      background: var(--bg-elevated);
    }
    .wp-list-item:last-child {
      border-bottom: none;
    }
    .wp-list-item .wp-id {
      font-family: var(--font-mono);
      color: var(--color-info);
      min-width: 120px;
      font-size: 11px;
    }
    .wp-list-item .wp-task {
      color: var(--text-secondary);
      flex: 1;
    }
    .wp-list-item .wp-status-dots {
      display: flex;
      gap: 3px;
      align-items: center;
    }

    /* Collapsible workpiece sections */
    .wp-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-md);
      overflow: hidden;
    }
    .wp-section-header {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-md) var(--space-lg);
      cursor: pointer;
      user-select: none;
      transition: background 0.1s;
    }
    .wp-section-header:hover {
      background: var(--bg-elevated);
    }
    .wp-section-header h2 {
      margin-bottom: 0;
      flex: 1;
    }
    .wp-section-toggle {
      color: var(--text-dim);
      font-size: 10px;
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }
    .wp-section-toggle.expanded {
      transform: rotate(90deg);
    }
    .wp-section-body {
      display: none;
      border-top: 1px solid var(--border-subtle);
    }
    .wp-section-body.expanded {
      display: block;
    }
    .wp-section .wp-list {
      margin-top: 0;
    }
    .wp-section .wp-list-item {
      padding: var(--space-sm) var(--space-lg);
    }
    .wp-list-item .wp-duration {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      min-width: 50px;
      text-align: right;
    }
    .wp-list-item .wp-time {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      min-width: 55px;
      text-align: right;
    }
    .wp-list-item .wp-failed-station {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-error);
      min-width: 80px;
    }
    .wp-section-empty {
      padding: var(--space-md) var(--space-lg);
      font-size: 12px;
      color: var(--text-dim);
    }

    /* Held section styles */
    .held-card { display: flex; align-items: center; gap: var(--space-md); }
    .held-card .wp-task { color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .held-card.in-flight { opacity: 0.5; transition: opacity 150ms ease; }
    @media (prefers-reduced-motion: reduce) { .held-card.in-flight { transition: none; } }
    .release-btn { background: var(--color-info-dim); color: var(--color-info); border: 1px solid var(--color-info); border-radius: var(--radius-sm); padding: 2px 10px; font-size: 12px; cursor: pointer; font-family: var(--font-ui); flex-shrink: 0; }
    .release-btn:hover:not(:disabled) { background: var(--color-info); color: #fff; }
    .release-btn:disabled { cursor: not-allowed; opacity: 0.6; }
    .release-all-btn { background: var(--color-warning-dim); color: var(--color-warning); border: 1px solid var(--color-warning); border-radius: var(--radius-sm); padding: 2px 10px; font-size: 12px; cursor: pointer; margin-left: var(--space-sm); font-family: var(--font-ui); }
    .wp-section-actions { display: inline-flex; margin-left: auto; gap: var(--space-sm); align-items: center; }
    .release-confirm { font-size: 12px; color: var(--text-secondary); }
    .release-confirm button { margin-left: var(--space-xs); }
    .hidden { display: none !important; }
    .toast { position: fixed; bottom: 24px; right: 24px; padding: var(--space-md) var(--space-lg); background: var(--bg-elevated); color: var(--text-primary); border-radius: var(--radius-md); border: 1px solid var(--border-default); font-size: 13px; opacity: 0; pointer-events: none; transform: translateY(8px); transition: opacity 180ms ease, transform 180ms ease; z-index: 9999; }
    .toast.visible { opacity: 1; transform: translateY(0); }
    @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }

    /* Drawer loading state */
    .drawer-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--text-muted);
      font-size: 13px;
    }

    .drawer-error-msg {
      padding: var(--space-lg);
      color: var(--color-error);
      text-align: center;
      font-size: 13px;
    }

    /* Dismiss button */
    .dismiss-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; padding: 2px 6px; margin-left: auto; opacity: 0.6; flex-shrink: 0; }
    .dismiss-btn:hover { opacity: 1; color: var(--color-error); }
    .dismiss-btn.undo:hover { color: var(--color-success); }
    .dismissed-toggle { font-size: 12px; color: var(--text-dim); cursor: pointer; padding: 8px var(--space-lg) 4px; }
    .dismissed-toggle:hover { color: var(--text-secondary); }
    .dismissed-list { display: none; }
    .dismissed-list.expanded { display: block; }
    .wp-list-item.dismissed { opacity: 0.5; }

    /* History table (Tier 4 #17) */
    .history-controls { display: flex; gap: var(--space-md); align-items: center; margin: var(--space-md) 0; font-size: 12px; color: var(--text-secondary); padding: 0 var(--space-lg); }
    .history-controls select, .history-controls input { background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 2px 6px; font: inherit; }
    .history-empty { padding: var(--space-md) var(--space-lg); font-size: 12px; color: var(--text-muted); }
    .history-table-wrap { overflow-x: auto; padding: 0 var(--space-md) var(--space-md); }
    .history-table { border-collapse: collapse; font-family: var(--font-mono); font-size: 11px; min-width: 100%; }
    .history-table th, .history-table td { padding: 4px 10px; border-bottom: 1px solid var(--border-subtle); text-align: right; white-space: nowrap; }
    .history-table th:first-child, .history-table td:first-child { text-align: left; color: var(--text-secondary); }
    .history-table thead th { color: var(--text-muted); font-weight: 500; }
    .history-table tr.history-stats-row td { border-top: 2px solid var(--border-default); color: var(--text-secondary); font-weight: 500; }
    .history-table tr.history-run-row td.history-cell-missing { color: var(--text-dim); }
    .history-table tr.history-run-row.source-error td.history-wp-id { color: var(--color-error); }
    .history-table tr.history-run-row td.history-wp-id { color: var(--color-info); cursor: pointer; }
    .history-table tr.history-run-row td.history-wp-id:hover { text-decoration: underline; }
    .history-table td.history-cell-duration { color: var(--text-primary); }
    /* Fetch-error inline banner */
    .fetch-error-banner { background: #2b2210; border: 1px solid #f59e0b44; border-radius: 6px; color: #f59e0b; font-size: 12px; padding: 8px 12px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .fetch-error-banner button { background: none; border: none; color: inherit; cursor: pointer; font-size: 16px; margin-left: auto; opacity: 0.7; padding: 0 4px; }
    .fetch-error-banner button:hover { opacity: 1; }
    /* Enter/exit animations for list rows */
    .just-added { animation: just-added-fade 220ms ease-out; }
    .just-removed { animation: just-removed-fade 220ms ease-in forwards; }
    @keyframes just-added-fade { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes just-removed-fade { from { opacity: 1; } to { opacity: 0; transform: translateY(-2px); } }
    @media (prefers-reduced-motion: reduce) { .just-added, .just-removed { animation: none; } }
  </style>
</head>
<body>
  <div id="app">
    <h1>Assembly</h1>
    <div class="subtitle" id="last-update">
      <span id="conn-dot" class="conn-dot conn-disconnected" aria-hidden="true"></span>
      <span id="conn-label" class="conn-label">Connecting\u2026</span>
      <span id="conn-ts" class="conn-ts"></span>
      <span id="usage-compact-mount"></span>
    </div>
    <div id="error-banner-mount"></div>
    <div id="fetch-error-banner-mount"></div>
    <div id="usage-panel-mount"></div>
    <div id="content"></div>
  </div>

  <div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer()"></div>
  <div class="drawer-panel" id="drawer-panel">
    <div class="drawer-header">
      <div class="drawer-title" id="drawer-title">Workpiece</div>
      <button class="drawer-close" onclick="closeDrawer()" title="Close (Esc)">&times;</button>
    </div>
    <div class="drawer-body" id="drawer-body">
      <div class="drawer-loading">Loading...</div>
    </div>
  </div>

  <script>${MORPHDOM_UMD}</script>
  <script>${DASHBOARD_CLIENT_JS}</script>
  <script>
    let viewState = 'overview';
    let selectedLine = null;
    let refreshTimer = null;
    let activityFilters = {};
    let progressTimers = {};
    let lastSuccessfulFetchMs = -1; // -1 sentinel = never fetched → disconnected
    var historyData = null;        // last fetched LineHistory
    var historyInclude = 'done';   // 'done' or 'done,error'
    var historyLimit = 10;
    var flowMetricsData = null;    // last fetched FlowMetrics
    // Client-side set of fileNames the user just dismissed; cleared once the server
    // catches up (the file no longer appears in the polled active-errors list).
    // Filters bannerErrors at every call site of updateErrorBanner so a poll firing
    // mid-dismiss can't repaint the banner with a still-active file.
    var _locallyDismissedFiles = new Set();
    let connectionHealthTimer = null;
    let stationFreshnessTimer = null;
    const CONN_LIVE_MS = 5000;
    const CONN_STALE_MS = 30000;
    const FRESHNESS_POLL_INTERVAL_MS = 30000; // matches FRESHNESS_POLL_INTERVAL_MS from dashboard-data.ts

    // Usage-limits panel — independent poll/render cycle.
    let usageTimer = null;
    let usageTickTimer = null;
    let lastUsagePayload = null;
    const USAGE_STALE_MS = 10 * 60 * 1000;

    async function loadUsage() {
      try {
        var res = await fetch('/api/usage');
        if (!res.ok) return;
        var data = await res.json();
        lastUsagePayload = data;
        renderUsagePanel(data);
      } catch (e) { /* leave last render in place */ }
    }

    function classifyUsageState(data) {
      if (!data || data.state === 'unknown') return 'unknown';
      if (data.ageMs != null && data.ageMs > USAGE_STALE_MS) return 'unknown';
      if (data.paused === true) return 'paused';
      var buckets = (data.providers && data.providers['claude-code'] && data.providers['claude-code'].buckets) || [];
      var maxUtil = 0;
      for (var i = 0; i < buckets.length; i++) { if (buckets[i].utilization > maxUtil) maxUtil = buckets[i].utilization; }
      if (maxUtil >= 50) return 'warn';
      return 'healthy';
    }

    function usageStateLabel(state) {
      if (state === 'paused') return '\\u23f8 Paused';
      if (state === 'warn') return '\\u25b2 Elevated';
      if (state === 'healthy') return '\\u25cf Active';
      return '\\u25cb Unknown';
    }

    function formatResetsIn(iso) {
      if (!iso) return '';
      var ms = new Date(iso).getTime() - Date.now();
      if (!isFinite(ms) || ms <= 0) return 'resets imminently';
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400); s %= 86400;
      var h = Math.floor(s / 3600); s %= 3600;
      var m = Math.floor(s / 60);
      if (d > 0) return 'resets in ' + d + 'd ' + h + 'h';
      if (h > 0) return 'resets in ' + h + 'h ' + m + 'm';
      if (m > 0) return 'resets in ' + m + 'm';
      return 'resets in <1m';
    }

    function formatCheckedAgo(ageMs) {
      if (ageMs == null || !isFinite(ageMs) || ageMs < 0) return '';
      var s = Math.floor(ageMs / 1000);
      if (s < 60) return 'last checked ' + s + 's ago';
      var m = Math.floor(s / 60);
      if (m < 60) return 'last checked ' + m + 'm ago';
      var h = Math.floor(m / 60);
      return 'last checked ' + h + 'h ago';
    }

    function usageBarClass(util, threshold) {
      if (util >= threshold) return 'over';
      if (util >= 50) return 'warn';
      return '';
    }

    function buildUsagePanelHtml(data, state) {
      var parts = [];
      if (state === 'unknown') {
        parts.push('<div class="usage-panel state-unknown">');
        parts.push('<div class="usage-header">');
        parts.push('<span class="usage-chip state-unknown">' + usageStateLabel(state) + '</span>');
        parts.push('<span class="usage-meta">no recent check (orchestrator may be stopped)</span>');
        parts.push('</div>');
        parts.push('</div>');
        return parts.join('');
      }
      var threshold = (data && typeof data.threshold === 'number') ? data.threshold : 75;
      parts.push('<div class="usage-panel state-' + state + '">');
      parts.push('<div class="usage-header">');
      parts.push('<span class="usage-chip state-' + state + '">' + usageStateLabel(state) + '</span>');
      parts.push('<span class="usage-meta">' + esc(formatCheckedAgo(data.ageMs)) + '</span>');
      parts.push('<span class="usage-meta-sep">\\u00b7</span>');
      parts.push('<span class="usage-meta">threshold ' + threshold + '%</span>');
      parts.push('</div>');
      if (state === 'paused' && data.pauseReason) {
        parts.push('<div class="usage-reason">Reason: ' + esc(data.pauseReason) + '</div>');
      }
      var buckets = (data.providers && data.providers['claude-code'] && data.providers['claude-code'].buckets) || [];
      if (buckets.length > 0) {
        parts.push('<div class="usage-buckets">');
        for (var i = 0; i < buckets.length; i++) {
          var b = buckets[i];
          var util = Math.max(0, Math.min(100, Number(b.utilization) || 0));
          var tickPct = Math.max(0, Math.min(100, Number(threshold) || 0));
          var cls = usageBarClass(util, threshold);
          parts.push('<div class="usage-bucket">');
          parts.push('<span class="usage-bucket-label">' + esc(b.label) + '</span>');
          parts.push('<div class="usage-bar-wrap">');
          parts.push('<div class="usage-bar-fill ' + cls + '" style="width:' + util.toFixed(1) + '%"></div>');
          parts.push('<div class="usage-bar-tick" style="left:' + tickPct.toFixed(1) + '%"></div>');
          parts.push('</div>');
          parts.push('<span class="usage-bucket-util">' + util.toFixed(1) + '%</span>');
          parts.push('<span class="usage-bucket-reset">' + esc(formatResetsIn(b.resets_at)) + '</span>');
          parts.push('</div>');
        }
        parts.push('</div>');
      } else if (data.providers && data.providers['claude-code'] && data.providers['claude-code'].error) {
        parts.push('<div class="usage-reason">Fetch error: ' + esc(data.providers['claude-code'].error) + '</div>');
      }
      parts.push('</div>');
      return parts.join('');
    }

    function formatResetsShort(iso) {
      if (!iso) return '';
      var ms = new Date(iso).getTime() - Date.now();
      if (!isFinite(ms) || ms <= 0) return 'resets now';
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400); s %= 86400;
      var h = Math.floor(s / 3600); s %= 3600;
      var m = Math.floor(s / 60);
      if (d > 0) return 'resets ' + d + 'd ' + h + 'h';
      if (h > 0) return 'resets ' + h + 'h ' + m + 'm';
      if (m > 0) return 'resets ' + m + 'm';
      return 'resets <1m';
    }

    function buildUsageCompactHtml(data, state) {
      var parts = [];
      if (state === 'unknown') {
        parts.push('<div class="usage-compact state-unknown" tabindex="0" role="button" aria-expanded="false" aria-label="Usage: no recent check"');
        parts.push(' onclick="toggleUsagePopover(event, this)" onkeydown="handleUsagePopoverKey(event, this)">');
        parts.push('<span class="usage-compact-dot state-unknown" aria-hidden="true"></span>');
        parts.push('<span class="usage-compact-label">Unknown</span>');
        parts.push('<span class="usage-compact-sep">\\u00b7</span>');
        parts.push('<span class="usage-compact-reset">no recent check</span>');
        parts.push('<div class="usage-popover" role="tooltip">' + buildUsagePanelHtml(data, state) + '</div>');
        parts.push('</div>');
        return parts.join('');
      }
      var threshold = (data && typeof data.threshold === 'number') ? data.threshold : 75;
      var buckets = (data.providers && data.providers['claude-code'] && data.providers['claude-code'].buckets) || [];
      var labelText = state === 'paused' ? 'Paused' : state === 'warn' ? 'Elevated' : 'Active';
      parts.push('<div class="usage-compact state-' + state + '" tabindex="0" role="button" aria-expanded="false" aria-label="Usage details"');
      parts.push(' onclick="toggleUsagePopover(event, this)" onkeydown="handleUsagePopoverKey(event, this)">');
      parts.push('<span class="usage-compact-dot state-' + state + '" aria-hidden="true"></span>');
      parts.push('<span class="usage-compact-label">' + labelText + '</span>');
      var soonest = null;
      for (var i = 0; i < buckets.length; i++) {
        var b = buckets[i];
        var util = Math.max(0, Math.min(100, Number(b.utilization) || 0));
        var cls = usageBarClass(util, threshold);
        // Abbreviate label: take text before first space ("5h session" -> "5h").
        // On collision (e.g. two 7d buckets) the popover disambiguates.
        var short = String(b.label || '').split(' ')[0] || b.label || '';
        parts.push('<span class="usage-compact-sep">\\u00b7</span>');
        parts.push('<span class="usage-compact-bucket ' + cls + '">' + esc(short) + ' ' + util.toFixed(0) + '%</span>');
        var t = b.resets_at ? new Date(b.resets_at).getTime() : 0;
        if (t && (!soonest || t < soonest)) soonest = t;
      }
      if (soonest) {
        parts.push('<span class="usage-compact-sep">\\u00b7</span>');
        parts.push('<span class="usage-compact-reset">' + esc(formatResetsShort(new Date(soonest).toISOString())) + '</span>');
      }
      parts.push('<div class="usage-popover" role="tooltip">' + buildUsagePanelHtml(data, state) + '</div>');
      parts.push('</div>');
      return parts.join('');
    }

    function renderUsagePanel(data) {
      var state = classifyUsageState(data);
      var fullMount = document.getElementById('usage-panel-mount');
      if (fullMount) fullMount.innerHTML = buildUsagePanelHtml(data, state);
      var compactMount = document.getElementById('usage-compact-mount');
      if (compactMount) {
        // Preserve open state across re-renders so hover-pinning survives polls.
        var prev = compactMount.querySelector('.usage-compact');
        var wasExpanded = prev && prev.getAttribute('aria-expanded') === 'true';
        compactMount.innerHTML = buildUsageCompactHtml(data, state);
        if (wasExpanded) {
          var next = compactMount.querySelector('.usage-compact');
          if (next) next.setAttribute('aria-expanded', 'true');
        }
      }
    }

    function toggleUsagePopover(event, el) {
      if (event) {
        event.stopPropagation();
        // Clicks inside the popover itself must not collapse it.
        if (event.target && event.target.closest && event.target.closest('.usage-popover')) return;
      }
      var expanded = el.getAttribute('aria-expanded') === 'true';
      el.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    }

    function handleUsagePopoverKey(event, el) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleUsagePopover(event, el);
      } else if (event.key === 'Escape') {
        el.setAttribute('aria-expanded', 'false');
        el.blur();
      }
    }

    // Click outside closes a pinned popover.
    document.addEventListener('click', function(ev) {
      var mount = document.getElementById('usage-compact-mount');
      if (!mount) return;
      var el = mount.querySelector('.usage-compact[aria-expanded="true"]');
      if (el && !el.contains(ev.target)) el.setAttribute('aria-expanded', 'false');
    });

    async function pollProgress(lineName, stationName, elementId) {
      try {
        var res = await fetch('/api/progress/' + encodeURIComponent(lineName) + '/' + encodeURIComponent(stationName));
        var data = await res.json();
        var el = document.getElementById(elementId);
        if (el && data.events && data.events.length > 0) {
          var latest = data.events[data.events.length - 1];
          var elapsed = latest.elapsed_s ? formatDuration(latest.elapsed_s * 1000) : '';
          var turnInfo = latest.turns ? 'turn ' + latest.turns : '';
          var parts = [latest.detail || '', turnInfo, elapsed].filter(Boolean);
          el.textContent = parts.join(' \\u00b7 ');
          el.title = latest.detail || '';
        }
      } catch(e) {}
    }

    function startProgressPolling(lineName, stationName, elementId) {
      var key = lineName + ':' + stationName;
      if (progressTimers[key]) return;
      pollProgress(lineName, stationName, elementId);
      progressTimers[key] = setInterval(function() {
        pollProgress(lineName, stationName, elementId);
      }, 3000);
    }

    function stopAllProgressPolling() {
      for (var key in progressTimers) {
        clearInterval(progressTimers[key]);
      }
      progressTimers = {};
    }

    // ─── Kanban board ──────────────────────────────────────────────
    window._kanbanPrev = window._kanbanPrev || null;
    window._kanbanPrevLine = window._kanbanPrevLine || null;
    // Track which card ids have already had their "exhausted" state announced
    // so the aria-live region only fires once per transition, not on every poll.
    window._retryExhaustedAnnounced = window._retryExhaustedAnnounced || {};

    function stateIcon(state) {
      if (state === 'held') return '\\u23f8';
      if (state === 'running') return '\\u21bb';
      if (state === 'evaluating') return '\\u25d0';
      if (state === 'retrying') return '\\u21ba';
      if (state === 'routed') return '\\u2192';
      if (state === 'done') return '\\u2713';
      if (state === 'failed') return '\\u2717';
      if (state === 'escalated') return '\\u26a0';
      return '\\u2026';
    }

    function formatCardCost(v) {
      if (v == null) return '';
      if (v >= 1) return '$' + v.toFixed(2);
      return '$' + v.toFixed(3);
    }

    function formatElapsedShort(iso) {
      if (!iso) return '';
      var ms = Date.now() - new Date(iso).getTime();
      if (ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h';
      return Math.floor(h / 24) + 'd';
    }

    function formatDuration(ms) {
      if (ms == null) return '';
      if (ms < 1000) return ms + 'ms';
      var seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + 's';
      var minutes = Math.floor(seconds / 60);
      var remainSec = seconds % 60;
      if (minutes < 60) return minutes + 'm' + (remainSec > 0 ? ' ' + remainSec + 's' : '');
      var hours = Math.floor(minutes / 60);
      var remainMin = minutes % 60;
      return hours + 'h' + (remainMin > 0 ? ' ' + remainMin + 'm' : '');
    }

    function buildCardDurationLabel(card) {
      // Processing: time since station started processing
      if (card.lane === 'processing' && card.stationStartedAt) {
        return formatElapsedShort(card.stationStartedAt) + ' in ' + (card.station || '?');
      }
      // Station inbox: time waiting in station queue
      if (card.lane === 'inbox' && card.station && card.enteredColumnAt) {
        return formatElapsedShort(card.enteredColumnAt) + ' waiting';
      }
      // Station output: time since station completed
      if (card.lane === 'output' && card.enteredColumnAt) {
        return formatElapsedShort(card.enteredColumnAt) + ' routed';
      }
      // Line inbox / held: time since queued
      if (card.enteredColumnAt) {
        return formatElapsedShort(card.enteredColumnAt) + ' queued';
      }
      return '\u2014';
    }

    function buildCardDurationTooltip(card) {
      var parts = [];
      if (card.firstStationStartedAt) {
        parts.push('enqueued ' + formatElapsedShort(card.firstStationStartedAt) + ' ago');
      }
      if (card.stationStartedAt && card.station) {
        parts.push('started ' + card.station + ' ' + formatElapsedShort(card.stationStartedAt) + ' ago');
      }
      if (card.totalElapsedMs != null && card.totalElapsedMs >= 0) {
        parts.push('total: ' + formatDuration(card.totalElapsedMs));
      }
      if (card.enteredColumnAt) {
        parts.push('in current queue ' + formatElapsedShort(card.enteredColumnAt));
      }
      return parts.length > 0 ? parts.join(' \u00b7 ') : '';
    }

    function copyCardId(event, id) {
      event.stopPropagation();
      var btn = event.currentTarget;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(function() {
          btn.textContent = '\u2713';  // checkmark
          btn.classList.add('copied');
          setTimeout(function() {
            btn.textContent = '\u2398';  // clipboard icon
            btn.classList.remove('copied');
          }, 1500);
        });
      }
    }

    function renderKanbanCard(card) {
      var cls = 'kanban-card state-' + card.state;
      var ageMs = card.enteredColumnAt ? Date.now() - new Date(card.enteredColumnAt).getTime() : 0;
      if ((card.lane === 'inbox' || card.column === 'inbox' || card.column === 'held') && ageMs > 15 * 60 * 1000) {
        cls += ' stuck';
      }
      if (window._inFlightReleaseIds && window._inFlightReleaseIds.has(card.fileName)) cls += ' in-flight';
      if (card.retry && card.retry.retry_count > 0) {
        if (card.retry.exhausted) cls += ' card-exhausted';
        else if (card.retry.in_backoff) cls += ' card-backoff';
      }

      var html = '<div class="' + cls + '" tabindex="0" role="button" data-key="' + escapeJs(card.fileName) + '" data-file="' + escapeJs(card.fileName) + '" data-column="' + escapeJs(card.column) + '"';
      html += ' title="' + esc(card.id) + '\\u2014' + esc(card.title) + '"';
      html += ' onclick="openDrawer(\\'' + escapeJs(selectedLine) + '\\', \\'' + escapeJs(card.fileName) + '\\')"';
      html += ' onkeydown="onKanbanCardKeydown(event, \\'' + escapeJs(card.fileName) + '\\')"';
      html += '>';

      // Done-card variant: title-first layout
      if (card.column === 'done') {
        // Primary line: outcome icon + title
        html += '<div class="card-head-done">';
        html += '<span class="card-state" aria-label="' + esc(card.state) + '">' + stateIcon(card.state) + '</span>';
        html += '<span class="card-title-primary">' + esc(card.title || card.id) + '</span>';
        html += '</div>';
        // Preview line (if present)
        if (card.preview) {
          html += '<div class="card-preview">' + esc(card.preview) + '</div>';
        }
        // Meta line: relative time, duration, cost
        var metaParts = [];
        if (card.finished_at) {
          metaParts.push('<span title="' + esc(card.finished_at) + '">\\u23f1 ' + formatElapsedShort(card.finished_at) + ' ago</span>');
        } else if (card.enteredColumnAt) {
          metaParts.push('<span title="' + esc(card.enteredColumnAt) + '">\\u23f1 ' + formatElapsedShort(card.enteredColumnAt) + ' ago</span>');
        }
        if (card.duration_ms != null) {
          metaParts.push('\\u23f1 ' + formatDuration(card.duration_ms));
        }
        if (card.costUsd && card.costUsd > 0) {
          metaParts.push(formatCardCost(card.costUsd));
        }
        if (card.evalScore != null) {
          metaParts.push('\\u25d0 ' + card.evalScore);
        }
        if (metaParts.length > 0) {
          html += '<div class="card-meta">' + metaParts.join(' \\u00b7 ') + '</div>';
        }
        // Run ID row: small muted ID + copy button
        html += '<div class="card-id-row">';
        html += '<span class="card-id-text">' + esc(card.id) + '</span>';
        html += '<button class="copy-id-btn" aria-label="Copy run ID" title="Copy run ID" onclick="copyCardId(event, \\'' + escapeJs(card.id) + '\\')">\u2398</button>';
        html += '</div>';
        html += '</div>';
        return html;
      }

      html += '<div class="card-head">';
      html += '<span class="card-id">' + esc(card.id) + '</span>';
      html += '<span class="card-state" aria-label="' + esc(card.state) + '">' + stateIcon(card.state) + '</span>';
      html += '</div>';
      html += '<div class="card-title">' + esc(card.title || '') + '</div>';
      if (card.preview) {
        html += '<div class="card-preview">' + esc(card.preview) + '</div>';
      }
      var footParts = [];
      var durLabel = buildCardDurationLabel(card);
      var durTooltip = buildCardDurationTooltip(card);
      footParts.push('<span' + (durTooltip ? ' title="' + esc(durTooltip) + '"' : '') + '>\\u23f1 ' + esc(durLabel) + '</span>');
      if (card.retries && card.retries > 0) footParts.push('<span>\\u21ba ' + card.retries + '</span>');
      if (card.costUsd && card.costUsd > 0) footParts.push('<span>' + formatCardCost(card.costUsd) + '</span>');
      if (card.evalScore != null) footParts.push('<span>\\u25d0 ' + card.evalScore + '</span>');
      html += '<div class="card-foot">' + footParts.join(' \\u00b7 ') + '</div>';
      // Retry row (visible only when card.retry exists with retry_count > 0)
      if (card.retry && card.retry.retry_count > 0) {
        var retryBadgeCls = 'retry-badge' + (card.retry.exhausted ? ' exhausted' : '');
        var backoffSecs = (card.retry.in_backoff && card.retry.backoff_until && !card.retry.exhausted)
          ? Math.max(0, Math.round((new Date(card.retry.backoff_until).getTime() - Date.now()) / 1000))
          : null;
        var retryLabel;
        if (card.retry.exhausted) {
          retryLabel = 'Retries exhausted after ' + card.retry.retry_count + ' attempts';
        } else if (backoffSecs != null) {
          retryLabel = 'Attempt ' + card.retry.retry_count + ' of ' + card.retry.max_retries + ', retrying in ' + backoffSecs + ' seconds';
        } else {
          retryLabel = 'Attempt ' + card.retry.retry_count + ' of ' + card.retry.max_retries;
        }
        // role=status + aria-live=polite only on the first poll where the card is exhausted,
        // so screen readers announce the terminal state once (not on every subsequent poll).
        var liveAttrs = '';
        if (card.retry.exhausted) {
          if (!window._retryExhaustedAnnounced[card.id]) {
            liveAttrs = ' role="status" aria-live="polite"';
            window._retryExhaustedAnnounced[card.id] = true;
          }
        } else if (window._retryExhaustedAnnounced[card.id]) {
          // Card left exhausted state (e.g., moved to error queue and back); allow re-announce next time.
          delete window._retryExhaustedAnnounced[card.id];
        }
        html += '<div class="card-retry-row">';
        html += '<span class="' + retryBadgeCls + '"' + liveAttrs + ' aria-label="' + esc(retryLabel) + '">' + card.retry.retry_count + '/' + card.retry.max_retries + '</span>';
        if (backoffSecs != null) {
          html += '<span class="backoff-timer" data-backoff-until="' + esc(card.retry.backoff_until) + '">retry in ' + backoffSecs + 's</span>';
        }
        html += '</div>';
      }
      if (card.column === 'held') {
        var inFlight = window._inFlightReleaseIds && window._inFlightReleaseIds.has(card.fileName);
        html += '<button class="release-btn" data-held-file="' + escapeJs(card.fileName) + '"' + (inFlight ? ' disabled' : '') + ' aria-label="Release task ' + escapeJs(card.id) + '" onclick="event.stopPropagation(); releaseCard(\\'' + escapeJs(card.fileName) + '\\')">\\u25b6 Release</button>';
      }
      html += '</div>';
      return html;
    }

    function renderRetryChips(col) {
      var chips = '';
      if (col.retrying_count && col.retrying_count > 0) {
        chips += '<span class="col-retry-chip"> · ↻ ' + col.retrying_count + '</span>';
      }
      if (col.exhausted_count && col.exhausted_count > 0) {
        chips += '<span class="col-retry-chip exhausted"> · ✗ ' + col.exhausted_count + '</span>';
      }
      return chips;
    }

    function renderKanbanColumn(col) {
      var headerClass = '';
      if (col.wipLimit && col.count > col.wipLimit * 2) headerClass = ' over';
      else if (col.wipLimit && col.count > col.wipLimit) headerClass = ' hot';
      var emptyMsg = col.key === 'held' ? 'No held tasks' : 'No items';
      var cardsHtml = col.cards.length === 0
        ? '<div class="kanban-empty">' + emptyMsg + '</div>'
        : col.cards.map(renderKanbanCard).join('');
      var tooltipHtml = col.tooltip ? '<span class="col-info" title="' + esc(col.tooltip) + '">\u24d8</span>' : '';
      var html = '<div class="kanban-col' + headerClass + '" data-col-key="' + escapeJs(col.key) + '">';
      html += '<div class="kanban-col-header"><span class="col-title">' + esc(col.title) + '</span><span class="col-count">' + col.count + '</span>' + renderRetryChips(col) + tooltipHtml + '</div>';
      html += '<div class="kanban-col-body" data-col-body="' + escapeJs(col.key) + '">' + cardsHtml + '</div>';
      if (col.key === 'held' && col.count > 0) {
        html += '<div class="kanban-col-actions" onclick="event.stopPropagation()">';
        html += '<button class="release-all-btn" id="release-all-btn" onclick="onReleaseAllClick(event)" aria-label="Release all held tasks">Release all (' + col.count + ')</button>';
        html += '<span id="release-all-confirm" class="release-confirm hidden">Release all ' + col.count + '? <button onclick="releaseAllHeld()">Yes</button> <button onclick="cancelReleaseAll()">Cancel</button></span>';
        html += '</div>';
      }
      html += '</div>';
      return html;
    }

    function renderKanbanStationGroup(stationName, lanes, freshness) {
      var total = 0;
      var stationRetrying = 0;
      var stationExhausted = 0;
      for (var i = 0; i < lanes.length; i++) {
        total += lanes[i].count;
        stationRetrying += lanes[i].retrying_count || 0;
        stationExhausted += lanes[i].exhausted_count || 0;
      }
      var wipLimit = lanes[0] && lanes[0].wipLimit;
      var heat = '';
      if (wipLimit && total > wipLimit * 2) heat = ' over';
      else if (wipLimit && total > wipLimit) heat = ' hot';
      var html = '<div class="kanban-col station-group"><div class="kanban-station' + heat + '" data-station="' + escapeJs(stationName) + '">';
      var stationChips = '';
      if (stationRetrying > 0) stationChips += '<span class="col-retry-chip"> · ↻ ' + stationRetrying + '</span>';
      if (stationExhausted > 0) stationChips += '<span class="col-retry-chip exhausted"> · ✗ ' + stationExhausted + '</span>';

      // Build freshness indicator HTML
      var freshnessHtml = '';
      if (freshness) {
        var iconMap = { fresh: '\u2713', stale: '\u23f1', disconnected: '\u2717', completed: '\u2014' };
        var icon = iconMap[freshness.state] || '';
        freshnessHtml = '<span class="station-freshness ' + freshness.state + '" tabindex="0" role="status" ';
        freshnessHtml += 'aria-label="' + esc(freshness.label) + '" title="' + esc(freshness.label) + '" ';
        freshnessHtml += 'data-station-last-update="' + (freshness.last_updated_at || '') + '" ';
        freshnessHtml += 'data-station-state="' + freshness.state + '">';
        freshnessHtml += '<span class="station-freshness-dot" aria-hidden="true"></span>';
        freshnessHtml += '<span class="station-freshness-icon" aria-hidden="true">' + icon + '</span>';
        freshnessHtml += '</span>';
      }

      html += '<div class="kanban-station-header"><span class="station-name">' + esc(stationName) + '</span>' + freshnessHtml + '<span class="station-count">' + total + '</span>' + stationChips + '</div>';
      html += '<div class="kanban-lanes">';
      for (var j = 0; j < lanes.length; j++) {
        var lane = lanes[j];
        var laneTooltip = lane.tooltip ? '<span class="col-info" title="' + esc(lane.tooltip) + '">\u24d8</span>' : '';
        html += '<div class="kanban-lane" data-col-key="' + escapeJs(lane.key) + '">';
        html += '<div class="kanban-lane-label"><span>' + esc(lane.title) + '</span><span class="lane-count">' + lane.count + '</span>' + laneTooltip + '</div>';
        html += '<div class="kanban-col-body" data-col-body="' + escapeJs(lane.key) + '">';
        html += lane.cards.length === 0 ? '<div class="kanban-empty">No items</div>' : lane.cards.map(renderKanbanCard).join('');
        html += '</div>';
        html += '</div>';
      }
      html += '</div></div></div>';
      return html;
    }

    function renderKanban(kb) {
      if (!kb || !kb.columns) return '';
      // Group columns by station (a station has three lanes: inbox/processing/output)
      var grouped = [];
      var lanesByStation = {};
      for (var i = 0; i < kb.columns.length; i++) {
        var col = kb.columns[i];
        if (col.station) {
          if (!lanesByStation[col.station]) {
            lanesByStation[col.station] = [];
            grouped.push({ type: 'station', station: col.station });
          }
          lanesByStation[col.station].push(col);
        } else {
          grouped.push({ type: 'col', col: col });
        }
      }
      var parts = [];
      for (var k = 0; k < grouped.length; k++) {
        var g = grouped[k];
        if (g.type === 'col') parts.push(renderKanbanColumn(g.col));
        else {
          var freshness = kb.stationFreshness ? kb.stationFreshness[g.station] : null;
          parts.push(renderKanbanStationGroup(g.station, lanesByStation[g.station], freshness));
        }
      }
      return parts.join('');
    }

    function collectCardsMap(kb) {
      var out = {};
      if (!kb || !kb.columns) return out;
      for (var i = 0; i < kb.columns.length; i++) {
        var cards = kb.columns[i].cards;
        for (var j = 0; j < cards.length; j++) out[cards[j].fileName] = cards[j].column;
      }
      return out;
    }

    function applyKanban(kb) {
      var mount = document.getElementById('kanban-board');
      if (!mount) return;
      var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var prev = (window._kanbanPrevLine === selectedLine) ? window._kanbanPrev : null;
      var prevMap = collectCardsMap(prev);

      // Capture old positions for FLIP
      var oldRects = {};
      if (!reducedMotion && prev) {
        var oldCards = mount.querySelectorAll('.kanban-card');
        for (var i = 0; i < oldCards.length; i++) {
          var key = oldCards[i].getAttribute('data-key');
          if (key) oldRects[key] = oldCards[i].getBoundingClientRect();
        }
      }

      mount.innerHTML = renderKanban(kb);

      // FLIP animate cards that moved columns
      if (!reducedMotion && prev) {
        var newCards = mount.querySelectorAll('.kanban-card');
        for (var j = 0; j < newCards.length; j++) {
          var card = newCards[j];
          var key = card.getAttribute('data-key');
          var newCol = card.getAttribute('data-column');
          var oldCol = prevMap[key];
          if (!key) continue;
          if (!oldCol) {
            card.classList.add('entering');
            (function(el) { requestAnimationFrame(function() { el.classList.remove('entering'); }); })(card);
          } else if (oldCol !== newCol && oldRects[key]) {
            var oldRect = oldRects[key];
            var newRect = card.getBoundingClientRect();
            var dx = oldRect.left - newRect.left;
            var dy = oldRect.top - newRect.top;
            if (dx !== 0 || dy !== 0) {
              card.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
              card.style.transition = 'transform 0s';
              (function(el) {
                requestAnimationFrame(function() {
                  el.style.transition = 'transform 350ms ease-out';
                  el.style.transform = '';
                  setTimeout(function() { el.style.transition = ''; }, 360);
                });
              })(card);
            }
          }
        }
      }

      window._kanbanPrev = kb;
      window._kanbanPrevLine = selectedLine;
    }

    async function loadKanban(lineName) {
      if (!lineName) return;
      try {
        var res = await fetch('/api/line/' + encodeURIComponent(lineName) + '/kanban');
        if (!res.ok) return;
        var kb = await res.json();
        if (kb && kb.columns && selectedLine === lineName) { applyKanban(kb); if (typeof AssemblyDashboard !== 'undefined') AssemblyDashboard.startBackoffTickers(); }
      } catch (e) {}
    }

    async function loadFlowMetrics(lineName) {
      if (!lineName) return;
      try {
        var res = await fetch('/api/line/' + encodeURIComponent(lineName) + '/flow-metrics');
        if (!res.ok) return;
        var data = await res.json();
        flowMetricsData = data;
        var mount = document.getElementById('flow-metrics-row');
        if (mount && typeof AssemblyDashboard !== 'undefined') {
          mount.innerHTML = AssemblyDashboard.buildMetricsRow(flowMetricsData);
        }
      } catch (e) {
        // Metrics are non-critical; swallow fetch errors
      }
    }

    function onKanbanCardKeydown(ev, fileName) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openDrawer(selectedLine, fileName);
      }
    }

    function toggleActivityFilter(eventType) {
      if (activityFilters[eventType] === false) {
        delete activityFilters[eventType];
      } else {
        activityFilters[eventType] = false;
      }
      refresh();
    }

    function toggleRetryGroup(groupId) {
      var entries = document.getElementById('retry-entries-' + groupId);
      var toggle = document.getElementById('retry-toggle-' + groupId);
      if (entries) {
        entries.classList.toggle('expanded');
      }
      if (toggle) {
        toggle.classList.toggle('expanded');
      }
    }

    function toggleSection(sectionId) {
      var body = document.getElementById('section-body-' + sectionId);
      var toggle = document.getElementById('section-toggle-' + sectionId);
      if (body) { body.classList.toggle('expanded'); }
      if (toggle) { toggle.classList.toggle('expanded'); }
      var isExpanded = body && body.classList.contains('expanded');
      try {
        localStorage.setItem('assembly-dash-section-' + sectionId, isExpanded ? '1' : '0');
      } catch(e) {}
    }

    function isSectionExpanded(sectionId) {
      try {
        return localStorage.getItem('assembly-dash-section-' + sectionId) === '1';
      } catch(e) {
        return false;
      }
    }

    function loadHistory() {
      if (!selectedLine) return;
      var url = '/api/line/' + encodeURIComponent(selectedLine) + '/history?limit=' + historyLimit + '&include=' + encodeURIComponent(historyInclude);
      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && !data.error) {
            historyData = data;
            var el = document.getElementById('history-section-body');
            if (el) el.innerHTML = AssemblyDashboard.renderHistoryInner(historyData, { historyInclude: historyInclude, historyLimit: historyLimit, selectedLine: selectedLine });
          }
        })
        .catch(function() { /* ignore; section shows Loading... until retry */ });
    }

    function setHistoryInclude(val) {
      historyInclude = val;
      loadHistory();
    }

    function setHistoryLimit(val) {
      var n = parseInt(val, 10);
      if (!isFinite(n) || n < 1) n = 10;
      if (n > 50) n = 50;
      historyLimit = n;
      loadHistory();
    }

    function startRefresh(intervalMs) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(refresh, intervalMs);
    }

    async function refresh() {
      try {
        if (viewState === 'overview') {
          const res = await fetch('/api/state');
          const data = await res.json();
          renderOverview(data);
          lastSuccessfulFetchMs = Date.now();
          updateConnectionIndicator();
        } else {
          const res = await fetch('/api/line/' + encodeURIComponent(selectedLine));
          const data = await res.json();
          if (data.error) {
            var fetchErrMount = document.getElementById('fetch-error-banner-mount');
            if (fetchErrMount) fetchErrMount.innerHTML = '<div class="fetch-error-banner">\u26a0 ' + esc(data.error) + '<button onclick="this.parentNode.parentNode.innerHTML=&#39;&#39;" title="Dismiss">&times;</button></div>';
          } else {
            // Reconcile in-flight release ids before re-rendering
            if (data && data.held && window._inFlightReleaseIds && window._inFlightReleaseIds.size > 0) {
              var liveHeldSet = new Set(data.held.map(function (h) { return h.fileName; }));
              var staleIds = [];
              window._inFlightReleaseIds.forEach(function (fn) { if (!liveHeldSet.has(fn)) staleIds.push(fn); });
              staleIds.forEach(function (fn) { window._inFlightReleaseIds.delete(fn); });
            }
            renderDetail(data);
            lastSuccessfulFetchMs = Date.now();
            updateConnectionIndicator();
          }
        }
      } catch (err) {
        // Do not advance lastSuccessfulFetchMs; the 1s ticker will downgrade
        // the indicator to stale/disconnected as the gap grows.
        updateConnectionIndicator();
      }
    }

    function buildErrorBanner(allErrors, contextLineName) {
      if (!allErrors || allErrors.length === 0) return '';
      var count = allErrors.length;
      var latest = allErrors[0];
      var failedStation = (latest.failed && latest.failed.length > 0) ? latest.failed[0].station : 'unknown';
      var summaryText = count + ' error' + (count !== 1 ? 's' : '') + ' \\u2014 last: ' + failedStation + ' failed for ' + (latest.task || latest.id);
      var clickLine = contextLineName || (latest._line || '');
      var clickId = latest.id || '';
      var clickFile = latest.fileName || '';
      // Collect all fileNames for bulk dismiss
      var allFileNames = allErrors.map(function(e) { return e.fileName; }).filter(Boolean);
      return '<div class="error-banner">' +
        '<div class="error-banner-content" onclick="handleErrorClick(\\'' + escapeJs(clickLine) + '\\', \\'' + escapeJs(clickId) + '\\', \\'' + escapeJs(clickFile) + '\\')">' +
        '<span class="error-banner-icon">\\u26a0</span>' +
        '<span>' + esc(summaryText) + '</span>' +
        '</div>' +
        '<button class="error-banner-dismiss" onclick="dismissErrors(\\'' + escapeJs(clickLine) + '\\', ' + JSON.stringify(allFileNames) + ')" title="Dismiss">\\u00d7</button>' +
        '</div>';
    }

    // Apply .hiding, then clear innerHTML once the CSS transition ends.
    // 350ms safety net covers reduced-motion / display:none / detached cases
    // where transitionend would never fire.
    function hideMountWithTransition(mount) {
      mount.classList.add('hiding');
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        mount.removeEventListener('transitionend', finish);
        clearTimeout(timer);
        mount.innerHTML = '';
        mount.setAttribute('data-banner-key', '');
      }
      mount.addEventListener('transitionend', finish);
      var timer = setTimeout(finish, 350);
    }

    function updateErrorBanner(bannerErrors, contextLineName) {
      var mount = document.getElementById('error-banner-mount');
      if (!mount) return;

      // Reconcile: any locally-dismissed file the server's active list no longer
      // contains has been confirmed; drop it so a future server-side undismiss
      // (or a re-emitted error with the same fileName) can repaint normally.
      var serverActiveFiles = new Set(
        (bannerErrors || []).map(function(e) { return e && e.fileName; }).filter(Boolean)
      );
      _locallyDismissedFiles.forEach(function(fn) {
        if (!serverActiveFiles.has(fn)) _locallyDismissedFiles.delete(fn);
      });

      // Defensive: drop any locally-dismissed entries even if the call site forgot
      // to filter. Makes updateErrorBanner idempotent w.r.t. recent dismisses.
      bannerErrors = (bannerErrors || []).filter(function(e) {
        return e && e.fileName && !_locallyDismissedFiles.has(e.fileName);
      });

      // Compute stable key from sorted _line:fileName pairs
      var newKey = '';
      if (bannerErrors.length > 0) {
        newKey = bannerErrors.map(function(e) { return (e._line || '') + ':' + (e.fileName || ''); }).sort().join('|');
      }
      var currentKey = mount.getAttribute('data-banner-key') || '';

      // If identical data, skip DOM update entirely
      if (newKey === currentKey) return;

      mount.setAttribute('data-banner-key', newKey);

      if (bannerErrors.length === 0) {
        hideMountWithTransition(mount);
        return;
      }

      // Determine highest severity
      var hasCritical = bannerErrors.some(function(e) { return e.severity === 'critical'; });
      var severityClass = hasCritical ? 'severity-critical' : 'severity-warning';
      var severityLabel = hasCritical ? 'CRITICAL' : 'WARNING';
      var severityIcon = '\\u26a0';

      var count = bannerErrors.length;
      var latest = bannerErrors[0];
      var failedStation = (latest.failed && latest.failed.length > 0) ? latest.failed[0].station : 'unknown';
      var summaryText = count + ' error' + (count !== 1 ? 's' : '') + ' \\u2014 last: ' + failedStation + ' failed for ' + (latest.task || latest.id);

      // Freshness sublabel
      var freshness = '';
      if (latest.finished_at) {
        var ageMs = Date.now() - new Date(latest.finished_at).getTime();
        freshness = formatDuration(ageMs) + ' ago';
      }

      var clickLine = contextLineName || (latest._line || '');
      var clickId = latest.id || '';
      var clickFile = latest.fileName || '';
      var allFileNames = bannerErrors.map(function(e) { return e.fileName; }).filter(Boolean);

      var html = '<div class="error-banner ' + severityClass + '">' +
        '<div class="error-banner-content" onclick="handleErrorClick(\\'' + escapeJs(clickLine) + '\\', \\'' + escapeJs(clickId) + '\\', \\'' + escapeJs(clickFile) + '\\')">' +
        '<span class="error-banner-severity-label">' + severityLabel + '</span>' +
        '<span class="error-banner-icon">' + severityIcon + '</span>' +
        '<span>' + esc(summaryText) + '</span>' +
        (freshness ? '<span class="error-banner-freshness">' + esc(freshness) + '</span>' : '') +
        '</div>' +
        '<button class="error-banner-dismiss" onclick="event.stopPropagation(); event.preventDefault(); dismissErrors(\\'' + escapeJs(clickLine) + '\\', ' + JSON.stringify(allFileNames) + ')" title="Dismiss">\\u00d7</button>' +
        '</div>';

      mount.classList.remove('hiding');
      mount.innerHTML = html;
    }

    function healthIcon(state) {
      if (state === 'idle') return '\\u2713';
      if (state === 'processing') return '\\u21bb';
      if (state === 'queued') return '\\u25b3';
      if (state === 'errors') return '\\u2717';
      return '';
    }

    function buildHealthChip(health) {
      if (!health) return '';
      var label = health.state === 'idle' ? 'Idle' :
                  health.state === 'processing' ? 'Processing ' + health.count :
                  health.state === 'queued' ? 'Queued ' + health.count :
                  health.count + ' error' + (health.count !== 1 ? 's' : '');
      return '<div class="health-chip ' + health.state + '">' +
        '<span class="health-icon">' + healthIcon(health.state) + '</span>' +
        '<span>' + esc(label) + '</span>' +
        '</div>';
    }

    async function dismissErrors(lineName, fileNames) {
      // Track locally so any poll firing before the server's .dismissed write
      // propagates won't repaint the banner with the same fileNames.
      (fileNames || []).forEach(function(fn) { _locallyDismissedFiles.add(fn); });

      // Optimistic: hide banner immediately
      var mount = document.getElementById('error-banner-mount');
      var prevHtml = mount ? mount.innerHTML : '';
      var prevKey = mount ? mount.getAttribute('data-banner-key') : '';
      if (mount) hideMountWithTransition(mount);

      try {
        if (!lineName && fileNames && fileNames.length > 0) {
          // Overview mode: group by _line
          var byLine = {};
          var allErrors = window._overviewErrors || [];
          for (var i = 0; i < allErrors.length; i++) {
            var e = allErrors[i];
            var ln = e._line;
            if (ln && e.fileName) {
              if (!byLine[ln]) byLine[ln] = [];
              byLine[ln].push(e.fileName);
            }
          }
          var promises = Object.keys(byLine).map(function(ln) {
            return fetch('/api/line/' + encodeURIComponent(ln) + '/errors/dismiss', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileNames: byLine[ln] })
            });
          });
          var results = await Promise.all(promises);
          var anyFailed = results.some(function(r) { return !r.ok; });
          if (anyFailed) throw new Error('One or more dismiss calls failed');
        } else if (lineName) {
          var res = await fetch('/api/line/' + encodeURIComponent(lineName) + '/errors/dismiss', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileNames: fileNames })
          });
          if (!res.ok) throw new Error('Dismiss failed: ' + res.status);
        }
        // Success — do NOT call refresh(); the next poll will pick up the change naturally
      } catch (err) {
        // Restore banner on failure — and roll back the local dismiss so the
        // next poll repaints the banner instead of silently swallowing it.
        (fileNames || []).forEach(function(fn) { _locallyDismissedFiles.delete(fn); });
        if (mount) {
          mount.innerHTML = prevHtml;
          mount.setAttribute('data-banner-key', prevKey || '');
          mount.classList.remove('hiding');
        }
        console.error('Dismiss failed:', err);
      }
    }

    // ─── Held task release handlers ──────────────────────────────────
    window._inFlightReleaseIds = window._inFlightReleaseIds || new Set();

    function markInFlight(fileName) { window._inFlightReleaseIds.add(fileName); }
    function clearInFlight(fileName) { window._inFlightReleaseIds.delete(fileName); }

    async function releaseCard(fileName) {
      if (!selectedLine) return;
      markInFlight(fileName);
      var cssId = cssEscape(fileName);
      var card = document.querySelector('[data-held-file="' + cssId + '"]');
      if (card) card.classList.add('in-flight');
      var btn = card ? card.querySelector('.release-btn') : null;
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/line/' + encodeURIComponent(selectedLine) + '/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskFile: fileName })
        });
        if (!res.ok) {
          var err = await res.json().catch(function () { return { error: 'HTTP ' + res.status }; });
          showToast('Release failed: ' + (err.error || 'Unknown error'));
          clearInFlight(fileName);
          if (card) card.classList.remove('in-flight');
          if (btn) btn.disabled = false;
          return;
        }
        var data = await res.json();
        if (data.errors && data.errors.length > 0) {
          showToast('Release error: ' + data.errors[0].message);
          clearInFlight(fileName);
          if (card) card.classList.remove('in-flight');
          if (btn) btn.disabled = false;
        }
        // On success: leave card dimmed; next poll reconciles
      } catch (e) {
        showToast('Network error — retry');
        clearInFlight(fileName);
        if (card) card.classList.remove('in-flight');
        if (btn) btn.disabled = false;
      }
    }

    function onReleaseAllClick(ev) {
      ev.stopPropagation();
      var heldCards = document.querySelectorAll('.held-card') || [];
      if (heldCards.length <= 1) { releaseAllHeld(); return; }
      var btn = document.getElementById('release-all-btn');
      var confirm = document.getElementById('release-all-confirm');
      if (btn) btn.classList.add('hidden');
      if (confirm) confirm.classList.remove('hidden');
    }

    function cancelReleaseAll() {
      var btn = document.getElementById('release-all-btn');
      var confirm = document.getElementById('release-all-confirm');
      if (btn) btn.classList.remove('hidden');
      if (confirm) confirm.classList.add('hidden');
    }

    async function releaseAllHeld() {
      if (!selectedLine) return;
      var cards = document.querySelectorAll('.held-card');
      for (var i = 0; i < cards.length; i++) {
        var fn = cards[i].getAttribute('data-held-file');
        if (fn) { markInFlight(fn); cards[i].classList.add('in-flight'); }
      }
      cancelReleaseAll();
      try {
        var res = await fetch('/api/line/' + encodeURIComponent(selectedLine) + '/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true })
        });
        if (!res.ok) {
          var errData = await res.json().catch(function () { return { error: 'HTTP ' + res.status }; });
          showToast('Release all failed: ' + (errData.error || 'Unknown error'));
          for (var j = 0; j < cards.length; j++) { cards[j].classList.remove('in-flight'); }
          window._inFlightReleaseIds.clear();
        }
      } catch (e) {
        showToast('Network error — retry');
        for (var k = 0; k < cards.length; k++) { cards[k].classList.remove('in-flight'); }
        window._inFlightReleaseIds.clear();
      }
    }

    function onHeldCardKeydown(ev, fileName) {
      if ((ev.key === 'r' || ev.key === 'R') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        releaseCard(fileName);
      }
    }

    function cssEscape(s) {
      return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast';
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.classList.add('visible');
      setTimeout(function () { t.classList.remove('visible'); }, 3500);
    }

    async function undismissError(lineName, fileName) {
      await fetch('/api/line/' + encodeURIComponent(lineName) + '/errors/undismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileNames: [fileName] })
      });
      refresh();
    }

    function handleErrorClick(lineName, errorId, fileName) {
      if (!lineName) return;
      if (viewState === 'overview') {
        selectLine(lineName);
      }
      setTimeout(function() {
        var board = document.querySelector('.kanban-board');
        if (board) board.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }

    function renderOverview(gs) {
      var overviewErrors = [];
      for (var ei = 0; ei < gs.lines.length; ei++) {
        var eline = gs.lines[ei];
        if (eline.state && eline.state.errors && eline.state.errors.length > 0) {
          for (var ej = 0; ej < eline.state.errors.length; ej++) {
            overviewErrors.push(Object.assign({}, eline.state.errors[ej], { _line: eline.name }));
          }
        }
      }
      window._overviewErrors = overviewErrors;
      var overviewBannerErrors = [];
      for (var bi = 0; bi < gs.lines.length; bi++) {
        var bline = gs.lines[bi];
        if (bline.state && bline.state.banner_errors && bline.state.banner_errors.length > 0) {
          for (var bj = 0; bj < bline.state.banner_errors.length; bj++) {
            overviewBannerErrors.push(Object.assign({}, bline.state.banner_errors[bj], { _line: bline.name }));
          }
        }
      }
      var next = AssemblyDashboard.buildOverviewDom(gs);
      var target = document.getElementById('content');
      if (!target) return;
      var fetchErrMount = document.getElementById('fetch-error-banner-mount');
      if (fetchErrMount) fetchErrMount.innerHTML = '';
      AssemblyDashboard.applyMorph(target, next, 'overview', JSON.stringify(gs));
      var filteredOverview = overviewBannerErrors.filter(function(e) {
        return e && e.fileName && !_locallyDismissedFiles.has(e.fileName);
      });
      updateErrorBanner(filteredOverview, null);
    }

    function renderDetail(state) {
      var next = AssemblyDashboard.buildDetailDom(state, {
        selectedLine: selectedLine,
        activityFilters: activityFilters,
        historyData: historyData,
        historyLimit: historyLimit,
        historyInclude: historyInclude,
        flowMetrics: flowMetricsData,
      });
      var target = document.getElementById('content');
      if (!target) return;
      var fetchErrMount = document.getElementById('fetch-error-banner-mount');
      if (fetchErrMount) fetchErrMount.innerHTML = '';
      AssemblyDashboard.applyMorph(target, next, 'detail', JSON.stringify(state));
      window._detailShellLine = selectedLine;
      var filteredDetail = (state.banner_errors || []).filter(function(e) {
        return e && e.fileName && !_locallyDismissedFiles.has(e.fileName);
      });
      updateErrorBanner(filteredDetail, selectedLine);
      loadKanban(selectedLine);
      loadFlowMetrics(selectedLine);
    }

    function applyViewState(state) {
      viewState = state;
      if (document.body) {
        document.body.classList.toggle('view-detail', state === 'detail');
        document.body.classList.toggle('view-overview', state === 'overview');
      }
      // Re-render usage panel immediately so the compact/full switch doesn't
      // wait for the next 60s poll (uses cached payload).
      if (lastUsagePayload) renderUsagePanel(lastUsagePayload);
    }

    function selectLine(name) {
      stopAllProgressPolling();
      if (drawerOpen) closeDrawer();
      activityFilters = {};
      historyData = null;
      flowMetricsData = null;
      applyViewState('detail');
      selectedLine = name;
      window._detailShellLine = null;
      window._kanbanPrev = null;
      window._kanbanPrevLine = null;
      history.pushState({ view: 'detail', line: name }, '', '/lines/' + encodeURIComponent(name));
      refresh();
      loadHistory();
      startRefresh(2000);
    }

    function goBack() {
      stopAllProgressPolling();
      if (drawerOpen) closeDrawer();
      activityFilters = {};
      applyViewState('overview');
      selectedLine = null;
      window._detailShellLine = null;
      window._kanbanPrev = null;
      window._kanbanPrevLine = null;
      history.pushState({ view: 'overview' }, '', '/');
      refresh();
      startRefresh(3000);
    }

    function metricCard(label, count, cls) {
      return '<div class="metric-card ' + cls + '">' +
        '<div class="label">' + label + '</div>' +
        '<div class="count">' + count + '</div>' +
        '</div>';
    }

    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeJs(s) {
      return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }

    // --- Drawer state ---
    var drawerOpen = false;
    var drawerLine = null;
    var drawerFile = null;

    function openDrawer(lineName, fileName) {
      drawerLine = lineName;
      drawerFile = fileName;
      drawerOpen = true;
      document.getElementById('drawer-overlay').classList.add('open');
      document.getElementById('drawer-panel').classList.add('open');
      document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Loading workpiece...</div>';
      document.getElementById('drawer-body').scrollTop = 0;
      document.getElementById('drawer-title').textContent = fileName.replace('.json', '');

      // Update URL with wp query param
      var url = new URL(window.location.href);
      url.searchParams.set('wp', fileName);
      url.searchParams.set('wpline', lineName);
      history.pushState(
        Object.assign({}, history.state, { wp: fileName, wpline: lineName }),
        '',
        url.toString()
      );

      // Fetch workpiece data
      fetch('/api/workpiece/' + encodeURIComponent(lineName) + '/' + encodeURIComponent(fileName))
        .then(function(res) {
          if (!res.ok) throw new Error('Workpiece not found');
          return res.json();
        })
        .then(function(wp) {
          renderDrawerContent(wp, lineName);
          teStartPolling(lineName, wp.id);
        })
        .catch(function(err) {
          document.getElementById('drawer-body').innerHTML =
            '<div class="drawer-error-msg">Failed to load workpiece: ' + esc(err.message) + '</div>';
        });
    }

    function closeDrawer() {
      if (!drawerOpen) return;
      drawerOpen = false;
      drawerLine = null;
      drawerFile = null;
      teStopPolling();
      document.getElementById('drawer-overlay').classList.remove('open');
      document.getElementById('drawer-panel').classList.remove('open');

      // Remove wp query param from URL
      var url = new URL(window.location.href);
      url.searchParams.delete('wp');
      url.searchParams.delete('wpline');
      history.pushState(
        { view: (history.state && history.state.view) || 'overview', line: (history.state && history.state.line) },
        '',
        url.toString()
      );
    }

    async function retryErroredWorkpiece(lineName, fileName) {
      var btn = document.querySelector('.drawer-action-primary');
      if (btn) { btn.disabled = true; btn.textContent = '\\u21bb Retrying\\u2026'; }
      try {
        var res = await fetch('/api/line/' + encodeURIComponent(lineName) + '/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: fileName })
        });
        if (!res.ok) {
          var errBody;
          try { errBody = await res.json(); } catch (_) { errBody = null; }
          throw new Error((errBody && errBody.error) || ('HTTP ' + res.status));
        }
        var data = await res.json();
        showToast('Queued for retry: ' + data.newId);
        closeDrawer();
        refresh();
      } catch (err) {
        showToast('Retry failed: ' + (err.message || 'unknown'));
        if (btn) { btn.disabled = false; btn.textContent = '\\u21bb Retry'; }
      }
    }

    function confirmDismissForever(lineName, fileName) {
      var btn = document.querySelector('.drawer-action-danger');
      if (!btn) return;
      if (btn.classList.contains('confirming')) {
        dismissForever(lineName, fileName);
      } else {
        btn.classList.add('confirming');
        btn.textContent = 'Click again to confirm';
        setTimeout(function() {
          var live = document.querySelector('.drawer-action-danger');
          if (live && live.classList.contains('confirming')) {
            live.classList.remove('confirming');
            live.textContent = 'Dismiss forever';
          }
        }, 4000);
      }
    }

    async function dismissForever(lineName, fileName) {
      try {
        var res = await fetch('/api/line/' + encodeURIComponent(lineName) + '/errors/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileNames: [fileName] })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Dismissed: ' + fileName);
        closeDrawer();
        refresh();
      } catch (err) {
        showToast('Dismiss failed: ' + (err.message || 'unknown'));
      }
    }

    function renderDrawerContent(wp, lineName) {
      var html = '';

      // Meta section
      html += '<div class="drawer-meta">';
      html += '<div class="drawer-meta-item"><div class="drawer-meta-label">Line</div><div class="drawer-meta-value">' + esc(wp.line || lineName) + '</div></div>';
      html += '<div class="drawer-meta-item"><div class="drawer-meta-label">ID</div><div class="drawer-meta-value">' + esc(wp.id) + '</div></div>';
      if (wp.totals) {
        html += '<div class="drawer-meta-item"><div class="drawer-meta-label">Total Tokens</div><div class="drawer-meta-value">' + fmtNum(wp.totals.tokens.in) + ' in / ' + fmtNum(wp.totals.tokens.out) + ' out</div></div>';
        html += '<div class="drawer-meta-item"><div class="drawer-meta-label">Total Cost</div><div class="drawer-meta-value">$' + wp.totals.cost_usd.toFixed(4) + '</div></div>';
      }
      html += '</div>';

      // Action bar — only for errored workpieces
      var isErrored = wp._source === 'error';
      if (!isErrored && wp.stations) {
        for (var sk in wp.stations) {
          if (wp.stations[sk] && wp.stations[sk].status === 'failed') { isErrored = true; break; }
        }
      }
      if (isErrored && drawerFile) {
        var lineJs = escapeJs(lineName);
        var fileJs = escapeJs(drawerFile);
        html += '<div class="drawer-actions">';
        html += '<button class="drawer-action-primary" aria-label="Retry workpiece" onclick="retryErroredWorkpiece(\\'' + lineJs + '\\', \\'' + fileJs + '\\')">\\u21bb Retry</button>';
        html += '<button class="drawer-action-danger" aria-label="Dismiss forever" onclick="confirmDismissForever(\\'' + lineJs + '\\', \\'' + fileJs + '\\')">Dismiss forever</button>';
        html += '</div>';
      }

      // Task section
      html += '<div class="drawer-section">';
      html += '<div class="drawer-section-title">Task</div>';
      html += '<div class="drawer-task">' + esc(wp.task || '(no task)') + '</div>';
      html += '</div>';

      // Station timeline
      var stationNames = Object.keys(wp.stations || {});
      stationNames.sort(function(a, b) {
        var sa = wp.stations[a].started_at || '';
        var sb = wp.stations[b].started_at || '';
        return sa.localeCompare(sb);
      });

      if (stationNames.length > 0) {
        html += '<div class="drawer-section">';
        html += '<div class="drawer-section-title">Station Timeline</div>';
        html += '<div class="station-timeline">';
        for (var i = 0; i < stationNames.length; i++) {
          var name = stationNames[i];
          var sr = wp.stations[name];
          var status = sr.status || 'unknown';
          html += '<div class="timeline-entry ' + status + '">';
          html += '<div class="timeline-dot"></div>';

          html += '<div class="timeline-station-name">';
          html += esc(name);
          html += ' <span class="timeline-status ' + status + '">' + status + '</span>';
          html += '</div>';

          html += '<div class="timeline-metrics">';
          if (sr.started_at && sr.finished_at) {
            html += '<span>' + fmtDuration(sr.started_at, sr.finished_at) + '</span>';
          }
          var tokIn = (sr.tokens && sr.tokens.in) ? sr.tokens.in : 0;
          var tokOut = (sr.tokens && sr.tokens.out) ? sr.tokens.out : 0;
          html += '<span>' + esc(sr.model || 'unknown') + '</span>';
          html += '</div>';
          html += '<div class="timeline-cost-line">' + fmtTokens(tokIn) + ' in / ' + fmtTokens(tokOut) + ' out \\u00b7 ' + fmtCost(sr.cost_usd || 0) + '</div>';

          if (sr.rounds && typeof AssemblyDashboard !== 'undefined' && AssemblyDashboard.renderStationRounds) {
            html += AssemblyDashboard.renderStationRounds(sr.rounds);
          }

          // Prior attempts (retry history)
          if (sr.previous_attempts && sr.previous_attempts.length > 0) {
            html += '<div class="timeline-prior-attempts">';
            html += '<details>';
            html += '<summary>Prior attempts (' + sr.previous_attempts.length + ')</summary>';
            html += '<ol>';
            for (var pa = 0; pa < sr.previous_attempts.length; pa++) {
              var attempt = sr.previous_attempts[pa];
              var paClass = attempt.failure_class || 'unknown';
              var paDur = (attempt.started_at && attempt.finished_at) ? fmtDuration(attempt.started_at, attempt.finished_at) : '?';
              var paTurns = (attempt.rounds && attempt.rounds.turns) ? attempt.rounds.turns + ' turns' : '';
              var paSummary = attempt.summary ? esc(attempt.summary).slice(0, 120) : '';
              html += '<li>' + esc(paClass) + ' \\u00b7 ' + paDur;
              if (paTurns) html += ' \\u00b7 ' + paTurns;
              if (paSummary) html += ' (' + paSummary + ')';
              html += '</li>';
            }
            html += '</ol>';
            html += '</details>';
            html += '</div>';
          }

          if (sr.summary) {
            html += '<div class="timeline-summary">' + esc(sr.summary) + '</div>';
          }

          if (sr.eval) {
            html += '<div class="timeline-eval">';
            html += '<div class="timeline-eval-header">';
            html += '<span class="' + (sr.eval.pass ? 'timeline-eval-pass' : 'timeline-eval-fail') + '">';
            html += sr.eval.pass ? '\\u2713 Pass' : '\\u2717 Fail';
            html += '</span>';
            if (sr.eval.score != null) {
              html += ' <span style="color:var(--text-muted)">Score: ' + sr.eval.score + '</span>';
            }
            if (sr.eval.action) {
              html += ' <span style="color:var(--text-dim)">[' + sr.eval.action + ']</span>';
            }
            if (sr.eval.tokens) {
              html += ' <span style="color:var(--text-dim)">(' + fmtNum(sr.eval.tokens.in) + '+' + fmtNum(sr.eval.tokens.out) + ' tok, $' + (sr.eval.cost_usd || 0).toFixed(4) + ')</span>';
            }
            html += '</div>';
            if (sr.eval.tokens) {
              html += '<div class="timeline-cost-line">eval: ' + fmtTokens(sr.eval.tokens.in) + ' in / ' + fmtTokens(sr.eval.tokens.out) + ' out \\u00b7 ' + fmtCost(sr.eval.cost_usd || 0) + '</div>';
            }
            if (sr.eval.feedback) {
              html += '<div class="timeline-eval-feedback">' + esc(sr.eval.feedback) + '</div>';
            }
            html += '</div>';
          }

          // Station events block (AI heartbeat stream)
          var teMeta = null;
          if (wp._taskEventStations) {
            for (var ti = 0; ti < wp._taskEventStations.length; ti++) {
              if (wp._taskEventStations[ti].name === name) { teMeta = wp._taskEventStations[ti]; break; }
            }
          }
          var teIsRunning = teMeta ? teMeta.status === 'running' : (status === 'running');
          var teCount = teMeta ? teMeta.event_count : 0;
          var teDotClass = teIsRunning ? 'live' : (teMeta ? 'done' : 'done');
          var teNameJs = escapeJs(name);
          var teLineJs = escapeJs(lineName);
          var teWpIdJs = escapeJs(wp.id);
          html += '<details class="station-events" data-station="' + esc(name) + '" data-line="' + esc(lineName) + '" data-wpid="' + esc(wp.id) + '" data-running="' + (teIsRunning ? '1' : '0') + '"' + (teIsRunning ? ' open' : '') + '>';
          html += '<summary>';
          html += '<span class="freshness-dot ' + teDotClass + '" title="' + (teIsRunning ? 'Live' : 'Completed') + '"></span>';
          html += '<span>Activity</span>';
          html += '<span class="station-events-count">' + (teCount > 0 ? teCount + ' events' : '') + '</span>';
          html += '</summary>';
          html += '<div class="station-events-body" data-station="' + esc(name) + '">';
          html += '<div class="station-events-load-earlier" style="display:none" onclick="teLoadEarlier(this)">Load earlier events</div>';
          html += '<div class="station-events-rows" role="log" aria-live="polite" aria-label="Activity log for ' + esc(name) + '"></div>';
          html += '<button class="station-events-jump" onclick="teJumpToLatest(this)" style="display:none">\\u2193 Jump to latest</button>';
          html += '</div>';
          html += '</details>';

          html += '</div>'; // timeline-entry
        }
        html += '</div>'; // station-timeline
        html += '</div>'; // drawer-section
      }

      // Drawer totals footer
      if (wp.totals) {
        html += '<div class="drawer-totals">';
        html += 'Total: ' + fmtTokens(wp.totals.tokens.in) + ' in / ' + fmtTokens(wp.totals.tokens.out) + ' out \\u00b7 ' + fmtCost(wp.totals.cost_usd);
        html += '</div>';
      }

      // Error details (for failed stations)
      var failedStations = stationNames.filter(function(n) { return wp.stations[n].status === 'failed'; });
      if (failedStations.length > 0) {
        html += '<div class="drawer-section">';
        html += '<div class="drawer-section-title">Error Details</div>';
        for (var j = 0; j < failedStations.length; j++) {
          var fs = wp.stations[failedStations[j]];
          html += '<div style="margin-bottom:8px;font-size:12px;font-weight:600;color:var(--color-error)">' + esc(failedStations[j]) + '</div>';
          html += '<div class="drawer-error-detail">' + esc(fs.summary || 'No error details') + '</div>';
          if (fs.content) {
            html += '<div class="drawer-error-detail" style="margin-top:8px;border-color:var(--border-default);background:var(--bg-surface)">' + esc(fs.content) + '</div>';
          }
        }
        html += '</div>';
      }

      // Retry history (from _activity)
      if (wp._activity && wp._activity.length > 0) {
        var retryEvents = wp._activity.filter(function(a) {
          return a.event === 'retry' || a.event === 'error_bucket' || a.event === 'worker_crash_recovery';
        });
        if (retryEvents.length > 0) {
          html += '<div class="drawer-section">';
          html += '<div class="drawer-section-title">Retry History</div>';
          for (var k = 0; k < retryEvents.length; k++) {
            var re = retryEvents[k];
            var reTime = re.ts ? new Date(re.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            html += '<div class="drawer-retry-entry">';
            html += '<span class="time">' + reTime + '</span> ';
            html += '<span style="color:var(--color-warning)">' + esc(re.event) + '</span>';
            if (re.station) html += ' [' + esc(re.station) + ']';
            if (re.attempt) html += ' attempt ' + re.attempt;
            if (re.delay_s) html += ' (backoff ' + re.delay_s + 's)';
            if (re.error) html += ' \\u2014 ' + esc(String(re.error).slice(0, 100));
            html += '</div>';
          }
          html += '</div>';
        }
      }

      document.getElementById('drawer-body').innerHTML = html;
    }

    // Drawer helpers
    function fmtDuration(start, end) {
      var ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      var min = Math.floor(ms / 60000);
      var sec = Math.round((ms % 60000) / 1000);
      return min + 'm ' + sec + 's';
    }

    function fmtNum(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    function fmtCost(usd) {
      if (usd == null || usd === 0) return '$0.00';
      if (usd < 0.01) return (usd * 100).toFixed(2) + '\\u00a2';
      return '$' + usd.toFixed(2);
    }

    function fmtTokens(n) {
      if (n == null || n === 0) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    // Keyboard: Escape to close drawer
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && drawerOpen) {
        closeDrawer();
      }
    });

    function formatDuration(ms) {
      if (ms == null) return '';
      if (ms < 1000) return ms + 'ms';
      var seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + 's';
      var minutes = Math.floor(seconds / 60);
      var remainSec = seconds % 60;
      if (minutes < 60) return minutes + 'm ' + (remainSec > 0 ? remainSec + 's' : '');
      var hours = Math.floor(minutes / 60);
      var remainMin = minutes % 60;
      return hours + 'h ' + (remainMin > 0 ? remainMin + 'm' : '');
    }

    function formatRunningDuration(startedAt) {
      if (!startedAt) return '';
      var elapsed = Date.now() - new Date(startedAt).getTime();
      return formatDuration(elapsed) + '...';
    }

    function classifyConnection(ageMs) {
      if (!isFinite(ageMs) || ageMs < 0) return 'disconnected';
      if (ageMs < CONN_LIVE_MS) return 'live';
      if (ageMs <= CONN_STALE_MS) return 'stale';
      return 'disconnected';
    }

    function updateConnectionIndicator() {
      var dot = document.getElementById('conn-dot');
      var label = document.getElementById('conn-label');
      var ts = document.getElementById('conn-ts');
      if (!dot || !label) return;
      var ageMs = lastSuccessfulFetchMs < 0 ? Infinity : (Date.now() - lastSuccessfulFetchMs);
      var state = classifyConnection(ageMs);
      dot.className = 'conn-dot conn-' + state;
      label.className = 'conn-label conn-' + state;
      if (state === 'live') label.textContent = 'Live';
      else if (state === 'stale') label.textContent = 'Stale';
      else label.textContent = 'Disconnected';
      if (ts) {
        if (lastSuccessfulFetchMs < 0) {
          ts.textContent = '';
        } else {
          ts.textContent = 'updated ' + new Date(lastSuccessfulFetchMs).toLocaleTimeString();
        }
      }
    }

    function updateStationFreshnessDots() {
      var elements = document.querySelectorAll('.station-freshness[data-station-last-update]');
      var now = Date.now();
      var threshold2x = 2 * FRESHNESS_POLL_INTERVAL_MS; // 60s
      var threshold5x = 5 * FRESHNESS_POLL_INTERVAL_MS; // 150s
      var iconMap = { fresh: '\u2713', stale: '\u23f1', disconnected: '\u2717', completed: '\u2014' };

      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        var lastUpdateStr = el.getAttribute('data-station-last-update');
        var currentState = el.getAttribute('data-station-state');

        // Skip completed stations — they don't age
        if (currentState === 'completed') continue;
        if (!lastUpdateStr) continue;

        var lastUpdateMs = new Date(lastUpdateStr).getTime();
        var ageMs = now - lastUpdateMs;
        var ageSec = Math.floor(ageMs / 1000);

        // Reclassify
        var newState, icon, label;
        if (ageMs < threshold2x) {
          newState = 'fresh';
          icon = iconMap.fresh;
          label = 'Updated ' + ageSec + 's ago';
        } else if (ageMs < threshold5x) {
          newState = 'stale';
          icon = iconMap.stale;
          label = 'Stale — ' + ageSec + 's ago';
        } else {
          newState = 'disconnected';
          icon = iconMap.disconnected;
          label = 'Disconnected — ' + ageSec + 's ago';
        }

        // Update only if state changed
        if (newState !== currentState) {
          el.className = 'station-freshness ' + newState;
          el.setAttribute('data-station-state', newState);
          el.setAttribute('aria-label', label);
          el.setAttribute('title', label);
          var iconEl = el.querySelector('.station-freshness-icon');
          if (iconEl) iconEl.textContent = icon;
        } else {
          // Update label even if state hasn't changed (time elapsed)
          el.setAttribute('aria-label', label);
          el.setAttribute('title', label);
        }
      }
    }

    function formatRelativeTime(isoString) {
      if (!isoString) return '';
      var now = Date.now();
      var then = new Date(isoString).getTime();
      var diffMs = now - then;
      if (diffMs < 0) return 'just now';
      if (diffMs < 60000) return Math.floor(diffMs / 1000) + 's ago';
      if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
      if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
      return Math.floor(diffMs / 86400000) + 'd ago';
    }

    window.addEventListener('popstate', function(event) {
      // Handle drawer state
      if (event.state && event.state.wp) {
        openDrawer(event.state.wpline, event.state.wp);
        return;
      } else if (drawerOpen) {
        // Close drawer without pushing state
        drawerOpen = false;
        drawerLine = null;
        drawerFile = null;
        document.getElementById('drawer-overlay').classList.remove('open');
        document.getElementById('drawer-panel').classList.remove('open');
      }

      if (event.state && event.state.view === 'detail' && event.state.line) {
        applyViewState('detail');
        selectedLine = event.state.line;
        refresh();
        startRefresh(2000);
      } else {
        applyViewState('overview');
        selectedLine = null;
        refresh();
        startRefresh(3000);
      }
    });

    // Initial load — restore view from URL
    (function() {
      var match = window.location.pathname.match(/^\\/lines\\/(.+)$/);
      if (match) {
        var lineName = decodeURIComponent(match[1]);
        applyViewState('detail');
        selectedLine = lineName;
        history.replaceState({ view: 'detail', line: lineName }, '', window.location.pathname + window.location.search);
        refresh();
        loadHistory();
        startRefresh(2000);
      } else {
        applyViewState('overview');
        history.replaceState({ view: 'overview' }, '', window.location.pathname + window.location.search);
        refresh();
        startRefresh(3000);
      }

      // Start the 1s connection health ticker once at bootstrap
      connectionHealthTimer = setInterval(updateConnectionIndicator, 1000);
      updateConnectionIndicator();

      // Start the 1s station freshness ticker once at bootstrap
      stationFreshnessTimer = setInterval(updateStationFreshnessDots, 1000);

      // Usage panel — own 60s poll, independent of the 3s main refresh.
      loadUsage();
      usageTimer = setInterval(loadUsage, 60_000);
      // Local re-render every 30s so relative times ("resets in…", "last
      // checked …") stay fresh without re-fetching.
      usageTickTimer = setInterval(function() {
        if (lastUsagePayload) renderUsagePanel(lastUsagePayload);
      }, 30_000);

      // Check for wp query param to restore drawer state
      var urlParams = new URLSearchParams(window.location.search);
      var wpParam = urlParams.get('wp');
      var wpLineParam = urlParams.get('wpline');
      if (wpParam && wpLineParam) {
        setTimeout(function() {
          openDrawer(wpLineParam, wpParam);
        }, 500);
      }
    })();

    // ─── Task Event Heartbeat Stream ────────────────────────────────

    var tePollingTimers = [];
    var teStationCursors = {}; // stationName -> {lastSeq, firstSeq, total, loaded}
    var teLastFetchOk = 0;

    // ─── Virtualization constants ────────────────────────────────────
    var TE_VIRTUAL_THRESHOLD = 500; // switch to virtual rendering above this count
    var TE_VIRTUAL_OVERSCAN = 50;   // extra rows to render above/below viewport
    var TE_VIRTUAL_WINDOW = 150;    // total rows to render in virtual mode
    var TE_ROW_HEIGHT_PX = 26;      // estimated row height; measured on first render

    function teKindIcon(kind, detail) {
      if (kind === 'message') return { icon: '\\u{1F4AC}', label: 'Message', cls: 'kind-message' };
      if (kind === 'tool_call') return { icon: '\\u2699', label: 'Tool', cls: 'kind-tool_call' };
      if (kind === 'tool_result') {
        var isErr = detail && detail.error;
        if (isErr) return { icon: '\\u2715', label: 'Error', cls: 'kind-tool_result-err' };
        return { icon: '\\u2713', label: 'OK', cls: 'kind-tool_result-ok' };
      }
      if (kind === 'heartbeat') return { icon: '\\u00b7', label: 'Tick', cls: 'kind-heartbeat' };
      if (kind === 'lifecycle') return { icon: '\\u25b6', label: 'Lifecycle', cls: 'kind-lifecycle' };
      return { icon: '?', label: kind, cls: '' };
    }

    function teRelativeTime(ts) {
      var diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (diff < 5) return 'now';
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      return Math.floor(diff / 3600) + 'h ago';
    }

    function teRenderRow(ev) {
      var ki = teKindIcon(ev.kind, ev.detail);
      var row = document.createElement('div');
      row.className = 'event-row ' + ki.cls;
      row.dataset.seq = ev.seq;
      row.dataset.ts = ev.ts;

      var iconEl = document.createElement('span');
      iconEl.className = 'event-icon';
      iconEl.setAttribute('aria-label', ki.label);
      iconEl.textContent = ki.icon;

      var tsEl = document.createElement('span');
      tsEl.className = 'event-ts';
      tsEl.textContent = teRelativeTime(ev.ts);

      var summEl = document.createElement('span');
      summEl.className = 'event-summary';
      summEl.textContent = ev.summary || '';
      summEl.title = 'Click to expand detail';

      var detailEl = document.createElement('div');
      detailEl.className = 'event-detail';
      if (ev.detail !== undefined && ev.detail !== null) {
        detailEl.textContent = typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail, null, 2);
      } else {
        detailEl.textContent = '(no detail)';
      }

      summEl.addEventListener('click', function() {
        row.classList.toggle('expanded');
      });

      row.appendChild(iconEl);
      row.appendChild(tsEl);
      var textWrap = document.createElement('div');
      textWrap.style.flex = '1';
      textWrap.style.overflow = 'hidden';
      textWrap.appendChild(summEl);
      textWrap.appendChild(detailEl);
      row.appendChild(textWrap);
      return row;
    }

    function teUpdateTimestamps() {
      var rows = document.querySelectorAll('.event-row');
      for (var i = 0; i < rows.length; i++) {
        var ts = rows[i].dataset.ts;
        if (ts) {
          var tsEl = rows[i].querySelector('.event-ts');
          if (tsEl) tsEl.textContent = teRelativeTime(ts);
        }
      }
    }

    function teGetBody(detailsEl) {
      return detailsEl.querySelector('.station-events-body');
    }
    function teGetRows(detailsEl) {
      return detailsEl.querySelector('.station-events-rows');
    }

    function teAppendEvents(detailsEl, events, prepend) {
      var rowsEl = teGetRows(detailsEl);
      var body = teGetBody(detailsEl);
      if (!rowsEl || !body) return;

      // Auto-scroll check: are we near the bottom?
      var nearBottom = (body.scrollTop + body.clientHeight) >= (body.scrollHeight - 80);

      for (var i = 0; i < events.length; i++) {
        var row = teRenderRow(events[i]);
        if (prepend) {
          rowsEl.insertBefore(row, rowsEl.firstChild);
        } else {
          rowsEl.appendChild(row);
        }
      }

      // Scroll to bottom if we were near the bottom and not prepending
      if (!prepend && nearBottom && events.length > 0) {
        body.scrollTop = body.scrollHeight;
        var jumpBtn = detailsEl.querySelector('.station-events-jump');
        if (jumpBtn) jumpBtn.style.display = 'none';
      }
    }

    function teSetupScrollHandler(detailsEl) {
      var body = teGetBody(detailsEl);
      if (!body || body._teScrollBound) return;
      body._teScrollBound = true;
      body.addEventListener('scroll', function() {
        var jumpBtn = detailsEl.querySelector('.station-events-jump');
        if (!jumpBtn) return;
        var nearBottom = (body.scrollTop + body.clientHeight) >= (body.scrollHeight - 80);
        jumpBtn.style.display = nearBottom ? 'none' : 'block';
      });
    }

    function teJumpToLatest(btn) {
      var body = btn.closest('.station-events-body');
      if (body) { body.scrollTop = body.scrollHeight; btn.style.display = 'none'; }
    }

    function teFetchEvents(lineName, wpId, stationName, opts, onSuccess, onError) {
      var url = '/api/task-events/' + encodeURIComponent(lineName) + '/' + encodeURIComponent(wpId) + '/' + encodeURIComponent(stationName);
      var params = [];
      if (opts.after !== undefined) params.push('after=' + opts.after);
      if (opts.before !== undefined) params.push('before=' + opts.before);
      if (opts.limit !== undefined) params.push('limit=' + opts.limit);
      if (params.length) url += '?' + params.join('&');
      fetch(url).then(function(r) { return r.json(); }).then(function(data) {
        teLastFetchOk = Date.now();
        onSuccess(data);
      }).catch(function(err) {
        if (onError) onError(err);
      });
    }

    function teInitStation(detailsEl) {
      var stationName = detailsEl.dataset.station;
      var lineName = detailsEl.dataset.line;
      var wpId = detailsEl.dataset.wpid;
      var isRunning = detailsEl.dataset.running === '1';
      var body = teGetBody(detailsEl);
      var rowsEl = teGetRows(detailsEl);
      if (!body || !rowsEl) return;

      if (rowsEl._teInitialized) return; // already loaded
      rowsEl._teInitialized = true;

      // Show skeleton
      var skel = document.createElement('div');
      skel.className = 'station-events-skeleton';
      skel.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
      rowsEl.appendChild(skel);

      teSetupScrollHandler(detailsEl);

      var cursor = { lastSeq: 0, firstSeq: Infinity, total: 0, loaded: 0 };
      teStationCursors[stationName] = cursor;

      teFetchEvents(lineName, wpId, stationName, { limit: 100 }, function(page) {
        rowsEl.innerHTML = '';
        if (!page.events || page.events.length === 0) {
          var emptyEl = document.createElement('div');
          emptyEl.className = 'station-events-empty';
          emptyEl.textContent = 'No events captured yet';
          rowsEl.appendChild(emptyEl);
          return;
        }
        cursor.total = page.total;
        cursor.loaded = page.events.length;
        cursor.lastSeq = page.next_cursor;
        cursor.firstSeq = page.events[0].seq;
        teAppendEvents(detailsEl, page.events, false);
        body.scrollTop = body.scrollHeight;

        // Show load-earlier if more events exist before the first one we loaded
        var loadEarlierEl = detailsEl.querySelector('.station-events-load-earlier');
        if (loadEarlierEl) {
          loadEarlierEl.style.display = page.has_more || cursor.firstSeq > 1 ? '' : 'none';
          loadEarlierEl.dataset.station = stationName;
          loadEarlierEl.dataset.line = lineName;
          loadEarlierEl.dataset.wpid = wpId;
        }
      }, function() {
        rowsEl.innerHTML = '';
        var errEl = document.createElement('div');
        errEl.className = 'station-events-error';
        errEl.innerHTML = 'Could not load events \\u2014 <button class="station-events-retry-btn">Retry</button>';
        errEl.querySelector('.station-events-retry-btn').addEventListener('click', function() {
          rowsEl._teInitialized = false;
          teInitStation(detailsEl);
        });
        rowsEl.appendChild(errEl);
      });
    }

    function teLoadEarlier(loadEarlierEl) {
      var stationName = loadEarlierEl.dataset.station;
      var lineName = loadEarlierEl.dataset.line;
      var wpId = loadEarlierEl.dataset.wpid;
      var cursor = teStationCursors[stationName];
      if (!cursor) return;
      var detailsEl = loadEarlierEl.closest('.station-events');
      var rowsEl = detailsEl ? teGetRows(detailsEl) : null;
      if (!rowsEl) return;

      loadEarlierEl.textContent = 'Loading\\u2026';

      teFetchEvents(lineName, wpId, stationName, { before: cursor.firstSeq, limit: 100 }, function(page) {
        loadEarlierEl.textContent = 'Load earlier events';
        if (!page.events || page.events.length === 0) {
          loadEarlierEl.style.display = 'none';
          return;
        }
        // Capture scroll position before prepend
        var body = teGetBody(detailsEl);
        var prevHeight = body ? body.scrollHeight : 0;
        var prevScroll = body ? body.scrollTop : 0;

        cursor.firstSeq = page.events[0].seq;
        cursor.loaded += page.events.length;
        teAppendEvents(detailsEl, page.events, true);

        // Maintain scroll position after prepend
        if (body) {
          var newHeight = body.scrollHeight;
          body.scrollTop = prevScroll + (newHeight - prevHeight);
        }

        // Hide load-earlier if no more
        if (!page.has_more && cursor.firstSeq <= 1) loadEarlierEl.style.display = 'none';
      }, function() {
        loadEarlierEl.textContent = 'Load earlier events';
      });
    }

    function tePollActiveStation(detailsEl) {
      var stationName = detailsEl.dataset.station;
      var lineName = detailsEl.dataset.line;
      var wpId = detailsEl.dataset.wpid;
      var cursor = teStationCursors[stationName];
      if (!cursor) return;

      teFetchEvents(lineName, wpId, stationName, { after: cursor.lastSeq, limit: 100 }, function(page) {
        if (!page.events || page.events.length === 0) return;
        cursor.lastSeq = page.next_cursor;
        cursor.total = page.total;
        // Remove empty state message if present
        var rowsEl = teGetRows(detailsEl);
        if (rowsEl) {
          var emptyEl = rowsEl.querySelector('.station-events-empty');
          if (emptyEl) rowsEl.removeChild(emptyEl);
        }
        teAppendEvents(detailsEl, page.events, false);

        // Update event count in summary
        var countEl = detailsEl.querySelector('.station-events-count');
        if (countEl) countEl.textContent = cursor.total + ' events';

        // Update freshness dot
        var dot = detailsEl.querySelector('.freshness-dot');
        if (dot) { dot.className = 'freshness-dot live'; dot.title = 'Live'; }
      });
    }

    function teStartPolling(lineName, wpId) {
      teStopPolling();
      teStationCursors = {};
      teLastFetchOk = Date.now();

      // Initialize all open station-events blocks
      var allDetails = document.querySelectorAll('.station-events');
      for (var di = 0; di < allDetails.length; di++) {
        (function(det) {
          det.addEventListener('toggle', function() {
            if (det.open && !teGetRows(det)._teInitialized) teInitStation(det);
          });
          if (det.open) {
            setTimeout(function() { teInitStation(det); }, 0);
          }
        })(allDetails[di]);
      }

      // Timestamp refresh ticker (every 1s)
      tePollingTimers.push(setInterval(teUpdateTimestamps, 1000));

      // Active station tail poll (every 2.5s)
      tePollingTimers.push(setInterval(function() {
        var running = document.querySelectorAll('.station-events[data-running="1"][open]');
        for (var ri = 0; ri < running.length; ri++) {
          tePollActiveStation(running[ri]);
        }
      }, 2500));

      // Station index refresh (every 5s) — update event counts + freshness dots
      tePollingTimers.push(setInterval(function() {
        fetch('/api/task-events/' + encodeURIComponent(lineName) + '/' + encodeURIComponent(wpId))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            teLastFetchOk = Date.now();
            if (!data.stations) return;
            for (var si = 0; si < data.stations.length; si++) {
              var sm = data.stations[si];
              var det = document.querySelector('.station-events[data-station="' + sm.name + '"]');
              if (!det) continue;
              var countEl = det.querySelector('.station-events-count');
              if (countEl) countEl.textContent = sm.event_count + ' events';
              det.dataset.running = sm.status === 'running' ? '1' : '0';
              var dot = det.querySelector('.freshness-dot');
              if (dot) {
                var isRunning = sm.status === 'running';
                var ageS = (Date.now() - new Date(sm.last_ts).getTime()) / 1000;
                var dotCls = 'done';
                if (isRunning) dotCls = ageS < 25 ? 'live' : 'silent';
                dot.className = 'freshness-dot ' + dotCls;
                dot.title = isRunning ? (dotCls === 'live' ? 'Live' : 'Silent') : 'Completed';
              }
            }
          }).catch(function() {
            // Mark all dots as error if no fetch for 15s
            if (Date.now() - teLastFetchOk > 15000) {
              var dots = document.querySelectorAll('.freshness-dot.live, .freshness-dot.silent');
              for (var di2 = 0; di2 < dots.length; di2++) {
                dots[di2].className = 'freshness-dot error';
              }
            }
          });
      }, 5000));
    }

    function teStopPolling() {
      for (var ti = 0; ti < tePollingTimers.length; ti++) clearInterval(tePollingTimers[ti]);
      tePollingTimers = [];
      teStationCursors = {};
    }
  </script>
</body>
</html>`;
