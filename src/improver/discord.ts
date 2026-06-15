/**
 * Discord reporting for the improver watcher, via OpenClaw's message send
 * command — the same transport the line-level notify-discord.ts hooks use.
 * Auth flows through OpenClaw's own DISCORD_BOT_TOKEN setup; the only knob
 * here is the target channel.
 */

const DEFAULT_CHANNEL_TARGET = "channel:1496010860349620286"; // #assembly

// Discord hard-caps messages at 2000 chars; leave slack for safety.
const MAX_MESSAGE_LEN = 1900;

export function normalizeDiscordTarget(target: string): string {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) return `channel:${trimmed}`;
  return trimmed;
}

export function resolveChannelTarget(): string {
  return normalizeDiscordTarget(process.env.ASSEMBLY_DISCORD_CHANNEL_ID ?? DEFAULT_CHANNEL_TARGET);
}

export function truncateForDiscord(message: string): string {
  if (message.length <= MAX_MESSAGE_LEN) return message;
  return message.slice(0, MAX_MESSAGE_LEN - 1) + "…";
}

export interface DiagnosisReportAction {
  text: string;
  devTaskKey?: string;
  devTaskFile?: string;
  fingerprint?: string;
}

export interface DiagnosisReport {
  sourceLine: string;
  workpieceId: string | null;
  fileName: string;
  sourceFile: string;
  failedStation: string | null;
  failureClass: string | null;
  rootCauseCategory: string;
  confidenceLevel: "low" | "medium" | "high";
  confidenceScore?: number;
  evidence: string[];
  recommendedNextAction: string;
  action: DiagnosisReportAction;
}

function compactLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
}

export function buildDiagnosisReportMessage(report: DiagnosisReport): string {
  const source = report.workpieceId ?? report.fileName;
  const score =
    typeof report.confidenceScore === "number" && Number.isFinite(report.confidenceScore)
      ? report.confidenceScore.toFixed(2)
      : "n/a";
  const lines = [
    `🧭 **improver diagnosis** — ${compactLine(report.sourceLine)} / ${compactLine(source)}`,
    `source: ${compactLine(report.fileName)} (${compactLine(report.sourceFile)})`,
    `failed: ${compactLine(report.failedStation ?? "unknown")} · failure_class ${compactLine(report.failureClass ?? "unknown")}`,
    `root cause: ${compactLine(report.rootCauseCategory)} · confidence ${report.confidenceLevel}/${score}`,
  ];
  const evidence = report.evidence.map(compactLine).filter(Boolean).slice(0, 4);
  for (const item of evidence.length ? evidence : ["no compact evidence available"]) {
    lines.push(`• ${item}`);
  }
  lines.push(`next: ${compactLine(report.recommendedNextAction)}`);
  lines.push(`action: ${compactLine(report.action.text)}`);
  if (report.action.devTaskKey || report.action.devTaskFile || report.action.fingerprint) {
    lines.push(
      [
        report.action.devTaskKey || report.action.devTaskFile
          ? `dev task ${compactLine(report.action.devTaskKey ?? "unknown")} (${compactLine(report.action.devTaskFile ?? "unknown")})`
          : null,
        report.action.fingerprint ? `fingerprint ${compactLine(report.action.fingerprint)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    );
  }
  return truncateForDiscord(lines.join("\n"));
}

const SEND_TIMEOUT_MS = 15_000;

/**
 * Post a message to the improver's Discord channel. Never throws and never
 * hangs — every notify() is awaited inside the watcher's single serial drain
 * queue, so a wedged openclaw gateway must not be able to freeze the whole
 * subsystem. Output streams are ignored (not piped) so a chatty child can't
 * deadlock on a full pipe either. Returns whether the send succeeded.
 */
export async function sendDiscord(message: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        "openclaw",
        "message",
        "send",
        "--channel", "discord",
        "--target", resolveChannelTarget(),
        "--message", truncateForDiscord(message),
      ],
      { stdout: "ignore", stderr: "ignore", env: process.env }
    );
    const exit = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), SEND_TIMEOUT_MS)),
    ]);
    if (exit === "timeout") {
      try {
        proc.kill("SIGKILL");
      } catch {}
      return false;
    }
    return exit === 0;
  } catch {
    return false;
  }
}
