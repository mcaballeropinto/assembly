#!/usr/bin/env bun
/**
 * Discord notification hook for assembly lines.
 *
 * Wired from line.yaml via:
 *   on_success: { script: ../../shared/notify-discord.ts }
 *   on_failure: { script: ../../shared/notify-discord.ts }
 *
 * Invoked by the orchestrator with the workpiece path as argv[2]. The script
 * infers outcome from the stations map (any station with status "failed"
 * means this was an error run) and posts a rich summary to the #assembly
 * Discord channel via `openclaw message send`.
 *
 * Target channel is overridable via ASSEMBLY_DISCORD_CHANNEL_ID env var;
 * default is hard-coded to #assembly in Miguel's server. Bare numeric channel
 * ids are normalized to OpenClaw's explicit `channel:ID` target syntax.
 */

import YAML from "yaml";

const DEFAULT_CHANNEL_TARGET = "channel:1496010860349620286";
const CHANNEL_TARGET = normalizeDiscordTarget(
  process.env.ASSEMBLY_DISCORD_CHANNEL_ID ?? DEFAULT_CHANNEL_TARGET,
);

// Discord hard-caps messages at 2000 chars. Leave slack for the header.
const MAX_MESSAGE_LEN = 1900;

interface StationLike {
  status?: string;
  summary?: string;
  started_at?: string;
  finished_at?: string;
  failure_class?: string;
  rounds?: { turns?: number } | null;
  eval?: { feedback?: string } | null;
}

interface Workpiece {
  id?: string;
  line?: string;
  task?: string;
  input?: Record<string, unknown>;
  stations?: Record<string, StationLike>;
}

type SequenceStep =
  | string
  | { station: { name: string } }
  | { parallel: string[] }
  | { gate: { if_true: string; if_false: string } }
  | { loop: { stations: string[] } };

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function normalizeDiscordTarget(target: string): string {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) return `channel:${trimmed}`;
  return trimmed;
}

function formatDuration(startIso?: string, endIso?: string): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function runDuration(wp: Workpiece): string | null {
  const stations = Object.values(wp.stations ?? {});
  const starts = stations.map((s) => s.started_at).filter((x): x is string => !!x).sort();
  const ends = stations.map((s) => s.finished_at).filter((x): x is string => !!x).sort();
  if (!starts.length || !ends.length) return null;
  return formatDuration(starts[0], ends[ends.length - 1]);
}

function statusEmoji(status?: string): string {
  switch (status) {
    case "done": return "✅";
    case "failed": return "❌";
    case "escalated": return "⚠️";
    case "skipped": return "⏸️";
    default: return "⏭️";
  }
}

function queueLabelFromPath(path: string): "done" | "error" | "review" | "other" {
  const m = path.match(/\/queues\/([^/]+)\//);
  const bucket = m?.[1];
  if (bucket === "done" || bucket === "error" || bucket === "review") return bucket;
  return "other";
}

/**
 * Render a one-line input preview for known fanout shapes. Currently handles
 * `input.seed_companies`, which is the pattern the *-prospector lines use.
 * Other lines fall through to no preview rather than dumping raw JSON.
 */
function inputPreview(input: Record<string, unknown> | undefined): string | null {
  if (!input || typeof input !== "object") return null;
  const seeds = input.seed_companies;
  if (Array.isArray(seeds) && seeds.length) {
    const names = seeds
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).name : null))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    if (names.length) return `📥 ${truncate(names.join(", "), 240)}`;
  }
  return null;
}

function stationDetail(s: StationLike): string {
  const bits: string[] = [];
  const dur = formatDuration(s.started_at, s.finished_at);
  if (dur) bits.push(dur);
  const turns = s.rounds?.turns;
  if (typeof turns === "number" && turns > 0) bits.push(`${turns} turns`);
  if (s.failure_class) bits.push(s.failure_class);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

function buildMessage(
  wp: Workpiece,
  sequence: string[],
  workpiecePath: string,
): string {
  const stations = wp.stations ?? {};
  const failedEntry = Object.entries(stations).find(([, s]) => s.status === "failed");
  const escalatedEntry = Object.entries(stations).find(([, s]) => s.status === "escalated");
  const blockingEntry = failedEntry ?? escalatedEntry;
  const isFailure = !!failedEntry;

  const line = wp.line ?? "unknown-line";
  const runId = wp.id ?? "unknown-run";
  const task = truncate((wp.task ?? "").replace(/\s+/g, " ").trim(), 300);
  const duration = runDuration(wp);
  const queueLabel = queueLabelFromPath(workpiecePath);

  let header: string;
  if (isFailure) {
    header = `❌ **${line}** — Run failed at \`${failedEntry![0]}\``;
  } else if (escalatedEntry) {
    header = `⚠️ **${line}** — Escalated at \`${escalatedEntry![0]}\``;
  } else {
    header = `✅ **${line}** — Run complete`;
  }

  const metaLines = [`\`${runId}\``];
  if (duration) metaLines.push(`⏱ ${duration}`);
  if (queueLabel !== "done" && queueLabel !== "other") metaLines.push(`📂 ${queueLabel}/`);

  const preview = inputPreview(wp.input);

  const stationLines: string[] = [];
  for (const stationName of sequence) {
    const s = stations[stationName];
    if (!s) {
      const reason = blockingEntry
        ? ` — blocked by ${blockingEntry[1].status} at \`${blockingEntry[0]}\``
        : " — not reached";
      stationLines.push(`• ${statusEmoji()} \`${stationName}\`${reason}`);
      continue;
    }
    const summary = truncate((s.summary ?? "").replace(/\s+/g, " ").trim(), 220);
    stationLines.push(
      `• ${statusEmoji(s.status)} \`${stationName}\`${stationDetail(s)}${summary ? " — " + summary : ""}`,
    );
  }

  // Surface eval feedback on escalation, since the summary alone often
  // doesn't say why a human needs to look at the workpiece.
  let escalationNote = "";
  if (escalatedEntry) {
    const fb = truncate(
      (escalatedEntry[1].eval?.feedback ?? "").replace(/\s+/g, " ").trim(),
      300,
    );
    if (fb) escalationNote = `📝 eval: ${fb}`;
  }

  // On failure, point at the file so the user can `cat` it directly. We
  // only print the relative tail to keep the line compact.
  let pathNote = "";
  if (isFailure || escalatedEntry) {
    const tail = workpiecePath.replace(/^.*?\/assembly\//, "assembly/");
    pathNote = `🗂 ${tail}`;
  }

  const parts = [
    header,
    metaLines.join("  ·  "),
    task ? `> ${task}` : "",
    preview ?? "",
    "",
    ...stationLines,
    escalationNote,
    pathNote,
  ].filter((p) => p !== "");

  return truncate(parts.join("\n"), MAX_MESSAGE_LEN);
}

/**
 * Read the line.yaml `sequence` and flatten it to a list of station names in
 * the order they'd execute. Handles all step forms supported by
 * `collectStationNames` in src/line.ts: bare strings, `{ station: { name } }`,
 * `{ parallel: [...] }`, `{ gate: { if_true, if_false } }`, and
 * `{ loop: { stations: [...] } }`.
 */
async function loadSequence(linePath: string): Promise<string[]> {
  try {
    const yamlPath = `${linePath}/line.yaml`;
    const content = await Bun.file(yamlPath).text();
    const parsed = YAML.parse(content) as { sequence?: SequenceStep[] } | null;
    const sequence = parsed?.sequence;
    if (!Array.isArray(sequence)) return [];
    const names: string[] = [];
    for (const step of sequence) {
      if (typeof step === "string") {
        names.push(step);
      } else if (step && typeof step === "object") {
        if ("station" in step && step.station?.name) {
          names.push(step.station.name);
        } else if ("parallel" in step && Array.isArray(step.parallel)) {
          names.push(...step.parallel);
        } else if ("gate" in step && step.gate) {
          if (step.gate.if_true) names.push(step.gate.if_true);
          if (step.gate.if_false) names.push(step.gate.if_false);
        } else if ("loop" in step && Array.isArray(step.loop?.stations)) {
          names.push(...step.loop.stations);
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}

async function sendToDiscord(message: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "openclaw",
      "message",
      "send",
      "--channel", "discord",
      "--target", CHANNEL_TARGET,
      "--message", message,
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`openclaw send failed (exit ${exit}): ${stderr.slice(0, 300) || stdout.slice(0, 300)}`);
  }
}

async function main() {
  const workpiecePath = process.argv[2];
  if (!workpiecePath) throw new Error("Usage: notify-discord.ts <workpiece-path>");

  const wp: Workpiece = JSON.parse(await Bun.file(workpiecePath).text());

  // linePath = two levels up from the workpiece file (queues/<bucket>/file.json)
  const linePath = workpiecePath.replace(/\/queues\/[^/]+\/[^/]+$/, "");
  const sequence = await loadSequence(linePath);
  const stationOrder = sequence.length
    ? sequence
    : Object.keys(wp.stations ?? {});

  const message = buildMessage(wp, stationOrder, workpiecePath);
  await sendToDiscord(message);
  console.log("discord_notified");
}

// Allow other modules (e.g. tests) to import the builders without running main.
if (import.meta.main) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

export { buildMessage, loadSequence, inputPreview };
