import { discoverLines, type GlobalState } from "./global-orchestrator";
import { getFullState, findWorkpiece, getWorkpieceActivity, getHistory, getKanbanState, getDoneCards, getTaskEventStations, getTaskEvents, computeFlowMetrics, getWorkpieceSidecarTails } from "./dashboard-data";
import { dismissFilenames, undismissFilenames } from "./error-dismiss";
import { releaseHeldTasks, InvalidTaskFileError } from "./held";
import {
  retryErroredWorkpiece,
  InvalidRetryFileNameError,
  ErrorFileNotFoundError,
} from "./retry-manual";
import { loadLine } from "./line";
import { basename, extname, normalize, resolve, sep } from "path";
import { LineName } from "./ids";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { readUsageSnapshot } from "./usage-snapshot";
const DEFAULT_WEB_DIST_DIR = resolve(import.meta.dir, "..", "web", "dist");

// ─── Types ─────────────────────────────────────────────────────────

export interface GlobalDashboardOptions {
  port: number;
}

interface DiscoveredLine {
  linePath: string;
  lineName: string;
}

const GLOBAL_STATE_CACHE_KEY = "global:state";
const STATE_TTL_MS = 2000;
const KANBAN_TTL_MS = 2000;
const FLOW_METRICS_TTL_MS = 5000;

const snapCache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, ttlMs: number, build: () => Promise<T>): Promise<T> {
  const hit = snapCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await build();
  snapCache.set(key, { at: Date.now(), value });
  return value;
}

function fullStateCacheKey(linePath: string): string {
  return `line:${linePath}:full`;
}

function kanbanCacheKey(linePath: string): string {
  return `line:${linePath}:kanban`;
}

function flowMetricsCacheKey(linePath: string): string {
  return `line:${linePath}:flow-metrics`;
}

function invalidateLineSnapshot(linePath: string): void {
  snapCache.delete(fullStateCacheKey(linePath));
  snapCache.delete(kanbanCacheKey(linePath));
  snapCache.delete(flowMetricsCacheKey(linePath));
  snapCache.delete(GLOBAL_STATE_CACHE_KEY);
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
      lines.push({ linePath, lineName: LineName(basename(linePath)) });
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
      const state = await cached(fullStateCacheKey(dl.linePath), STATE_TTL_MS, () => getFullState(dl.linePath));
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

  return { lines: lineStates, totals, timestamp: new Date().toISOString(), version: "2026.05.24" };
}

// ─── Dashboard Server ──────────────────────────────────────────────

function getDashboardMimeType(file: ReturnType<typeof Bun.file>, filePath: string): string {
  if (file.type) return file.type;

  switch (extname(filePath).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function resolveDashboardAssetPath(pathname: string, webDistAssetsDir: string): string | null {
  const assetPrefix = "/assets/";
  if (!pathname.startsWith(assetPrefix)) return null;

  let assetName: string;
  try {
    assetName = decodeURIComponent(pathname.slice(assetPrefix.length));
  } catch {
    return null;
  }

  if (!assetName || assetName.includes("\0")) return null;

  const normalizedAssetPath = normalize(resolve(webDistAssetsDir, assetName));
  const normalizedAssetDir = normalize(webDistAssetsDir);
  if (!normalizedAssetPath.startsWith(`${normalizedAssetDir}${sep}`)) return null;

  try {
    if (!statSync(normalizedAssetPath).isFile()) return null;
  } catch {
    return null;
  }

  return normalizedAssetPath;
}

function getRawPathname(requestUrl: string): string {
  const withoutOrigin = requestUrl.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const path = withoutOrigin.split(/[?#]/, 1)[0];
  return path || "/";
}

/**
 * Start the unified multi-line dashboard HTTP server.
 * Discovers lines independently and reads all state from the filesystem.
 */
export function startGlobalDashboard(options: GlobalDashboardOptions): {
  stop: () => void;
  port: number;
  fetch?: (req: Request) => Promise<Response>;
} {
  snapCache.clear();

  const webDistDir = resolve(process.env.ASSEMBLY_DASHBOARD_WEB_DIST_DIR ?? DEFAULT_WEB_DIST_DIR);
  const webDistIndex = resolve(webDistDir, "index.html");
  const webDistAssetsDir = resolve(webDistDir, "assets");

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

  const handleRequest = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const rawPathname = getRawPathname(req.url);

      // Global state API
      if (url.pathname === "/api/state") {
        const state = await cached(GLOBAL_STATE_CACHE_KEY, STATE_TTL_MS, () => buildGlobalState(discoveredLines));
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
          invalidateLineSnapshot(dl.linePath);
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
          invalidateLineSnapshot(dl.linePath);
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
          invalidateLineSnapshot(dl.linePath);
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
          invalidateLineSnapshot(dl.linePath);
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

      // Per-line paginated done cards API
      const kanbanDoneMatch = url.pathname.match(/^\/api\/line\/([^/]+)\/kanban\/done$/);
      if (kanbanDoneMatch && req.method === "GET") {
        const lineName = decodeURIComponent(kanbanDoneMatch[1]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
          const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10) || 20;
          const limit = Math.max(1, Math.min(50, rawLimit)); // Clamp to 1-50
          const result = await getDoneCards(dl.linePath, offset, limit);
          return Response.json({ cards: result.cards, total: result.total, offset, limit });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Per-line kanban state API
      const kanbanMatch = url.pathname.match(/^\/api\/line\/([^/]+)\/kanban$/);
      if (kanbanMatch && req.method === "GET") {
        const lineName = decodeURIComponent(kanbanMatch[1]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        try {
          const kb = await cached(kanbanCacheKey(dl.linePath), KANBAN_TTL_MS, () => getKanbanState(dl.linePath));
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
          const metrics = await cached(flowMetricsCacheKey(dl.linePath), FLOW_METRICS_TTL_MS, async () => {
            const { config } = await loadLine(dl.linePath);
            const sequence: string[] = [];
            for (const step of config.sequence) {
              if (typeof step === "string") sequence.push(step);
              else if ("parallel" in step) sequence.push(...step.parallel);
              else if ("station" in step) sequence.push((step as { station: { name: string } }).station.name);
            }
            return computeFlowMetrics(dl.linePath, sequence);
          });
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
          const state = await cached(fullStateCacheKey(dl.linePath), STATE_TTL_MS, () => getFullState(dl.linePath));
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

      // Workpiece sidecar tail API
      const sidecarsMatch = url.pathname.match(/^\/api\/workpiece\/([^/]+)\/(.+)\/sidecars$/);
      if (sidecarsMatch && req.method === "GET") {
        const lineName = decodeURIComponent(sidecarsMatch[1]);
        const fileName = decodeURIComponent(sidecarsMatch[2]);
        const dl = linesByName.get(lineName);
        if (!dl) return Response.json({ error: `Line "${lineName}" not found` }, { status: 404 });
        const sidecars = getWorkpieceSidecarTails(dl.linePath, fileName);
        if (!sidecars) return Response.json({ error: "Workpiece not found" }, { status: 404 });
        return Response.json(sidecars);
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

      // Built SPA assets, served only from web/dist/assets.
      if (rawPathname.startsWith("/assets/") || url.pathname.startsWith("/assets/")) {
        const assetPath = resolveDashboardAssetPath(
          rawPathname.startsWith("/assets/") ? rawPathname : url.pathname,
          webDistAssetsDir
        );
        if (!assetPath) return new Response("Not found", { status: 404 });

        const file = Bun.file(assetPath);
        return new Response(file, {
          headers: {
            "Content-Type": getDashboardMimeType(file, assetPath),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }

      // SPA catch-all: serve the built React dashboard.
      const indexFile = Bun.file(webDistIndex);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": getDashboardMimeType(indexFile, webDistIndex) },
        });
      }

      return new Response("Dashboard web build not found. Run `bun run build:web` before starting the dashboard.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
  };

  if (options.port === 0) {
    return {
      stop: () => clearInterval(refreshInterval),
      port: 0,
      fetch: handleRequest,
    };
  }

  const server = Bun.serve({
    port: options.port,
    fetch: handleRequest,
  });

  console.log(`\n  Dashboard: http://localhost:${server.port}\n`);

  return {
    stop: () => {
      clearInterval(refreshInterval);
      server.stop();
    },
    port: server.port ?? options.port,
  };
}
