import { resolve } from "path";
import { existsSync } from "fs";
import YAML from "yaml";
import type { LineConfig, SequenceStationConfig, StationConfig } from "./types";
import { loadStation } from "./station";
import { LineName, StationName } from "./ids";

/**
 * Load a line from its folder path.
 * Reads line.yaml and all station AGENT.md files.
 */
export async function loadLine(linePath: string): Promise<{
  config: LineConfig;
  stations: Map<string, StationConfig>;
  linePath: string;
}> {
  const yamlPath = resolve(linePath, "line.yaml");
  const file = Bun.file(yamlPath);

  if (!(await file.exists())) {
    throw new Error(`Line missing line.yaml at ${yamlPath}`);
  }

  const raw = await file.text();
  const config = YAML.parse(raw) as LineConfig;

  if (!config.name) throw new Error("line.yaml must have a 'name' field");

  // Brand the line name at the YAML boundary
  config.name = LineName(config.name as any);
  if (!config.sequence?.length)
    throw new Error("line.yaml must have a non-empty 'sequence'");

  // Validate concurrency if present
  if (config.concurrency !== undefined) {
    if (typeof config.concurrency !== 'number' || config.concurrency < 1 || !Number.isInteger(config.concurrency)) {
      throw new Error("line.yaml 'concurrency' must be a positive integer");
    }
  }

  // Validate drip if present
  if (config.drip !== undefined) {
    if (typeof config.drip !== 'number' || config.drip < 1 || !Number.isInteger(config.drip)) {
      throw new Error("line.yaml 'drip' must be a positive integer");
    }
  }

  // Validate timeout if present
  if (config.timeout !== undefined) {
    if (typeof config.timeout !== 'number' || config.timeout < 0 || !Number.isInteger(config.timeout)) {
      throw new Error("line.yaml 'timeout' must be a non-negative integer (seconds)");
    }
  }

  // Validate max_wall_clock if present
  if (config.max_wall_clock !== undefined) {
    if (typeof config.max_wall_clock !== 'number' || config.max_wall_clock < 0 || !Number.isInteger(config.max_wall_clock)) {
      throw new Error("line.yaml 'max_wall_clock' must be a non-negative integer (seconds)");
    }
  }

  // Validate flush_grace if present
  if (config.flush_grace !== undefined) {
    if (typeof config.flush_grace !== 'number' || config.flush_grace < 0 || !Number.isInteger(config.flush_grace)) {
      throw new Error("line.yaml 'flush_grace' must be a non-negative integer (seconds)");
    }
  }

  // Validate per-station overrides in sequence
  const lineStationDescriptions = new Map<string, string>();
  for (const step of config.sequence) {
    if (typeof step === 'object' && 'station' in step) {
      const s = (step as { station: SequenceStationConfig & { heartbeat?: any; claude_env?: any; description?: unknown } }).station;
      if (!s.name || typeof s.name !== 'string') {
        throw new Error("sequence station object must have a 'name' string");
      }
      if (s.description !== undefined) {
        if (typeof s.description !== 'string') {
          throw new Error(`sequence station '${s.name}': description must be a string`);
        }
        const trimmed = s.description.trim();
        if (trimmed) lineStationDescriptions.set(s.name, trimmed);
      }
      if (s.timeout !== undefined) {
        if (typeof s.timeout !== 'number' || s.timeout < 0 || !Number.isInteger(s.timeout)) {
          throw new Error(`sequence station '${s.name}': timeout must be a non-negative integer (seconds)`);
        }
      }
      if (s.max_wall_clock !== undefined) {
        if (typeof s.max_wall_clock !== 'number' || s.max_wall_clock < 0 || !Number.isInteger(s.max_wall_clock)) {
          throw new Error(`sequence station '${s.name}': max_wall_clock must be a non-negative integer (seconds)`);
        }
      }
      if (s.flush_grace !== undefined) {
        if (typeof s.flush_grace !== 'number' || s.flush_grace < 0 || !Number.isInteger(s.flush_grace)) {
          throw new Error(`sequence station '${s.name}': flush_grace must be a non-negative integer (seconds)`);
        }
      }
      if (s.claude_env) {
        if (typeof s.claude_env !== 'object' || Array.isArray(s.claude_env)) {
          throw new Error(`sequence station '${s.name}': claude_env must be a key-value object`);
        }
        for (const [k, v] of Object.entries(s.claude_env)) {
          if (typeof v !== 'string') {
            throw new Error(`sequence station '${s.name}': claude_env.${k} must be a string`);
          }
        }
      }
      if (s.heartbeat) {
        if (s.heartbeat.interval_ms !== undefined) {
          if (typeof s.heartbeat.interval_ms !== 'number' || s.heartbeat.interval_ms < 0 || !Number.isInteger(s.heartbeat.interval_ms)) {
            throw new Error(`sequence station '${s.name}': heartbeat.interval_ms must be a non-negative integer`);
          }
        }
        if (s.heartbeat.emit_when_silent !== undefined) {
          if (typeof s.heartbeat.emit_when_silent !== 'boolean') {
            throw new Error(`sequence station '${s.name}': heartbeat.emit_when_silent must be a boolean`);
          }
        }
      }
    }
  }

  // Validate line-level heartbeat config
  if ((config as any).heartbeat) {
    const hb = (config as any).heartbeat;
    if (hb.interval_ms !== undefined) {
      if (typeof hb.interval_ms !== 'number' || hb.interval_ms < 0 || !Number.isInteger(hb.interval_ms)) {
        throw new Error("line.yaml heartbeat.interval_ms must be a non-negative integer");
      }
    }
    if (hb.emit_when_silent !== undefined) {
      if (typeof hb.emit_when_silent !== 'boolean') {
        throw new Error("line.yaml heartbeat.emit_when_silent must be a boolean");
      }
    }
  }

  // Validate defaults.claude_env
  if (config.defaults?.claude_env) {
    if (typeof config.defaults.claude_env !== 'object' || Array.isArray(config.defaults.claude_env)) {
      throw new Error("line.yaml defaults.claude_env must be a key-value object");
    }
    for (const [k, v] of Object.entries(config.defaults.claude_env)) {
      if (typeof v !== 'string') {
        throw new Error(`line.yaml defaults.claude_env.${k} must be a string`);
      }
    }
  }

  // Validate on_success if present
  if (config.on_success !== undefined) {
    if (typeof config.on_success !== 'object' || Array.isArray(config.on_success)) {
      throw new Error("line.yaml 'on_success' must be an object");
    }
    if (!config.on_success.script || typeof config.on_success.script !== 'string') {
      throw new Error("line.yaml 'on_success.script' must be a non-empty string");
    }
  }

  // Validate on_complete structure if present
  if (config.on_complete) {
    if (!Array.isArray(config.on_complete)) {
      throw new Error("line.yaml on_complete must be an array");
    }
    for (const trigger of config.on_complete) {
      const hasTarget = typeof trigger.target === "string" && trigger.target.length > 0;
      const hasTargetPath = typeof trigger.target_path === "string" && trigger.target_path.length > 0;
      if (!hasTarget && !hasTargetPath) {
        throw new Error("Each on_complete entry must have a 'target' or 'target_path' string");
      }
      if (trigger.target !== undefined && typeof trigger.target !== "string") {
        throw new Error("on_complete: 'target' must be a string when set");
      }
      if (trigger.target_path !== undefined && typeof trigger.target_path !== "string") {
        throw new Error("on_complete: 'target_path' must be a dot-notation string path when set");
      }
      // Tag for nicer error messages downstream — prefer the static target,
      // fall back to the dynamic path.
      const tag = trigger.target ?? `target_path:${trigger.target_path}`;
      if (trigger.pass && typeof trigger.pass !== "object") {
        throw new Error(`on_complete target '${tag}': 'pass' must be an object`);
      }
      if (trigger.pass) {
        for (const [key, path] of Object.entries(trigger.pass)) {
          if (typeof path !== "string") {
            throw new Error(`on_complete target '${tag}': pass.${key} must be a dot-notation string path`);
          }
        }
      }
      if (trigger.condition !== undefined && typeof trigger.condition !== "string") {
        throw new Error(`on_complete target '${tag}': 'condition' must be a string`);
      }
      if (trigger.fanout !== undefined) {
        if (typeof trigger.fanout !== "object" || trigger.fanout === null) {
          throw new Error(`on_complete target '${tag}': 'fanout' must be an object`);
        }
        if (typeof trigger.fanout.over !== "string" || !trigger.fanout.over) {
          throw new Error(`on_complete target '${tag}': fanout.over must be a non-empty dot-notation string path`);
        }
        if (typeof trigger.fanout.as !== "string" || !trigger.fanout.as) {
          throw new Error(`on_complete target '${tag}': fanout.as must be a non-empty input key`);
        }
      }
    }
  }

  // Collect all station names from the sequence (including nested ones)
  const stationNames = collectStationNames(config.sequence);

  // Load each station
  const stations = new Map<string, StationConfig>();
  for (const name of stationNames) {
    const stationDir = resolve(linePath, "stations", name);
    const brandedName = StationName(name);
    const station = await loadStation(stationDir, brandedName);
    const lineDescription = lineStationDescriptions.get(name);
    if (lineDescription) station.description = lineDescription;
    stations.set(name, station);
  }

  return { config, stations, linePath };
}

/**
 * Extract all station names from a sequence (handles parallel, gate, loop).
 */
function collectStationNames(sequence: LineConfig["sequence"]): string[] {
  const names: string[] = [];

  for (const step of sequence) {
    if (typeof step === "string") {
      names.push(step);
    } else if ("parallel" in step) {
      names.push(...step.parallel);
    } else if ("gate" in step) {
      names.push(step.gate.if_true, step.gate.if_false);
    } else if ("loop" in step) {
      names.push(...step.loop.stations);
    } else if ("station" in step) {
      names.push((step as { station: SequenceStationConfig }).station.name);
    }
  }

  return [...new Set(names)]; // deduplicate
}

/**
 * Validate a line — check all stations exist, schemas are valid, etc.
 */
export async function validateLine(linePath: string): Promise<string[]> {
  const errors: string[] = [];

  try {
    const { config, stations } = await loadLine(linePath);

    // Check all referenced stations exist
    const stationNames = collectStationNames(config.sequence);
    for (const name of stationNames) {
      if (!stations.has(name)) {
        errors.push(`Station "${name}" referenced in sequence but not found`);
      }
    }

    // Check each station has at minimum a prompt (except script stations)
    for (const [name, station] of stations) {
      if (!station.prompt && station.provider !== "script") {
        errors.push(`Station "${name}" has an empty AGENT.md body`);
      }
      if (station.provider === "script" && !station.script) {
        errors.push(
          `Station "${name}" uses script provider but has no "script" field in frontmatter`
        );
      }
      if (station.provider === "script" && station.script) {
        const scriptFilePath = resolve(linePath, "stations", name, station.script);
        if (!existsSync(scriptFilePath)) {
          errors.push(
            `Station "${name}" script file not found: ${scriptFilePath}`
          );
        }
      }
    }

    // Validate on_complete targets
    if (config.on_complete) {
      const linesDir = resolve(linePath, "..");

      const seen = new Set<string>();
      seen.add(config.name);

      for (const trigger of config.on_complete) {
        // Skip directory-existence checks for dynamic targets — the line
        // name is only known at fire time, not load time.
        if (!trigger.target) continue;

        // Check target line directory exists
        const targetDir = resolve(linesDir, trigger.target);
        const targetYaml = resolve(targetDir, "line.yaml");
        if (!existsSync(targetDir)) {
          errors.push(`on_complete target '${trigger.target}': directory not found at ${targetDir}`);
        } else if (!existsSync(targetYaml)) {
          errors.push(`on_complete target '${trigger.target}': missing line.yaml at ${targetDir}`);
        }

        // Warn on self-referencing triggers
        if (trigger.target === config.name) {
          errors.push(`on_complete: potential circular trigger detected — '${config.name}' targets itself (warning)`);
        }
      }

      // Cross-check: try to detect A -> B -> A by loading target line configs
      for (const trigger of config.on_complete) {
        if (!trigger.target) continue;
        const targetDir = resolve(linesDir, trigger.target);
        const targetYaml = resolve(targetDir, "line.yaml");
        if (existsSync(targetYaml)) {
          try {
            const targetRaw = await Bun.file(targetYaml).text();
            const targetConfig = YAML.parse(targetRaw);
            if (targetConfig?.on_complete) {
              for (const downstream of targetConfig.on_complete) {
                if (downstream.target === config.name) {
                  errors.push(`on_complete: circular trigger detected — '${config.name}' -> '${trigger.target}' -> '${config.name}' (warning, not blocking)`);
                }
              }
            }
          } catch {
            // Ignore parse errors for cross-check
          }
        }
      }
    }
  } catch (e) {
    errors.push((e as Error).message);
  }

  return errors;
}
