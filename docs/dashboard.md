# Dashboard

The dashboard is a Bun HTTP server plus a React SPA. The server reads Assembly's file-backed runtime state on demand, exposes JSON API routes, and serves the built frontend from `web/dist/`; the browser never talks directly to queue files.

It is independent of the daemon. The daemon can run without the dashboard, and the dashboard can run without the daemon; when the daemon is stopped, the dashboard still shows the last state written to disk.

Key implementation files:

| File | Purpose |
|------|---------|
| [`../src/global-dashboard.ts`](../src/global-dashboard.ts) | Bun HTTP API server and static asset server |
| [`../src/dashboard-server.ts`](../src/dashboard-server.ts) | CLI process wrapper, PID file, signal handling |
| [`../src/dashboard-data.ts`](../src/dashboard-data.ts) | State aggregation from queues and sidecar files |
| [`../src/dashboard-api.ts`](../src/dashboard-api.ts) | Shared dashboard wire types |
| [`../web/`](../web/) | React/Vite/shadcn dashboard frontend |
| [`../src/task-events.ts`](../src/task-events.ts) | Per-station event stream |
| [`../src/retry-manual.ts`](../src/retry-manual.ts) | Human-triggered retry endpoint |
| [`../src/error-dismiss.ts`](../src/error-dismiss.ts) | Error suppression endpoint |

---

## Running It

```bash
assembly dashboard [--port 4111] [--host 127.0.0.1]
```

The default bind host is `127.0.0.1` and the default port is `4111`. Browse to `http://127.0.0.1:4111` or `http://localhost:4111`.

Remote exposure requires an explicit `--host` value and, after the auth hardening step lands, `ASSEMBLY_DASHBOARD_TOKEN`.

The process writes `~/.assembly/dashboard.pid` with `{ pid, port, host }`. The CLI refuses to double-start when that PID still points at a live process.

To stop it:

```bash
assembly dashboard stop
```

When `web/dist/index.html` exists, the Bun server serves the built Vite SPA and its assets from `web/dist/assets/`. If the bundle is absent, `global-dashboard.ts` serves the embedded legacy fallback shell for compatibility only.

---

## What It Shows

The React SPA is served as a catch-all page so frontend routes work on refresh.

| View | What it shows |
|------|---------------|
| Kanban | One column per stage per line: held, inbox, station inbox, processing, output, done, error, review |
| Drawer | Per-workpiece detail: stations, status, model, tokens, cost, eval, content/data, sidecar tails |
| Activity | Recent line-level events from `queues/activity.jsonl` |
| Error banner | Active errors with severity and dismissal controls |
| Retry panel | Manual retry for errored workpieces |
| Usage / cost | Session totals plus per-station token and USD rollups |
| Throughput | Done counts over rolling 1h and 24h windows |
| Historical timings | Per-station min, max, and average duration across recent completed runs |
| Task events | Drawer subview for per-workpiece, per-station event streams |

---

## Architecture and Data Flow

The dashboard treats the filesystem as the source of truth:

1. Browser routes and assets are served by `src/global-dashboard.ts`.
2. API requests call helpers in `src/dashboard-data.ts`.
3. `dashboard-data.ts` reads queue directories, JSONL logs, usage state, and sidecar files on demand.
4. API responses are serialized using the shared shapes in `src/dashboard-api.ts`.
5. The React app renders those responses and polls again for freshness.

There is no dashboard database, no message broker, and no required daemon RPC.

Per request, `getFullState()` reads:

- Line-level queues: `inbox`, `held`, `done`, `error`, and `review`.
- Station queues: `inbox`, `processing`, and `output`.
- `queues/activity.jsonl` for recent activity.
- `queues/flow.jsonl` for chart snapshots.
- `queues/task-events/<wpId>/` lazily for drawer task-event views.
- `queues/error/.dismissed` to filter dismissed errors.
- `.retry.json` sidecars for retry/backoff display.
- `~/.assembly/usage-status.json` for provider quota.
- Each workpiece's `totals` and station cost fields for rollups.

---

## Frontend Freshness

The frontend uses TanStack Query. Operational queries poll every 3 seconds, so the dashboard updates without requiring WebSockets or SSE.

Connection state is derived from request timing and failures:

| State | Meaning |
|-------|---------|
| Live | Recent API responses are arriving normally |
| Stale | Responses are delayed or older than expected |
| Disconnected | Requests are failing or no response has arrived for an extended window |

The legacy fallback client still exists for compatibility when the built SPA is missing. It is not the current dashboard architecture.

---

## Development Workflow

Run the Bun dashboard API server and the Vite frontend server side by side:

```bash
assembly dashboard --port 4111
bun run dashboard:web
```

`bun run dashboard:web` starts Vite from `web/`. The Vite dev server serves the React app and proxies `/api` requests to `http://localhost:4111`, so frontend code talks to the same Bun API used in production.

Use this workflow when changing React components, routes, styles, query hooks, or shadcn blocks. Do not use it to start or stop a production dashboard; the process wrapper owns `~/.assembly/dashboard.pid`.

---

## Build and Ship Workflow

Build the dashboard bundle from the repository root:

```bash
bun run build:web
```

That runs the `web` workspace build and writes `web/dist/index.html` plus `web/dist/assets/`.

`web/dist/` is intentionally committed so globally installed copies of Assembly can serve the React SPA without requiring users to build frontend assets locally. The package `prepublishOnly` script runs `bun run build:web` before publishing.

Run `bun run build:web` when:

- `web/dist/` is missing.
- Frontend source under `web/` changed.
- The dashboard shows stale UI after a checkout, merge, or install.
- You are preparing a publish or global install path.

---

## Manual Retry

POST `/api/line/<line>/retry` with `{ "fileName": "error-xxx.json" }`.

`retry-manual.ts`:

1. Validates the filename is a bare basename.
2. Reads the original workpiece.
3. Creates a fresh workpiece with a new `id`, empty `stations`, and `parent_run_id` pointing at the original.
4. Writes to `queues/inbox/<newName>.json` and records the emission in `.emitted.jsonl`.
5. Marks the original error as dismissed in `queues/error/.dismissed`.
6. Logs `retry_manual` to `queues/activity.jsonl`.

The new workpiece is picked up by the daemon through the normal inbox watcher path.

---

## Error Dismissal

POST `/api/line/<line>/errors/dismiss` with `{ "fileNames": ["err-1.json", "err-2.json"] }`.

Dismissals are stored in `queues/error/.dismissed` using an atomic temp-file rename. The dashboard hides dismissed errors from the active list, but the source files remain in the queue directory.

An internal sweep marks errors older than 7 days as auto-dismissed to keep the UI focused without deleting history.

---

## Task Events

For each `(workpiece, station)`, a section worker can emit fine-grained events through `appendTaskEvent()`.

Storage:

```text
queues/task-events/<wpId>/
  index.json
  <station>.events.jsonl
```

Event shape:

```json
{
  "ts": "2026-05-13T22:17:04Z",
  "seq": 17,
  "station": "scrape",
  "kind": "tool_call",
  "summary": "WebFetch(linkedin.com/jobs/...)",
  "detail": {}
}
```

`seq` is a monotonic counter per `(linePath, wpId, stationName)`, stored in memory in the worker. The dashboard paginates by `seq` so it can load older event pages without re-reading the entire file.

---

## Endpoint Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | React SPA shell |
| GET | `/api/state` | Full dashboard state JSON |
| GET | `/api/usage` | Cost and provider quota snapshot |
| GET | `/api/task-events/<line>/<wpId>` | Station event index for a workpiece |
| GET | `/api/task-events/<line>/<wpId>/<station>?after=<seq>&limit=<n>` | Paginated station event stream |
| POST | `/api/line/<line>/retry` | Create a retry workpiece from an errored workpiece |
| POST | `/api/line/<line>/errors/dismiss` | Dismiss active errors |
| GET | `/api/lines/<line>/workpieces/<id>` | Single workpiece JSON |

Static assets for the built React app are served from `web/dist/assets/`.

---

## PID and Daemon Independence

| File | Owner |
|------|-------|
| `~/.assembly/orchestrator.pid` | Daemon |
| `~/.assembly/dashboard.pid` | Dashboard |
| `~/.assembly/usage-status.json` | Daemon writes, dashboard reads |

The dashboard does not call into the daemon. The daemon does not call into the dashboard. They communicate through files on disk.

This means:

- Stopping the dashboard does not affect in-flight workpieces.
- Restarting the daemon does not invalidate dashboard state already written to disk.
- Restarting the dashboard does not move, retry, or delete workpieces.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Dashboard shows an old UI | Rebuild with `bun run build:web`; stale `web/dist/` is usually the cause |
| Source checkout serves the fallback shell | `web/dist/index.html` is missing; run `bun run build:web` |
| Vite app cannot load data | Confirm `assembly dashboard --port 4111` is running and Vite is proxying `/api` to that port |
| Port collision | Start the dashboard on a different port and align the Vite proxy if needed |
| Static assets 404 | Rebuild `web/dist/` and confirm `web/dist/assets/` exists |
| API data looks stale | Inspect the underlying queue files; dashboard APIs read disk state on demand |
| Cannot start dashboard | Check `~/.assembly/dashboard.pid`; a live PID prevents double-start |

---

## What It Deliberately Does Not Do

- Mutate state beyond retry and dismiss operations.
- Authenticate users. It is intended for local use unless placed behind a reverse proxy.
- Stream updates. The current contract is TanStack Query polling every 3 seconds.
- Replace the CLI for force-routing, editing inputs, or deleting workpieces.
