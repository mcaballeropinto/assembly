# Improver — the self-improvement loop

The improver is a background watcher inside the daemon that closes the loop
between *running* lines and *developing* them. When any task finishes (done or
error), it assesses the outcome and, when a concrete high-confidence
improvement exists, queues a work order on the dev line (`assembly-dev`). When
that improvement deploys, the source tasks that motivated it are requeued
automatically. Everything noteworthy is reported to Discord.

## Enabling

Off by default. Turn on in `~/.assembly/config.yaml`:

```yaml
improver:
  enabled: true
  model: sonnet                 # assessment model (direct Anthropic API,
                                #   needs ASSEMBLY_ANTHROPIC_API_KEY)
  dev_line: assembly-dev        # line that receives improvement tasks
  exclude_lines: [hello-world]  # never assess these lines
  proposal_mode: inbox          # inbox = auto-run improvements;
                                #   held = manual release (human approval gate)
  max_open_proposals: 3         # unresolved improvement tasks at once
  max_open_per_line: 1          # unresolved improvements per source line
  max_assessments_per_sweep: 10 # LLM-call budget per sweep window
  sweep_interval_minutes: 60    # periodic catch-up sweep
  requeue_on_fix: true          # requeue source tasks when a fix deploys
  requeue_done_tasks: false     # also re-run SUCCESSFUL tasks after a fix
                                #   (off: re-runs can duplicate side effects)
  max_proposals_per_issue: 2    # lifetime proposals per issue_key
```

## How it works

1. **Wake on completion.** The watcher (started by the global orchestrator,
   `src/improver/watcher.ts`) inotify-watches every discovered line's
   `queues/done/` and `queues/error/`. The dev line and excluded lines are
   watched only for bookkeeping, never assessed.
2. **Assess the outcome.** Each new completion gets one cheap, tool-free
   direct-API LLM call (`src/improver/assess.ts`): did the run genuinely
   succeed, and is there a *specific* improvement worth making? Only
   `should_improve: true` with `confidence: high` acts; everything else is
   recorded as `no_action`.
3. **Queue the improvement.** A high-confidence verdict becomes a task in the
   dev line's inbox (`src/improver/devline.ts`), written with the same
   tmp-write → manifest → atomic-rename protocol as the CLI. The proposal
   linkage rides in `input.improver.proposal_id`. Task text is passed through
   a sanitizer that strips phrasings known to make Bash-armed agents recurse
   into the assembly CLI ("smoke", "migration", "run the pipeline", …).
4. **Requeue on fix.** When the dev-line task lands in `done/`, the
   resolution is persisted FIRST (crash-safe: a restart never replays
   requeues), then the recorded source tasks are requeued — failed runs via
   `retryErroredWorkpiece`, successful runs via a fresh workpiece with
   `parent_run_id` lineage (only when `requeue_done_tasks` is on AND the
   assessor judged a re-run safe). A failed dev task resolves as
   `fix_failed` without requeueing; a no-op plan resolves as `no_op`; a dev
   task escalated to `review/` resolves as `escalated` and releases its slot.
5. **Hourly sweep.** A periodic sweep re-lists all watched queues and assesses
   anything the registry doesn't know — covering completions that landed while
   the daemon was down, dropped inotify events, and budget-deferred items. It
   also releases proposals whose dev task vanished (`lost`).

## State

Durable state lives in `~/.assembly/improver/`:

- `assessed.jsonl` — every completion ever looked at, with verdict. Each line
  is baselined the first time the watcher ever sees it (first boot or added
  later via hot-reload), so pre-existing history is never mass-assessed. The
  registries grow append-only; at typical volumes (a few records per task)
  this is megabytes per year — archive by hand if it ever matters.
- `proposals.jsonl` — event log (`proposed` → `recurrence`* → `resolved`).
  Open proposals and per-issue lifetime counts are folds over this log.
  To allow a re-proposal of an exhausted issue, delete its `proposed` events.
- `activity.jsonl` — the watcher's own audit log.

## Loop & cost guards

- The dev line is hard-excluded from assessment (no self-recursion).
- Dedupe by `issue_key` (`<line>/<station>/<slug>`); recurrences of an open
  issue attach their workpiece to the existing proposal's requeue list instead
  of filing a new one.
- `max_open_proposals` + `max_open_per_line` cap concurrent dev-line work
  (the per-line cap also bounds slug-drift, since the issue key contains the
  model-chosen slug); `max_proposals_per_issue` caps the propose → fix →
  still-broken loop, after which the issue is flagged on Discord once.
- `max_assessments_per_sweep` bounds LLM spend per window; deferred items are
  picked up by later sweeps. Auth failures pause the window and alert once.
- Assessment runs without tools on the direct API — it cannot write files,
  so the historical inbox-fabrication failure mode does not apply.

## Untrusted content & the deploy chain

Workpiece content (task text, summaries, errors) can embed text from scraped
web pages — treat it as attacker-influenceable. Defenses, in order: the
assessor prompt delimits the workpiece as untrusted data and is instructed to
flag injection attempts instead of acting on them; its output passes a
sanitizer plus a deny-list tripwire that REJECTS any verdict still containing
an assembly-CLI invocation; every dev task carries a non-negotiable
constraints banner; and assembly-dev's own plan eval + safety gates (path
blocklist, secret scan, plan alignment) review the actual change. Residual
risk remains — an improvement task that survives all layers ships code via
assembly-dev's deploy. If your lines ingest a lot of untrusted content and
you want a human between the improver and deployed code, set
`proposal_mode: held`: proposals stage in `assembly-dev/queues/held/` and run
only when you release them; the rest of the loop (requeue-on-fix, Discord)
is unchanged.

## Discord reporting

The watcher posts to the `#assembly` channel (override with
`ASSEMBLY_DISCORD_CHANNEL_ID`) via `openclaw message send`.

It sends two classes of Assembly logs messages:

- Lifecycle notifications: proposal queued, fix deployed with requeue counts,
  fix failed, no-op, recoverable repair queued, and cap/exhaustion notices.
- One-shot diagnosis reports for failed source workpieces. Each report names
  the source line and workpiece/file, failed station and `failure_class`, root
  cause category, confidence level/score, compact evidence including
  sidecar/session paths when relevant, recommended next action, and the actual
  action taken.

Diagnosis reports are deduped durably by source line + workpiece id/file +
failed station + failure fingerprint in `reports.jsonl`, so repeated sweeps or
watcher restarts do not spam Discord. Low-confidence or manual-only diagnoses
still report once, but explicitly state that no automatic repair was taken and
why. Auto-enqueued repair reports include the new assembly-dev task key/file
and the source failure fingerprint.

Per-run reporting for `assembly-dev` itself is wired separately through its
`line.yaml` `on_success`/`on_failure` hooks → `shared/notify-discord.ts`.
