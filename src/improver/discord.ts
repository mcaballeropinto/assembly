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
