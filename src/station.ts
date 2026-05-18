import { resolve } from "path";
import matter from "gray-matter";
import type { StationConfig, EvalConfig } from "./types";
import { loadMemory } from "./memory";

/**
 * Load a station from its folder path.
 * Reads AGENT.md, parses frontmatter + body.
 * Optionally loads EVAL.md and memory/MEMORY.md.
 */
export async function loadStation(
  stationDir: string,
  name: string
): Promise<StationConfig> {
  const agentPath = resolve(stationDir, "AGENT.md");
  const file = Bun.file(agentPath);

  if (!(await file.exists())) {
    throw new Error(`Station "${name}" missing AGENT.md at ${agentPath}`);
  }

  const raw = await file.text();
  const { data: frontmatter, content: prompt } = matter(raw);

  // Check for optional EVAL.md
  const evalConfig = await loadEval(stationDir);

  // Load persistent memory
  const memoryDir = resolve(stationDir, "memory");
  const memoryContent = await loadMemory(memoryDir);

  return {
    name,
    dir: stationDir,
    memoryDir,
    reads: frontmatter.reads ?? undefined,
    provider: frontmatter.provider ?? undefined,
    model: frontmatter.model ?? undefined,
    tools: frontmatter.tools ?? undefined,
    script: frontmatter.script ?? undefined,
    cwd: frontmatter.cwd ?? undefined,
    guardrails: frontmatter.guardrails ?? undefined,
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

  return {
    provider: frontmatter.provider ?? undefined,
    model: frontmatter.model ?? undefined,
    on_fail: frontmatter.on_fail ?? "retry",
    max_retries: frontmatter.max_retries ?? 1,
    prompt: prompt.trim(),
    script: frontmatter.script ?? undefined,
  };
}
