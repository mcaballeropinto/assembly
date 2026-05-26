import type { Workpiece, StationConfig, StationEnvelope, EvalConfig, LLMMessage } from "./types";
import type { StationName } from "./ids";

const ENVELOPE_INSTRUCTION = `
IMPORTANT: You MUST respond with valid JSON and nothing else. No markdown fences, no explanation outside the JSON.
The JSON must have this shape:
{
  "summary": "one-line description of what you produced (REQUIRED)",
  "content": "your full text output (optional, use for long-form text)",
  "data": { "any structured fields you want to include (optional)" }
}`;

const EVAL_INSTRUCTION = `
IMPORTANT: You MUST respond with valid JSON and nothing else. No markdown fences, no explanation outside the JSON.
The JSON must have this shape:
{
  "pass": true or false (REQUIRED),
  "feedback": "explanation of your evaluation (REQUIRED)",
  "score": 0-100 (optional numeric quality score),
  "action": "retry" or "escalate" (optional — when pass is false, tells the runner what to do next. "retry" means the agent can fix this with your feedback. "escalate" means this needs human review. If omitted, defaults to the station's on_fail setting.)
}`;

/**
 * Build the system message for a station (AGENT.md body + memory + envelope instruction).
 * Shared by buildPrompt and buildEvalRetryPrompt to ensure byte-identical system prompts.
 */
function buildSystemMessage(station: StationConfig): LLMMessage {
  const systemParts: string[] = [station.prompt];

  if (station.memory) {
    systemParts.push(buildMemorySection(station));
  }

  systemParts.push(ENVELOPE_INSTRUCTION);

  return {
    role: "system",
    content: systemParts.join("\n\n"),
  };
}

/**
 * Build the system + user messages for a station's LLM call.
 */
export function buildPrompt(
  station: StationConfig,
  workpiece: Workpiece,
  contextMode: "full" | "summary" | "explicit" = "full"
): LLMMessage[] {
  const system = buildSystemMessage(station);

  // User message = task + input + previous stations
  const userParts: string[] = [];

  // Task (always included)
  userParts.push(`# Task\n${workpiece.task}`);

  // Input (always included if non-empty)
  if (Object.keys(workpiece.input).length > 0) {
    userParts.push(`# Input\n${JSON.stringify(workpiece.input, null, 2)}`);
  }

  // Previous stations
  const previousContext = buildPreviousContext(
    station,
    workpiece,
    contextMode
  );
  if (previousContext) {
    userParts.push(`# Previous Stations\n${previousContext}`);
  }

  userParts.push("---\nProduce your output now.");

  const user: LLMMessage = {
    role: "user",
    content: userParts.join("\n\n"),
  };

  return [system, user];
}

/**
 * Build the "Previous Stations" section based on context mode.
 */
function buildPreviousContext(
  station: StationConfig,
  workpiece: Workpiece,
  contextMode: "full" | "summary" | "explicit"
): string | null {
  const stationEntries = Object.entries(workpiece.stations).filter(
    ([_, result]) => result.status === "done"
  );

  if (stationEntries.length === 0) return null;

  // Explicit reads mode — only include what the station declares
  if (contextMode === "explicit" && station.reads) {
    return buildExplicitContext(station.reads, workpiece);
  }

  // Summary mode — only summaries
  if (contextMode === "summary") {
    return stationEntries
      .map(([name, result]) => `- **${name}**: ${result.summary}`)
      .join("\n");
  }

  // Full mode — summaries + content + data
  return stationEntries
    .map(([name, result]) => {
      const parts: string[] = [];
      parts.push(`## ${name}`);
      parts.push(`**Summary:** ${result.summary}`);

      if (result.content) {
        parts.push(`\n**Content:**\n${result.content}`);
      }

      if (result.data && Object.keys(result.data).length > 0) {
        parts.push(`\n**Data:**\n${JSON.stringify(result.data, null, 2)}`);
      }

      return parts.join("\n");
    })
    .join("\n\n");
}

/**
 * Build context from explicit `reads` declarations.
 * Supports: "task", "input", "station_name", "station_name.content", "station_name.data", "station_name.summary"
 */
function buildExplicitContext(
  reads: string[],
  workpiece: Workpiece
): string {
  const parts: string[] = [];

  for (const read of reads) {
    // Skip task and input — they're always included separately
    if (read === "task" || read === "input") continue;

    // Check for dotted path: "research.content", "research.data"
    const dotIndex = read.indexOf(".");
    if (dotIndex > 0) {
      const stationName = read.substring(0, dotIndex);
      const field = read.substring(dotIndex + 1) as
        | "summary"
        | "content"
        | "data";
      const result = workpiece.stations[stationName as any];

      if (result) {
        const value = result[field];
        if (value !== undefined) {
          const formatted =
            typeof value === "string" ? value : JSON.stringify(value, null, 2);
          parts.push(`## ${stationName}.${field}\n${formatted}`);
        }
      }
    } else {
      // Full station reference
      const result = workpiece.stations[read as any];
      if (result) {
        const stationParts: string[] = [`## ${read}`];
        stationParts.push(`**Summary:** ${result.summary}`);
        if (result.content) stationParts.push(`\n${result.content}`);
        if (result.data)
          stationParts.push(
            `\n**Data:**\n${JSON.stringify(result.data, null, 2)}`
          );
        parts.push(stationParts.join("\n"));
      }
    }
  }

  return parts.join("\n\n") || null!;
}

/**
 * Build the system + user messages for an eval LLM call.
 * The eval sees the station's task, the station's output, and the eval criteria.
 */
export function buildEvalPrompt(
  evalConfig: EvalConfig,
  stationName: StationName,
  envelope: StationEnvelope,
  workpiece: Workpiece
): LLMMessage[] {
  const system: LLMMessage = {
    role: "system",
    content: `${evalConfig.prompt}\n\n${EVAL_INSTRUCTION}`,
  };

  const outputParts: string[] = [];
  outputParts.push(`# Task\n${workpiece.task}`);
  outputParts.push(`# Station: ${stationName}`);
  outputParts.push(`## Summary\n${envelope.summary}`);

  if (envelope.content) {
    outputParts.push(`## Content\n${envelope.content}`);
  }

  if (envelope.data && Object.keys(envelope.data).length > 0) {
    outputParts.push(`## Data\n${JSON.stringify(envelope.data, null, 2)}`);
  }

  outputParts.push("---\nEvaluate this output now.");

  const user: LLMMessage = {
    role: "user",
    content: outputParts.join("\n\n"),
  };

  return [system, user];
}

/**
 * Build a retry prompt that includes eval feedback for the station to improve its output.
 */
export function buildRetryWithFeedback(
  station: StationConfig,
  workpiece: Workpiece,
  contextMode: "full" | "summary" | "explicit",
  evalFeedback: string
): LLMMessage[] {
  const messages = buildPrompt(station, workpiece, contextMode);

  // Append eval feedback to the user message
  messages[1] = {
    role: "user",
    content: `${messages[1].content}\n\n# Evaluation Feedback from Previous Attempt\nYour previous output was evaluated and did NOT pass. Here is the feedback:\n\n${evalFeedback}\n\nPlease produce an improved output that addresses this feedback.`,
  };

  return messages;
}

/**
 * Build a slim retry prompt for eval failures.
 * Instead of re-sending the full workpiece context (prior stations, etc.),
 * this sends only: system prompt + task/input + previous output recap + eval feedback.
 * This typically reduces retry input tokens by >90%.
 */
export function buildEvalRetryPrompt(
  station: StationConfig,
  workpiece: Workpiece,
  previousResponse: string,
  evalFeedback: string
): LLMMessage[] {
  const system = buildSystemMessage(station);

  // Recap: task + input + truncated previous output (no prior-station content)
  const recapParts: string[] = [];
  recapParts.push(`# Task\n${workpiece.task}`);

  if (Object.keys(workpiece.input).length > 0) {
    recapParts.push(`# Input\n${JSON.stringify(workpiece.input, null, 2)}`);
  }

  // Include previous output — truncate if large
  const MAX_PREV_RESPONSE = 4096;
  let previousSummary: string;
  if (previousResponse.length <= MAX_PREV_RESPONSE) {
    previousSummary = previousResponse;
  } else {
    // Try to extract envelope fields for a compact summary
    try {
      const parsed = JSON.parse(previousResponse);
      const compact: Record<string, unknown> = {};
      if (parsed.summary) compact.summary = parsed.summary;
      if (parsed.data) compact.data = parsed.data;
      if (parsed.content) compact.content = parsed.content.substring(0, 500) + "... [truncated]";
      previousSummary = JSON.stringify(compact, null, 2);
    } catch {
      previousSummary = previousResponse.substring(0, MAX_PREV_RESPONSE) + "... [truncated]";
    }
  }
  recapParts.push(`# Your Previous Output\n${previousSummary}`);

  const recap: LLMMessage = { role: "user", content: recapParts.join("\n\n") };

  // Feedback message
  const feedback: LLMMessage = {
    role: "user",
    content: `# Evaluation Feedback\nYour previous output was evaluated and did NOT pass. Here is the feedback:\n\n${evalFeedback}\n\nPlease produce a corrected output that addresses this feedback.\n\n---\nProduce your output now.`,
  };

  return [system, recap, feedback];
}

/**
 * Build the memory section for injection into the system prompt.
 * Includes the loaded MEMORY.md content and, for claude-code stations,
 * instructions for writing to the memory directory.
 */
function buildMemorySection(station: StationConfig): string {
  const parts: string[] = [
    "# Station Memory",
    "The following is your persistent memory from previous runs:",
    "",
    station.memory!,
  ];

  // Only claude-code stations can write memory (they have file tools)
  if (station.provider === "claude-code" && station.memoryDir) {
    parts.push("");
    parts.push("## Memory Directory");
    parts.push(
      `Your persistent memory directory is: ${station.memoryDir}/`
    );
    parts.push(
      "You can read and write files here to remember things across runs."
    );
    parts.push(
      "- MEMORY.md is the index (auto-injected into your prompt each run)"
    );
    parts.push("- Create additional .md files for detailed data");
    parts.push(
      "- Keep MEMORY.md concise (<2000 tokens) — it loads into every future prompt"
    );
  }

  return parts.join("\n");
}
