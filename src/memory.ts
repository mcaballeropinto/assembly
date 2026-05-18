import { resolve } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import matter from "gray-matter";
import type { StationConfig, EvalResult } from "./types";

const MEMORY_WARN_CHARS = 8000; // ~2000 tokens

/**
 * Load memory from a station's memory/ directory.
 * Reads MEMORY.md, strips frontmatter, returns body text.
 */
export async function loadMemory(
  memoryDir: string
): Promise<string | undefined> {
  const memoryPath = resolve(memoryDir, "MEMORY.md");

  if (!existsSync(memoryPath)) return undefined;

  const raw = readFileSync(memoryPath, "utf-8");
  const { content } = matter(raw);
  const trimmed = content.trim();

  if (!trimmed) return undefined;

  if (trimmed.length > MEMORY_WARN_CHARS) {
    console.warn(
      `  ⚠ Station memory is ${trimmed.length} chars (~${Math.round(trimmed.length / 4)} tokens). Consider pruning.`
    );
  }

  return trimmed;
}

/**
 * Write eval feedback to a station's memory.
 * Appends to eval-feedback.md and updates MEMORY.md index on failures.
 */
export async function writeEvalToMemory(
  station: StationConfig,
  evalResult: EvalResult
): Promise<void> {
  if (!station.memoryDir || !evalResult.feedback) return;

  // Ensure memory directory exists
  mkdirSync(station.memoryDir, { recursive: true });

  const evalPath = resolve(station.memoryDir, "eval-feedback.md");
  const timestamp = new Date().toISOString();
  const status = evalResult.pass ? "PASS" : "FAIL";
  const scoreStr =
    evalResult.score !== undefined ? ` (score: ${evalResult.score})` : "";

  const entry = `\n## ${timestamp} — ${status}${scoreStr}\n${evalResult.feedback}\n`;

  // Append to eval-feedback.md
  appendFileSync(evalPath, entry);

  // Update MEMORY.md index with improvement note on failures
  if (!evalResult.pass) {
    updateMemoryIndex(
      station.memoryDir,
      "eval-improvement",
      `[eval ${timestamp.slice(0, 10)}] ${evalResult.feedback.slice(0, 120)}`
    );
  }
}

/**
 * Write an operational note to a station's memory.
 * Used by the orchestrator for runtime observations.
 */
export function writeOperationalNote(
  stationDir: string,
  note: string
): void {
  const memoryDir = resolve(stationDir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  updateMemoryIndex(memoryDir, "operational", note);
}

/**
 * Update the MEMORY.md index file with a new entry under a category.
 */
export function updateMemoryIndex(
  memoryDir: string,
  category: string,
  entry: string
): void {
  const indexPath = resolve(memoryDir, "MEMORY.md");
  const timestamp = new Date().toISOString();

  let content: string;
  if (existsSync(indexPath)) {
    content = readFileSync(indexPath, "utf-8");
  } else {
    content = `---\nupdated: ${timestamp}\n---\n\n# Station Memory\n`;
  }

  // Update frontmatter timestamp
  content = content.replace(
    /^(---\n[\s\S]*?updated:\s*).+/m,
    `$1${timestamp}`
  );

  // Find or create the section for this category
  const sectionHeader = categoryToHeader(category);
  if (content.includes(sectionHeader)) {
    // Append under existing section
    const sectionIdx = content.indexOf(sectionHeader);
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSectionIdx = content.indexOf("\n## ", afterHeader);
    const insertAt = nextSectionIdx === -1 ? content.length : nextSectionIdx;
    content =
      content.slice(0, insertAt) + `- ${entry}\n` + content.slice(insertAt);
  } else {
    // Create new section at end
    content += `\n${sectionHeader}\n- ${entry}\n`;
  }

  writeFileSync(indexPath, content);
}

function categoryToHeader(category: string): string {
  const map: Record<string, string> = {
    "eval-improvement": "## Eval Improvements",
    operational: "## Operational Notes",
    learned: "## Learned Patterns",
  };
  return map[category] ?? `## ${category}`;
}
