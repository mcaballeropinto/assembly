import { existsSync, readFileSync } from "fs";
import type { StationRounds } from "./types";

export type { StationRounds } from "./types";

/**
 * Read a `.progress.jsonl` sidecar and roll it up into a compact
 * `{ turns, tools: { name: count } }` summary.
 *
 * Returns null when the file is missing, empty, has no tool_use events,
 * or only records non-tool phases (prompt/build). `turns` is the max
 * value seen in tool events (the field increments monotonically per
 * assistant message in llm.ts).
 *
 * Malformed JSON lines are skipped silently — the sidecar may be truncated
 * if the worker is killed mid-write.
 */
export function computeRoundsFromProgress(progressPath: string): StationRounds | null {
  if (!existsSync(progressPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(progressPath, "utf-8");
  } catch {
    return null;
  }

  const tools: Record<string, number> = {};
  let turns = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: { tool?: unknown; turns?: unknown };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof evt.tool === "string" && evt.tool.length > 0) {
      tools[evt.tool] = (tools[evt.tool] ?? 0) + 1;
    }
    if (typeof evt.turns === "number" && evt.turns > turns) {
      turns = evt.turns;
    }
  }

  if (turns === 0 && Object.keys(tools).length === 0) return null;
  return { turns, tools };
}
