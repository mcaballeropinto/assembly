import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import YAML from "yaml";

/**
 * Assembly directory paths.
 *
 * Global:  ~/.assembly/           (lines, stations, config, runs)
 * Local:   .assembly/             (project-specific lines/stations)
 * Explicit: full path to a line   (direct reference)
 */

/**
 * Root directory for runtime state (PID files, handoff state, usage snapshots,
 * `~/.assembly/lines/`, etc).
 *
 * Honors `ASSEMBLY_HOME` env var so tests can point at a tmp directory without
 * polluting the real `~/.assembly/` — the previous test pattern (mutate
 * `$HOME` + `delete require.cache[...]`) silently no-oped under Bun's module
 * loader and was writing fictional handoff state into production paths.
 *
 * Captured once at module load. Mid-process changes to `process.env.ASSEMBLY_HOME`
 * are NOT picked up — point at a fresh dir before the first import.
 */
export const ASSEMBLY_HOME = resolve(
  process.env.ASSEMBLY_HOME ?? resolve(homedir(), ".assembly")
);
export const GLOBAL_LINES_DIR = resolve(ASSEMBLY_HOME, "lines");
export const GLOBAL_STATIONS_DIR = resolve(ASSEMBLY_HOME, "stations");
export const GLOBAL_RUNS_DIR = resolve(ASSEMBLY_HOME, "runs");
export const GLOBAL_CONFIG = resolve(ASSEMBLY_HOME, "config.yaml");
export const GLOBAL_ENV = resolve(ASSEMBLY_HOME, ".env");
export const ORCHESTRATOR_PID_FILE = resolve(ASSEMBLY_HOME, "orchestrator.pid");
export const DASHBOARD_PID_FILE = resolve(ASSEMBLY_HOME, "dashboard.pid");
export const USAGE_SNAPSHOT_FILE = resolve(ASSEMBLY_HOME, "usage-status.json");
/**
 * `daemon reload` flow uses a ready file written by the successor daemon to
 * signal that it has fully adopted state from the predecessor's handoff
 * file. Suffixed with the successor's pid so a stuck file from a previous
 * failed reload doesn't fool the next attempt's wait loop.
 */
export const READY_FILE_PREFIX = "orchestrator-ready-";
export function orchestratorReadyFileFor(pid: number): string {
  return resolve(ASSEMBLY_HOME, `${READY_FILE_PREFIX}${pid}`);
}

/**
 * Directories searched for lines by name. Shared by `resolveLinePath`,
 * `discoverLines`, and `assembly list` so they always agree.
 *
 * Order:
 *   1. `.assembly/lines/`             — project-local (cwd)
 *   2. `~/.assembly/lines/`           — global
 *   3. `$ASSEMBLY_LINE_DIRS`          — colon-separated, like PATH
 *   4. `line_dirs:` in config.yaml    — array of paths
 *
 * Earlier entries win for name resolution. `withLabels: true` returns
 * `[label, dir]` pairs for grouped UI output.
 */
export function lineSearchDirs(): string[] {
  return lineSearchDirsWithLabels().map(([, dir]) => dir);
}

export function lineSearchDirsWithLabels(): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["Project (.assembly/lines/)", resolve(".assembly", "lines")],
    ["Global (~/.assembly/lines/)", GLOBAL_LINES_DIR],
  ];

  const envDirs = process.env.ASSEMBLY_LINE_DIRS;
  if (envDirs) {
    for (const dir of envDirs.split(":")) {
      const trimmed = dir.trim();
      if (trimmed) entries.push([`Env ASSEMBLY_LINE_DIRS (${trimmed})`, resolve(trimmed)]);
    }
  }

  if (existsSync(GLOBAL_CONFIG)) {
    try {
      const raw = readFileSync(GLOBAL_CONFIG, "utf-8");
      const config = YAML.parse(raw);
      if (config?.line_dirs && Array.isArray(config.line_dirs)) {
        for (const dir of config.line_dirs) {
          if (typeof dir === "string") {
            entries.push([`Config line_dirs (${dir})`, resolve(dir)]);
          }
        }
      }
    } catch {
      // Ignore malformed config.yaml
    }
  }

  // Deduplicate by resolved path while preserving order.
  const seen = new Set<string>();
  return entries.filter(([, dir]) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

/**
 * Resolve a line path. Tries an exact path first, then each search
 * directory from `lineSearchDirs()` in order.
 */
export function resolveLinePath(nameOrPath: string): string {
  if (existsSync(resolve(nameOrPath, "line.yaml"))) {
    return resolve(nameOrPath);
  }

  for (const dir of lineSearchDirs()) {
    const candidate = resolve(dir, nameOrPath);
    if (existsSync(resolve(candidate, "line.yaml"))) {
      return candidate;
    }
  }

  // Not found — return as-is and let loadLine fail with a good error
  return resolve(nameOrPath);
}

/**
 * Get the runs directory. Uses ~/.assembly/runs/ by default.
 */
export function getRunsDir(): string {
  return GLOBAL_RUNS_DIR;
}

/**
 * Load environment variables from .env files.
 * First-file-wins for each key; shell env always wins over every file.
 * Load order:
 * 1. ~/.secrets.env     — system-level secrets (shared across tools)
 * 2. ~/.assembly/.env   — assembly-global config
 * 3. .env (cwd)
 * 4. .assembly/.env (cwd)
 */
export function loadEnvFiles(): void {
  const envFiles = [
    resolve(homedir(), ".secrets.env"),
    GLOBAL_ENV,
    resolve(".env"),
    resolve(".assembly", ".env"),
  ];

  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      try {
        const content = require("fs").readFileSync(envFile, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx === -1) continue;
          const key = trimmed.substring(0, eqIdx).trim();
          const value = trimmed
            .substring(eqIdx + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
          // Don't override existing env vars
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }
}
