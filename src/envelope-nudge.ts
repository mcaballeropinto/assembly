import { readFileSync } from "fs";
import { callAnthropicRepair } from "./llm";
import type { LLMMessage, LLMResult, StationConfig } from "./types";

/**
 * Reconstruct a user/assistant message history from a `.session.jsonl` file.
 *
 * Keeps only text-bearing turns (user + assistant text blocks). Drops
 * tool_use, tool_result, thinking, and assembly_meta entries. The result
 * is suitable for replaying to the Anthropic Messages API.
 */
export function reconstructMessages(sessionLogPath: string): LLMMessage[] {
  const raw = readFileSync(sessionLogPath, "utf-8");
  const messages: LLMMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip assembly meta entries and non-message events
    if (entry.type === "assembly_meta") continue;
    if (entry.type === "result") continue;

    // User turns from the stream-json input
    if (entry.type === "user" && entry.message?.role === "user") {
      const content =
        typeof entry.message.content === "string"
          ? entry.message.content
          : "";
      if (content) {
        // Also capture the system prompt from the first user envelope
        if (messages.length === 0 && entry.system) {
          messages.push({ role: "system", content: entry.system });
        }
        messages.push({ role: "user", content });
      }
      continue;
    }

    // Assistant turns — extract only text blocks, skip tool_use/thinking
    if (entry.type === "assistant" && entry.message?.content) {
      const textParts: string[] = [];
      for (const block of entry.message.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        messages.push({ role: "assistant", content: textParts.join("\n\n") });
      }
      continue;
    }
  }

  return messages;
}

/**
 * Build a guardrail-aware nudge prompt from the station's output schema.
 *
 * Enumerates required fields from `station.guardrails.output.required` and
 * data sub-field types from `station.guardrails.output.schema.data` so the
 * model knows exactly what to produce.
 */
export function buildNudgePrompt(
  station: StationConfig,
  errorMessage: string
): string {
  const required = station.guardrails?.output?.required ?? [];
  const dataSchema = (station.guardrails?.output?.schema?.data ?? {}) as Record<string, unknown>;

  // Build the data fields block
  const dataFields = Object.entries(dataSchema)
    .map(([key, spec]) => {
      const typeStr = typeof spec === "string" ? spec : (spec as any)?.type ?? "unknown";
      return `    "${key}": <${typeStr}>`;
    })
    .join(",\n");

  const dataBlock = dataFields
    ? `  "data": {\n${dataFields}\n  }`
    : `  "data": {}`;

  // List required fields explicitly
  const requiredDataFields = required
    .filter((f) => f.startsWith("data."))
    .map((f) => f.replace("data.", ""));

  const requiredLine =
    requiredDataFields.length > 0
      ? `\nRequired data fields: ${requiredDataFields.join(", ")}.`
      : "";

  return `Your previous response did not parse as a valid envelope. Error: ${errorMessage}

Respond now with ONLY valid JSON — no prose, no fences, no tools — in the shape:

{
  "summary": "<one-line>",
  "content": "<full markdown content>",
${dataBlock}
}
${requiredLine}
The JSON must be your entire response. Nothing before, nothing after.`;
}

export interface NudgeOptions {
  sessionLogPath: string;
  station: StationConfig;
  errorMessage: string;
  model: string;
  /** Injected Anthropic client for testing */
  client?: Pick<import("@anthropic-ai/sdk").default, "messages">;
}

/**
 * In-session nudge: replay the session's message history with one extra
 * "respond now with only JSON" user turn, using the station's own model.
 *
 * Returns null if reconstruction fails or the call fails — caller falls
 * through to Stage 2 (Haiku repair) unchanged.
 */
export async function nudgeForEnvelope(
  opts: NudgeOptions
): Promise<LLMResult | null> {
  const { sessionLogPath, station, errorMessage, model, client } = opts;

  let history: LLMMessage[];
  try {
    history = reconstructMessages(sessionLogPath);
  } catch {
    return null;
  }

  // Need at least system + user + assistant to nudge
  if (history.length < 3) return null;

  const nudgePrompt = buildNudgePrompt(station, errorMessage);
  const messages: LLMMessage[] = [...history, { role: "user", content: nudgePrompt }];

  return callAnthropicRepair(messages, {
    model,
    maxTokens: 8192,
    ...(client ? { client } : {}),
  });
}
