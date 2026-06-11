# Dashboard

The dashboard is a Bun HTTP server that reads the file system and renders a live view of every line. It's **independent of the daemon** — it can run without the orchestrator (you'll just see static state) and the orchestrator can run without it (it's an observation layer).

Implementations:
- [`../src/global-dashboard.ts`](../src/global-dashboard.ts) — HTTP API server plus built SPA / legacy fallback shell
- [`../src/dashboard-server.ts`](../src/dashboard-server.ts) — process wrapper (PID file, signal handlers)
- [`../src/dashboard-data.ts`](../src/dashboard-data.ts) — state aggregation
- [`../web/`](../web/) — React/Vite dashboard frontend, built to committed `web/dist/`
- [`../src/dashboard-client.js`](../src/dashboard-client.js) — legacy fallback browser client (3-second poll + morphdom diff)
- [`../src/task-events.ts`](../src/task-events.ts) — per-station event stream
- [`../src/retry-manual.ts`](../src/retry-manual.ts) — human-triggered retry endpoint
- [`../src/error-dismiss.ts`](../src/error-dismiss.ts) — error suppression endpoint

---

## Running it

```bash
assembly dashboard [--port 4111]    # default port is 4111
```

PID written to `~/.assembly/dashboard.pid` with `{ pid, port }`. The CLI refuses to double-start if a live PID is found.

To stop:

```bash
assembly dashboard stop
```

Browse at `http://localhost:4111`.

When `web/dist/index.html` is present, the Bun server serves the built Vite SPA and static assets from `web/dist/assets/`. If that bundle is absent, it falls back to the embedded legacy dashboard shell in `global-dashboard.ts`; the legacy client remains in place for compatibility.

For frontend development, run the backend and Vite dev server in separate terminals:

```bash
assembly dashboard --port 4111
bun run dashboard:web
```

The Vite app proxies `/api` to `http://localhost:4111`, so frontend requests hit the running dashboard API while Vite serves the React app.

Before publishing, `prepublishOnly` runs `bun run build:web`. The generated `web/dist/` directory is intentionally committed so global installs can serve the SPA without requiring a local frontend build.

---

## What it shows

The page is a single-page application served at every path (catch-all routes). Top-level views:

| View | What it shows |
|------|---------------|
| **Kanban** | One column per stage per line: held → inbox → station inbox → processing → output → done / error / review. Workpieces are cards. |
| **Drawer** | Click a card → per-workpiece detail (stations, status, model, tokens, cost, eval, content/data, sidecar tails). |
| **Activity** | Recent line-level events from `queues/activity.jsonl`. |
| **Error banner** | Active errors with severity (critical < 30m, warning < 48h, suppressed > 48h). |
| **Retry panel** | UI to manually retry an errored workpiece. |
| **Usage / cost** | Session totals + per-station rollup of tokens + USD. |
| **Throughput** | Done counts rolled over 1h and 24h windows. |
| **Historical timings** | Per-station min/max/avg duration across the last 10 completed runs. |
| **Per-station task events** | Drawer subview — live event stream per (workpiece, station). |

---

## Data sources

Everything is read from disk on demand. **No database, no in-memory cache.** This means the dashboard works even after a daemon restart and is safe to refresh aggressively.

Per request, [`getFullState()`](../src/dashboard-data.ts) reads:

- All queue directories (line-level `inbox`/`held`/`done`/`error`/`review` and station-level `inbox`/`processing`/`output`).
- `queues/activity.jsonl` (tail of recent entries).
- `queues/flow.jsonl` (periodic snapshots — used for charts).
- `queues/task-events/<wpId>/` (lazily, for the drawer view).
- `queues/error/.dismissed` sidecar (filter out dismissed errors).
- `.retry.json` sidecars on each workpiece (for backoff display).
- `~/.assembly/usage-status.json` (provider quota).
- Each workpiece's `totals` field (for cost rollups).

---

## Real-time updates

**Polling-based.** The browser client fetches `/api/state` every 3 seconds. There's no WebSocket or SSE.

The client uses **morphdom** to diff the new HTML against the live DOM and apply minimal updates. This preserves:
- Form state (open drawers, expanded cards).
- Focus and selection.
- Ephemeral classes (animations).

Connection health is tracked client-side via response timestamps:
- `live` — last response < 5s ago.
- `stale` — 5–30s.
- `disconnected` — > 30s — the UI shows a warning.

---

## Manual retry

POST `/api/line/<lineName>/retry` with `{ fileName: "error-xxx.json" }`.

[`retry-manual.ts`](../src/retry-manual.ts) does:
1. Validates the filename is a bare basename (no path traversal).
2. Reads the original workpiece.
3. Creates a fresh workpiece with a new `id`, empty `stations: {}`, and `parent_run_id` pointing at the original.
4. Writes to `queues/inbox/<newName>.json` and records it in `.emitted.jsonl` with source `cli`.
5. Marks the original as `dismissed` in `queues/error/.dismissed`.
6. Logs `retry_manual` to `queues/activity.jsonl`.

The new workpiece is picked up by the orchestrator on the normal inbox watcher path.

---

## Error dismissal

POST `/api/line/<lineName>/errors/dismiss` with `{ fileNames: ["err-1.json", "err-2.json"] }`.

Stored in `queues/error/.dismissed` (atomic write — temp + rename). The dashboard hides dismissed errors from the active list but they're still in the directory.

Auto-archive: an internal sweep marks errors older than 7 days as `auto: true` in the dismissed map, decluttering the UI without deleting anything.

---

## Task events stream

For each (workpiece, station) the section worker can emit fine-grained events via [`appendTaskEvent`](../src/task-events.ts). Storage:

```
queues/task-events/<wpId>/
  index.json                 # { stations: { name: { status, count, last_ts } } }
  <station>.events.jsonl     # one event per line
```

Event shape:

```json
{
  "ts": "2026-05-13T22:17:04Z",
  "seq": 17,
  "station": "scrape",
  "kind": "tool_call" | "tool_result" | "message" | "heartbeat" | "lifecycle",
  "summary": "WebFetch(linkedin.com/jobs/...)",
  "detail": { ... }       // capped at 8 KB
}
```

`seq` is a monotonic counter per `(linePath, wpId, stationName)`, stored in-memory in the worker. The dashboard paginates via `seq` so the page can scroll backward without re-reading the whole file.

Endpoints:

```
GET /api/task-events/<line>/<wpId>
  → { stations: { name: { status, count, last_ts } } }

GET /api/task-events/<line>/<wpId>/<station>?after=<seq>&limit=100
  → { events: [...], next_cursor: <seq> }
```

---

## Cost rollup endpoint

```
GET /api/usage    → reads ~/.assembly/usage-status.json
                    plus session totals from queues
```

Returns:

```json
{
  "paused": false,
  "pauseReason": null,
  "providers": { "anthropic": { "remaining_quota": "...", "reset_at": "..." } },
  "ageMs": 8400,
  "sessionTotals": {
    "tokens": { "in": 1283000, "out": 274000, "cache_read": 480000, "cache_creation": 18000 },
    "cost_usd": 22.41,
    "byStation": {
      "enrich": { "cost_usd": 12.04, "tokens_in": 712000, "tokens_out": 198000, "count": 38 }
    }
  }
}
```

The byStation rollup comes from walking `queues/done/`, `queues/error/`, and `queues/review/` and summing `workpiece.stations[name].cost_usd`. Throughput counts `queues/done/` files by mtime in rolling 1h / 24h windows.

---

## PID and daemon independence

| File | Owner |
|------|-------|
| `~/.assembly/orchestrator.pid` | Daemon |
| `~/.assembly/dashboard.pid` | Dashboard |
| `~/.assembly/usage-status.json` | Daemon writes; dashboard reads |

The dashboard does not call into the daemon. The daemon does not call into the dashboard. They communicate only through files on disk. This means:

- You can stop and start the dashboard freely without affecting in-flight workpieces.
- After a daemon crash, the dashboard still shows the last known state (which is fully accurate, because state is on disk).
- After a dashboard crash, nothing else is affected.

---

## API summary

```
GET  /                                      → SPA shell
GET  /api/state                             → full dashboard state JSON
GET  /api/usage                             → cost + quota snapshot
GET  /api/task-events/<line>/<wpId>         → station index
GET  /api/task-events/<line>/<wpId>/<station>?after=<seq>&limit=<n>
POST /api/line/<line>/retry                 → manual retry
POST /api/line/<line>/errors/dismiss        → dismiss errors
GET  /api/lines/<line>/workpieces/<id>      → single workpiece JSON
```

Static assets for the built React app are served from `web/dist/assets/`. The legacy client JS bundle and morphdom UMD remain served inline by the fallback shell.

---

## What it deliberately doesn't do

- **Mutate state besides retry / dismiss.** No "delete this workpiece", no "edit input", no "force-route to station X" — those operations would race with the orchestrator. To force something, use the CLI (`assembly enqueue`, `assembly run --only`).
- **Authentication.** It binds to `localhost` by default. Anything beyond local should be fronted by your own reverse proxy.
- **Streaming.** Polling is enough at the cadence we need. If you wanted to add SSE, [`task-events.ts`](../src/task-events.ts) is the natural source.
