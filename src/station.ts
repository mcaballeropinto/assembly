import { resolve } from "path";
import matter from "gray-matter";
import type { StationConfig, EvalConfig } from "./types";
import { StationName } from "./ids";
import { loadMemory } from "./memory";
import { EvalFrontmatterSchema, StationFrontmatterSchema } from "./schemas/station-frontmatter";

/**
 * Load a station from its folder path.
 * Reads AGENT.md, parses frontmatter + body.
 * Optionally loads EVAL.md and memory/MEMORY.md.
 */
export async function loadStation(
  stationDir: string,
  name: StationName
): Promise<StationConfig> {
  const agentPath = resolve(stationDir, "AGENT.md");
  const file = Bun.file(agentPath);

  if (!(await file.exists())) {
    throw new Error(`Station "${name}" missing AGENT.md at ${agentPath}`);
  }

  const raw = await file.text();
  const { data: frontmatter, content: prompt } = matter(raw);
  const parsedFrontmatter = StationFrontmatterSchema.safeParse(frontmatter);
  if (!parsedFrontmatter.success) {
    throw new Error(`AGENT.md frontmatter schema violation at ${agentPath}: ${parsedFrontmatter.error.message}`);
  }
  const data = parsedFrontmatter.data;

  // Check for optional EVAL.md
  const evalConfig = await loadEval(stationDir);

  // Load persistent memory
  const memoryDir = resolve(stationDir, "memory");
  const memoryContent = await loadMemory(memoryDir);

  return {
    name,
    dir: stationDir,
    memoryDir,
    description: data.description ?? undefined,
    reads: data.reads ?? undefined,
    provider: data.provider ?? undefined,
    model: data.model ?? undefined,
    tools: data.tools ?? undefined,
    script: data.script ?? undefined,
    cwd: data.cwd ?? undefined,
    guardrails: data.guardrails ?? undefined,
    prompt: prompt.trim(),
    eval: evalConfig,
    memory: memoryContent,
  };
}

/**
 * Load EVAL.md from a station directory if it exists.
 */
async function loadEval(
  stationDir: string
): Promise<EvalConfig | undefined> {
  const evalPath = resolve(stationDir, "EVAL.md");
  const file = Bun.file(evalPath);

  if (!(await file.exists())) return undefined;

  const raw = await file.text();
  const { data: frontmatter, content: prompt } = matter(raw);
  const parsedFrontmatter = EvalFrontmatterSchema.safeParse(frontmatter);
  if (!parsedFrontmatter.success) {
    throw new Error(`EVAL.md frontmatter schema violation at ${evalPath}: ${parsedFrontmatter.error.message}`);
  }
  const data = parsedFrontmatter.data;

  return {
    provider: data.provider ?? undefined,
    model: data.model ?? undefined,
    on_fail: data.on_fail ?? "retry",
    max_retries: data.max_retries ?? 1,
    prompt: prompt.trim(),
    script: data.script ?? undefined,
  };
}
