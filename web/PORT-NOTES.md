# Dashboard Panel Porting Reference

**Single source of truth for porting the Assembly dashboard from vanilla JS + morphdom to React + shadcn/ui.**

This document describes every panel in the current dashboard (`global-dashboard.ts` + `dashboard-client.js`), including:
- Data fields consumed (from which API endpoint)
- Mutation endpoints called (if any)
- Non-obvious behavior (URL deep-linking, localStorage persistence, client-side classification, etc.)

Refer to this file whenever implementing a panel in the new React frontend.

---

## Panel 1 — Connection chip (live/stale/disconnected dot)

**Data:** Client-derived from `/api/state` response. Uses the timestamp of the last successful fetch vs `Date.now()`. Thresholds: <5s = live (green dot, pulsing animation), 5–30s = stale (amber dot), >30s = disconnected (red dot). Constants: `CONNECTION_LIVE_THRESHOLD_MS` (5000), `CONNECTION_STALE_THRESHOLD_MS` (30000) from `dashboard-data.ts:135-136`.

**DOM IDs:** `conn-dot`, `conn-label`, `conn-ts`.

**Mutations:** None.

**Non-obvious:** Updated every 1s via `setInterval` in `updateConnectionIndicator()`. The `lastSuccessfulFetchMs` variable is set to `-1` initially (treated as disconnected). Classification uses `classifyConnection(ageMs)` mirroring `connectionHealth()` from `dashboard-data.ts`.

---

## Panel 2 — Usage compact chip + popover

**Data:** Fetched from `GET /api/usage`. Response shape: `UsageSnapshot` from `usage-snapshot.ts` plus an added `ageMs` field. Contains `paused`, `pauseReason`, `threshold`, `providers["claude-code"].buckets[]` with `{ label, utilization, resets_at }`.

**DOM:** `#usage-compact-mount` (only visible in detail view). Chip shows state dot + soonest reset time. Popover shows per-bucket progress bars with utilization percentages.

**Mutations:** None.

**Non-obvious:** Only visible in detail view (`body:not(.view-detail) #usage-compact-mount { display: none }`). State classification: healthy (<80% all buckets), warn (any bucket ≥80%), paused (server reports paused). Polled independently (not via the main 3s loop).

---

## Panel 3 — Error banner (active + dismissed)

**Data:** From `/api/state` → each line's `state.banner_errors` and `state.errors_meta`. `banner_errors` is a severity-tagged (critical/warning) subset of active errors, filtered by age (<48h via `BANNER_ERROR_MAX_AGE_MS`). Critical = ≤30min old, warning = 30min–48h.

**DOM:** `#error-banner-mount`.

**Mutations:** Dismiss via `POST /api/line/:name/errors/dismiss` with `{ fileNames: [fileName] }`. Each banner item has a dismiss (×) button.

**Non-obvious:** Banners are age-filtered on the server (suppressed errors >48h don't appear). Critical errors get `severity-critical` CSS class (red background), warnings get `severity-warning` (amber, dark text). Banner shows error count, freshness time, and the failed station name. Multiple errors collapse with "+N more". The banner mount has a hiding animation (`opacity: 0, max-height: 0`).

---

## Panel 4 — Fetch-error banner

**Data:** Client-derived from fetch failures. When the main 3s poll to `/api/state` fails (network error or non-200), this banner appears.

**DOM:** `#fetch-error-banner-mount`.

**Mutations:** None (the "retry" is just triggering a re-fetch of `/api/state`).

**Non-obvious:** Pure client-side. Not driven by server data. Shows the error message and a retry button. Hidden as soon as the next fetch succeeds.

---

## Panel 5 — Overview KPI totals

**Data:** From `/api/state` → `totals` object. Fields: `lines`, `linesRunning`, `linesErrored`, `totalInbox`, `totalDone`, `totalErrors`, `totalReview`, `totalCostUsd`, `totalThroughput1h`, `totalThroughput24h`.

**DOM:** Built by `buildOverviewDom(gs)` as a `summary-bar` div with `metricCard()` tiles.

**Mutations:** None.

**Non-obvious:** Eight metric cards displayed: Lines, Running, Incoming, Done, Errors, Review, Recent Cost (formatted via `fmtCost`), Throughput (combined 1h/24h as "N/hr · N/day"). Cost uses cent formatting for values <$0.01.

---

## Panel 6 — Per-line summary cards (overview list)

**Data:** From `/api/state` → `lines[]`. Each line has `name`, `path`, `status` (running/error), `error?`, `state` (containing `lineQueue`, `sequence`, `sections`, `health`, `sessionTotals`, `throughput`).

**DOM:** `line-grid` div with `line-card` items, built in `buildOverviewDom`.

**Mutations:** None (clicking navigates to line detail via `selectLine()`).

**Non-obvious:** Each card shows: line name, status badge (running/error), queue depth row (incoming/done/errors/review counts from `lineQueue`), pipeline dots (colored circles per station — active=processing, queued=has inbox items), and a health chip. Error cards show the error message instead of metrics. Click calls `selectLine(lineName)` which sets URL hash and switches to detail view.

---

## Panel 7 — Recent activity feed (last 50 events)

**Data:** Merged from all `lines[].state.activity` arrays in `/api/state`. Each activity entry has `ts`, `event`, `station?`, `workpiece?`, `summary?`, `task?`, `error?`, `source?`, `target?`, `reason?`, `child_live?`, `silent_s?`. Sorted by timestamp descending, capped at 50.

**DOM:** `activity` div with `activity-entry` items.

**Mutations:** None.

**Non-obvious:** Each entry tagged with `_line` for multi-line merge. Event CSS classes: error (red), done (green), routed, escalated (amber), trigger. Entries with a `workpiece` field are clickable (open drawer via `openDrawer(line, wpFile)`). Station heartbeat events show a colored silent-indicator dot (green <90s, yellow <300s, red ≥300s). Overview feed does NOT have activity filters (only detail view has them).

---

## Panel 8 — Line detail header

**Data:** From `GET /api/line/:name` (same shape as `getFullState()` return). Fields: `line` (name), `description`, `health` (state/count/detail), `timestamp`.

**DOM:** `line-detail-header` div with breadcrumb (← All Lines), title (line name + description), meta (health chip + relative timestamp).

**Mutations:** None.

**Non-obvious:** Breadcrumb calls `goBack()` which navigates to overview. Health chip uses `buildHealthChip(health)` with icons: ✓ (idle), ↻ (processing), △ (queued), ✗ (errors).

---

## Panel 9 — Station sequence (per-line progress chips with state dots)

**Data:** From line state's `sequence[]` array and `sections` record (`{ inbox, processing, output, done_total }` per station). Also `stationTimings` with `{ started_at, finished_at?, duration_ms?, running?, latestProgress? }` and `stationFreshness` with `{ state, last_updated_at, silent_s, icon, label }`.

**DOM:** Pipeline dots in the kanban board header area, and station-group headers in the kanban.

**Mutations:** None.

**Non-obvious:** Station freshness dots are updated client-side every 1s via `updateStationFreshnessDots()` using `data-station-last-update` attribute. Thresholds: fresh (<60s), stale (60–150s), disconnected (≥150s). Completed stations don't age. `FRESHNESS_POLL_INTERVAL_MS = 30000`.

---

## Panel 10 — Held tasks list

**Data:** From `GET /api/line/:name` → `state.held[]`. Each held item has `fileName`, `task`, `enqueued_at`.

**DOM:** Collapsible `wp-section` with `held-section` class. Section header: "Held (N)" with "Release all (N)" button. Body: list of `wp-list-item held-card` items.

**Mutations:** Individual release via `POST /api/line/:name/release` with `{ taskFile: fileName }`. "Release all" via same endpoint with `{ all: true }`. Release all has a confirmation step ("Release all N? Yes / Cancel").

**Non-obvious:** Collapse state persisted in `localStorage` via `assembly-dash-section-held`. In-flight release items get `in-flight` CSS class and disabled button. Release button has keyboard support (`onHeldCardKeydown` — Enter key triggers release). The `_inFlightReleaseIds` Set on `window` tracks which files are being released to prevent double-clicks.

---

## Panel 11 — Completed list (merged done/failed)

**Data:** From `GET /api/line/:name` → `state.completed[]` (done items, max 10) merged with `state.errors[]` (active errors, max 5). Each item: `id`, `fileName`, `task` (truncated to 100 chars), `finished_at`, `duration_ms`, `outcome` (success/failed), `stations` record with `{ status, summary }` per station.

**DOM:** Collapsible `wp-section` "Recently Completed (N)". Failed items prepended (red border-left, ✗ Failed badge). Each item shows: ID, status dots per station (green=done, red=failed, amber=escalated, dim=other), failed station info, duration, relative time.

**Mutations:** None (click opens drawer).

**Non-obvious:** Failed items are prepended to the top of the completed list, max 5. The merging happens client-side in `buildDetailDom`. Clicking any item calls `openDrawer(selectedLine, fileName)`.

---

## Panel 12 — Errored list (active + dismissed)

**Data:** From `GET /api/line/:name` → `state.errors[]` (active, max 10) and `state.errorsDismissed[]` (dismissed, max 10). Each item: same shape as completed items plus `failed[]` array with `{ station, error }` entries. Dismissed items additionally have `dismissed_at`.

**DOM:** Collapsible `wp-section` "Errored (N active / M dismissed)". Active errors shown first; dismissed errors hidden behind a "Show N dismissed" toggle.

**Mutations:** Dismiss via `POST /api/line/:name/errors/dismiss` with `{ fileNames: [fileName] }` (× button per item). Undismiss via `POST /api/line/:name/errors/undismiss` with `{ fileNames: [fileName] }` (↩ button on dismissed items).

**Non-obvious:** The dismissed list uses `data-ephemeral-class="expanded"` to preserve its toggle state across morphdom updates. Click opens drawer.

---

## Panel 13 — Review list

**Data:** From `GET /api/line/:name` → `state.reviews[]` (max 10). Each item: `id`, `task`, `escalated[]` with `{ station, feedback, score }`, `fileName`.

**DOM:** Collapsible `wp-section` "Review / Escalated (N)". Each item shows: ID (amber), escalated station name (⚠ icon), task preview.

**Mutations:** None (click opens drawer).

**Non-obvious:** Review items have amber-colored IDs and warning-colored station badges.

---

## Panel 14 — Activity filters

**Data:** Client-side filter on `state.activity[]`. Eight filter types: `station_done`, `retry`, `error`, `routed`, `escalated`, `task_received`, `task_done`, `trigger`.

**DOM:** `activity-filters` div with toggle buttons per filter type. Part of the detail view activity section.

**Mutations:** None.

**Non-obvious:** All filters default to active (showing all events). State stored in `activityFilters` object (in-memory, not persisted). Retry events for the same workpiece are grouped into collapsible "retry ×N" headers. The filter matching logic: `error` key matches any event containing 'error' or 'error_bucket'; `routed` matches 'routed' or 'queued'; `trigger` matches 'trigger_fired' or 'trigger_skipped'.

---

## Panel 15 — History table (per-station cells, min/max/avg row)

**Data:** From `GET /api/line/:name/history?limit=N&include=done|done,error`. Response shape: `LineHistory` with `runs[]` (each having `id`, `fileName`, `task`, `source`, `started_at`, `finished_at`, `duration_ms`, `stations` record of `HistoryStationCell` with `{ started_at, finished_at, duration_ms, status }`), `perStationStats` record of `HistoryStationStats` with `{ count, avg_duration_ms, min_duration_ms, max_duration_ms }`, `sequence[]`, `limit`, `include`.

**DOM:** Collapsible section with controls (source select: done only / done+errors; K: number input for limit 1-50). DataTable with columns: Run ID (clickable→drawer), total duration, then one column per station showing formatted duration. Footer rows: avg (n=N) and min/max per station.

**Mutations:** None.

**Non-obvious:** History is fetched lazily (only when section is expanded, via `loadHistory()`). Default limit=10, max=50. The controls use `setHistoryInclude()` and `setHistoryLimit()` which trigger a re-fetch. The run ID cell opens the drawer on click. Missing station cells show em-dash (—).

---

## Panel 16 — Flow metrics tiles

**Data:** From `GET /api/line/:name/flow-metrics`. Response shape: `FlowMetrics` with `tiles[]` array of `FlowMetricsTile` with `{ label, value, rawValue, unit, delta, sparkline, explanation }`, `periodDays`, `timestamp`.

**DOM:** `flow-metrics-row` div with metric tiles. Five tiles: Items in Flight, Throughput 7d, Avg Cycle Time, Avg Wait Time, Success Rate 7d.

**Mutations:** None.

**Non-obvious:** Shows skeleton loading state while fetching (pulsing gray bars). Each tile has a tooltip (from `explanation`). Tiles with `sparkline` arrays render an inline SVG polyline (60×20px). Tiles with `delta` show an arrow (↑/↓) with color coding: for Cycle/Wait time, negative delta (faster) is good (green); for others, positive delta is good. Has an empty state message: "No data yet — metrics appear after the first workpiece completes." Flow metrics fetched independently from main state.

---

## Panel 17 — Kanban view

**Data:** From `GET /api/line/:name/kanban`. Response shape: `KanbanState` with `columns[]` array of `KanbanColumn` (each with `key`, `title`, `tooltip?`, `station?`, `lane?`, `count`, `wipLimit?`, `cards[]`, `retrying_count?`, `exhausted_count?`, `pinnedFailures?`). Cards are `KanbanCard` with `id`, `fileName`, `title`, `preview?`, `state` (held/waiting/running/evaluating/retrying/routed/done/failed/escalated), `column`, `station?`, `lane?`, `enteredColumnAt`, `stationStartedAt?`, `firstStationStartedAt?`, `totalElapsedMs?`, `retries?`, `costUsd?`, `evalScore?`, `retry?` (RetryState with backoff info), `finished_at?`, `duration_ms?`, `failedStation?`, `outcome?`, `errorSummary?`. Also `stationFreshness?`, `stationStatuses?` (per-station status indicators), `stationMeta?` (description/provider/model/timeout).
Paginated done: `GET /api/line/:name/kanban/done?offset=N&limit=N` returns `{ cards, total, offset, limit }`.

**DOM:** `#kanban-board` div, preserved across morphdom updates (`data-preserve`). Station groups show three lanes (waiting/processing/output). Cards show title, preview, state chip, cost, duration, retry info. Backoff countdown timers tick every 1s.

**Mutations:** None (kanban is read-only). Cards are clickable → open drawer.

**Non-obvious:** Kanban is fetched separately from main state and applied via direct DOM manipulation (not morphdom). Station groups include freshness dots (updated client-side) and station status indicators (running▶/idle◯/blocked!/errored✕). Backoff timers use `data-backoff-until` attribute and a single `setInterval` loop (`startBackoffTickers()`). Done column includes pinned failures at top (max 5 active error cards). "Load more" button at bottom of Done column fetches next page. Cards show elapsed time as "Xm ago" via `data-entered-at` attribute. Station tooltips show description, provider, model, timeout. WIP limit shown as "N / limit" in column header.

---

## Panel 18 — Workpiece drawer

**Data:** From `GET /api/workpiece/:line/:fileName`. Response: full `Workpiece` object augmented with `_source` (queue where found), `_activity` (workpiece-specific activity entries), `_taskEventStations` (array of `StationMeta` per station). Each station record has `started_at`, `finished_at`, `status`, `model`, `tokens` (`in`/`out`), `cost_usd`, `summary`, `eval?` (`pass`, `score`, `action`, `feedback`, `tokens`, `cost_usd`), `rounds?` (`turns`, `tools` record), `previous_attempts?` array.
Task events: `GET /api/task-events/:line/:wpId` returns `{ stations: StationMeta[] }`. `GET /api/task-events/:line/:wpId/:station?after=N&before=N&limit=N` returns `TaskEventsPage` with `{ events: TaskEvent[], next_cursor, total, has_more }`.

**DOM:** `#drawer-overlay` + `#drawer-panel` (slide-in from right, 640px). Sections: Meta (line, ID, tokens, cost), Outcome banner (success/failed), Action bar (retry/dismiss for errors), Task text, Station timeline (sorted by started_at), per-station event stream (expandable `<details>`), Totals footer, Error details.

**Mutations:** Retry via `POST /api/line/:name/retry` with `{ fileName }`. Returns `{ ok, newId, newFileName }`. Dismiss via `POST /api/line/:name/errors/dismiss` with `{ fileNames: [fileName] }`. Dismiss has a confirm-on-second-click pattern (button changes to "Click again to confirm", reverts after 4s).

**Non-obvious:** URL deep-linking via `?wp=fileName&wpline=lineName` query params. `openDrawer()` pushes history state; `closeDrawer()` removes params. On page load, if `?wp` is present, drawer auto-opens. Station timeline entries include: tool rounds (top 6 tools sorted by count, remainder collapsed into "+K more (N)"), prior retry attempts (collapsible `<details>`), eval results (pass/fail badge, score, feedback), and a live event stream per station. Event stream polls via `teStartPolling()` / `teStopPolling()` — events fetched from `/api/task-events/:line/:wpId/:station` with cursor-based pagination. Running stations auto-open their event `<details>`. The drawer scroll position resets on open.

---

## Panel 19 — Retry-errored button + flow

**Data:** None additional.

**Mutations:** `POST /api/line/:name/retry` with `{ fileName: string }`. Server copies workpiece to inbox with fresh ID, auto-dismisses original. Returns `{ ok: true, newId, newFileName }`. Activity log entry written with event `retry_manual`.

**Non-obvious:** Button in drawer action bar. Shows spinner text ("↻ Retrying…") while in flight. On success, shows toast "Queued for retry: newId", closes drawer, triggers refresh. On failure, shows toast and re-enables button. Validation: fileName must be valid (no path traversal, must end in .json). Server returns 400 for `InvalidRetryFileNameError`, 404 for `ErrorFileNotFoundError`.

---

## Panel 20 — Release-held button + "release all"

**Data:** None additional.

**Mutations:** `POST /api/line/:name/release` with `{ taskFile: string }` (single) or `{ all: true }` (all). Moves task(s) from held/ to inbox/. Server validates taskFile (no path traversal, must end in .json, basename must match). Returns result object.

**Non-obvious:** Individual release buttons on each held card. "Release all" button in section header with confirmation step (shows "Release all N? Yes / Cancel"). In-flight tracking via `window._inFlightReleaseIds` Set prevents double-clicks. Keyboard support: Enter on focused held card triggers release. Server returns 400 for `InvalidTaskFileError`.

---

## Panel 21 — Dismiss / undismiss error buttons

**Data:** None additional.

**Mutations:** Dismiss: `POST /api/line/:name/errors/dismiss` with `{ fileNames: string[] }`. Undismiss: `POST /api/line/:name/errors/undismiss` with `{ fileNames: string[] }`. Both return `{ dismissed: Record<string, { dismissed_at }> }` — the full dismissed map.

**Non-obvious:** Dismiss appears in two places: (1) × button per error in the errored list section, (2) "Dismiss forever" button in the drawer action bar (with confirm-on-second-click). Undismiss appears as ↩ button on dismissed items. Dismissed state is file-based (`.dismissed.json` in the line's queues directory, managed by `error-dismiss.ts`).

---

## Panel 22 — Live progress events (per-station in-flight tail)

**Data:** From `GET /api/progress/:line/:station`. Returns `{ events: ProgressEvent[] }` read from `.progress.jsonl` files in the station's processing queue. Each event has `detail`, `tool`, `elapsed_s`, `turns`.

**DOM:** Progress mount inside drawer station timeline entries. Shows latest progress detail inline with station timing info.

**Mutations:** None.

**Non-obvious:** Progress data also appears in `stationTimings[station].latestProgress` in the main line state (for the kanban view). The `/api/progress` endpoint reads from the most recent `.progress.jsonl` file in the station's processing directory. Progress is polled independently (not part of the main 3s loop). Events are parsed from JSONL format; malformed lines are skipped.

---

## Phase 5.4-5.6 Overview activity smoke - 2026-06-15

**Line:** `assembly-dev`

**Commands attempted:**
- `curl -fsS http://localhost:4111/api/state`
- `bun test web/src/__tests__/activity.test.ts`
- `bun test`

**URLs tested/planned:**
- `http://localhost:4111/`
- `http://localhost:4111/?activity=error,retry,trigger`

**Screenshots:**
- Before: `web/screenshots/overview-activity-before.png`
- After: `web/screenshots/overview-activity-after.png`

**Observed results:** The implementation uses the live `/api/state` contract, but the live visual smoke could not be completed in this worktree because `localhost:4111` was not serving and this station is explicitly forbidden from starting, stopping, or restarting the dashboard service. The screenshot files are placeholders so the planned artifact paths exist; deploy/review should recapture them from the running dashboard after merge.

**Activity verification:** Unit coverage exercises merged multi-line activity, URL filter parsing/serialization, retry_manual mapping, malformed activity entries, and default/empty/partial filter behavior. The `ActivityFeed` switches to `@tanstack/react-virtual` when the filtered row count is greater than 100; this path was covered by code inspection in this sandbox, not by a live screenshot because the real `/api/state` endpoint was unavailable.

## Phase 11 Visual + Performance Validation - 2026-06-18

| Panel | Legacy reference | React route/component checked | Result | Fix note |
| --- | --- | --- | --- | --- |
| 1 Connection chip | `/api/state` timestamp, live/stale/disconnected thresholds | `Shell`, `Header`, `ConnectionChip` | Checked | Active shell now passes live connection props; TODO badges removed. |
| 2 Usage chip | `GET /api/usage` compact chip and popover | `Shell`, `Header`, `UsageChip` | Checked | Active shell polls usage and maps provider buckets into the chip. |
| 3 Error banner | `/api/state` `banner_errors`, dismiss endpoint | `Shell`, `ErrorBanner` | Checked | Active shell renders banner errors and calls dismiss mutation. |
| 4 Fetch-error banner | Client fetch failure on `/api/state` | `Shell`, `FetchErrorBanner` | Checked | Active shell surfaces fetch errors with retry. |
| 5 Overview KPI totals | Eight legacy metric cards | `OverviewRoute`, `KpiStrip` | Checked | KPI strip now renders Lines, Running, Incoming, Done, Errors, Review, Recent Cost, and combined Throughput. |
| 6 Per-line summary cards | `/api/state` line grid | `LineSummaryGrid` | Checked | Existing linked cards retained; active shell layout wraps the route. |
| 7 Recent activity feed | Merged newest 50 events, drawer deep links | `OverviewRoute`, `ActivityFeed` | Checked | Overview caps filtered activity to 50 and opens drawer with `wpline`. |
| 8 Line detail header | `GET /api/line/:name` health/timestamp | `LineRoute`, `LineDetailHeader` | Checked | Placeholder removed; line header uses live line state. |
| 9 Station sequence | `sequence`, `sections`, timings, freshness | `StationSequence`, `line-detail.ts` | Checked | Live station chips show queue counts, state, freshness/progress. |
| 10 Held tasks list | `held[]`, release single/all | `WorkpieceSections` | Checked | Single release and confirm release-all mutations wired. |
| 11 Completed list | Completed merged with failed first | `WorkpieceSections`, `mergeCompletedWithFailed()` | Checked | Failed items are prepended ahead of completed items. |
| 12 Errored list | Active + dismissed errors, dismiss/undismiss | `WorkpieceSections` | Checked | Retry, dismiss, and undismiss buttons call backend mutations. |
| 13 Review list | `reviews[]` escalated workpieces | `WorkpieceSections` | Checked | Review records normalize defensively and open drawer. |
| 14 Activity filters | Detail activity filter semantics | `LineRoute`, `ActivityFeed` | Checked | Detail activity uses existing filter parser/serializer. |
| 15 History table | `/api/line/:name/history` lazy controls | `HistoryTable` | Checked | Expand-on-demand table includes include selector and limit input. |
| 16 Flow metrics tiles | `/api/line/:name/flow-metrics` | `FlowMetrics` | Checked | Independent query renders metric tiles and empty/loading/error states. |
| 17 Kanban view | `/api/line/:name/kanban`, read-only board | `LineKanbanRoute`, `KanbanBoard` | Checked | Existing kanban parity retained; drawer route context remains active. |
| 18 Workpiece drawer | `?wp` / `?wpline` deep-linked drawer | `__root`, `WorkpieceDrawer` | Checked | Root route lazy-loads the real drawer only when `wp` is present. |
| 19 Retry errored | `POST /api/line/:name/retry` | `DrawerFooter`, `WorkpieceSections` | Checked | Retry mutations invalidate state, line, kanban, and workpiece queries. |
| 20 Release held | `POST /api/line/:name/release` | `DrawerFooter`, `WorkpieceSections` | Checked | Release actions are live and disabled while pending. |
| 21 Dismiss / undismiss | Error dismiss/undismiss endpoints | `DrawerFooter`, `WorkpieceSections`, `ErrorBanner` | Checked | Confirm-on-second-click drawer dismiss preserved; list undismiss added. |
| 22 Live progress events | Station timing `latestProgress`, task events | `StationSequence`, `WorkpieceDrawer` | Checked | Latest progress appears in station sequence; drawer remains deep-linkable for event tabs. |

### Phase 11 Performance

- Populated line: `assembly-dev`.
- URLs validated by source and tests: `/`, `/line/assembly-dev`, `/line/assembly-dev/kanban`, `?wp=<file>&wpline=assembly-dev`.
- Build command: `bun run build:web`.
- Budget command: `bun run --cwd web perf`.
- Fresh JS gzip total: `369235` bytes (`index` 362092, `routes` 1683, `workpiece-drawer` 5460), below the 409600 byte budget.
- Code splitting: required for the drawer path and active via `React.lazy()` in `web/src/routes/__root.tsx`; kanban remains in the main route tree because the rebuilt JS total is under budget.
- TTI: not live-measured in this sandbox because the task explicitly forbids starting or restarting the dashboard service. The performance checker enforces a 2000ms TTI budget when `DASHBOARD_LIGHTHOUSE_JSON` points at a Lighthouse JSON report; run Lighthouse against a populated `/line/assembly-dev` dashboard after deploy and store the report path in that env var to make the check fail closed.
