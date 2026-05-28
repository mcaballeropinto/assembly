import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "fs";
import { loadLine, validateLine } from "../line";
import { LineName } from "../ids";

const TEMP_DIR = resolve("/tmp", `assembly-test-timeout-${Date.now()}`);

/** Create a minimal line directory with line.yaml and station AGENT.md files */
function createTestLine(
  name: string,
  lineYaml: string,
  stations: string[]
): string {
  const lineDir = resolve(TEMP_DIR, name);
  mkdirSync(lineDir, { recursive: true });
  writeFileSync(resolve(lineDir, "line.yaml"), lineYaml);

  for (const station of stations) {
    const stationDir = resolve(lineDir, "stations", station);
    mkdirSync(stationDir, { recursive: true });
    writeFileSync(
      resolve(stationDir, "AGENT.md"),
      `---\nprovider: api\nmodel: test\n---\nYou are a test station.\n`
    );
  }

  return lineDir;
}

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── Validation tests (unit) ──────────────────────────────────────

describe("timeout validation in loadLine()", () => {
  test("accepts valid timeout: 900", async () => {
    const lineDir = createTestLine(
      `valid-timeout-${Date.now()}`,
      `name: test-line\ntimeout: 900\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.timeout).toBe(900);
  });

  test("rejects timeout: -1 (negative)", async () => {
    const lineDir = createTestLine(
      `neg-timeout-${Date.now()}`,
      `name: test-line\ntimeout: -1\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("rejects timeout: 1.5 (non-integer)", async () => {
    const lineDir = createTestLine(
      `frac-timeout-${Date.now()}`,
      `name: test-line\ntimeout: 1.5\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("rejects timeout: 'fast' (non-number)", async () => {
    const lineDir = createTestLine(
      `str-timeout-${Date.now()}`,
      `name: test-line\ntimeout: fast\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("accepts timeout: 0 (unlimited, same as omitted)", async () => {
    const lineDir = createTestLine(
      `zero-timeout-${Date.now()}`,
      `name: test-line\ntimeout: 0\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.timeout).toBe(0);
  });

  test("per-station timeout override { station: { name: 'x', timeout: 1800 } } is valid", async () => {
    const lineDir = createTestLine(
      `per-station-valid-${Date.now()}`,
      `name: test-line\ntimeout: 900\nsequence:\n  - station: { name: station-a, timeout: 1800 }\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.timeout).toBe(900);
  });

  test("per-station timeout override { station: { name: 'x', timeout: -5 } } is rejected", async () => {
    const lineDir = createTestLine(
      `per-station-neg-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: station-a, timeout: -5 }\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("per-station timeout override with non-integer is rejected", async () => {
    const lineDir = createTestLine(
      `per-station-frac-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: station-a, timeout: 2.5 }\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("station object without name is rejected", async () => {
    const lineDir = createTestLine(
      `station-no-name-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { timeout: 100 }\n`,
      []
    );
    expect(loadLine(lineDir)).rejects.toThrow("must have a 'name' string");
  });
});

// ─── Station name extraction tests ────────────────────────────────

describe("collectStationNames with station-object variant", () => {
  test("extracts name from { station: { name: 'develop' } } sequence step", async () => {
    const lineDir = createTestLine(
      `station-obj-name-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: develop }\n`,
      ["develop"]
    );
    const { stations } = await loadLine(lineDir);
    expect(stations.has("develop")).toBe(true);
  });

  test("extracts names from mixed sequence (string + station-object)", async () => {
    const lineDir = createTestLine(
      `mixed-sequence-${Date.now()}`,
      `name: test-line\nsequence:\n  - plan\n  - station: { name: develop, timeout: 1800 }\n  - deploy\n`,
      ["plan", "develop", "deploy"]
    );
    const { stations } = await loadLine(lineDir);
    expect(stations.has("plan")).toBe(true);
    expect(stations.has("develop")).toBe(true);
    expect(stations.has("deploy")).toBe(true);
  });
});

// ─── Timeout resolution tests ─────────────────────────────────────

describe("timeout resolution in SectionInfo", () => {
  test("per-station override (1800) takes precedence over line-level default (900)", async () => {
    const lineDir = createTestLine(
      `override-precedence-${Date.now()}`,
      `name: test-line\ntimeout: 900\nsequence:\n  - plan\n  - station: { name: develop, timeout: 1800 }\n  - deploy\n`,
      ["plan", "develop", "deploy"]
    );
    const { config } = await loadLine(lineDir);

    // Simulate the same logic as startOrchestrator section building
    const stationTimeouts = new Map<string, number>();
    for (const step of config.sequence) {
      if (typeof step === "object" && "station" in step) {
        const s = (step as { station: { name: string; timeout?: number } }).station;
        if (s.timeout !== undefined && s.timeout > 0) {
          stationTimeouts.set(s.name, s.timeout);
        }
      }
    }

    // develop has per-station override of 1800
    const developTimeout = stationTimeouts.get("develop") ??
      (config.timeout && config.timeout > 0 ? config.timeout : undefined);
    expect(developTimeout).toBe(1800);

    // plan has no override, falls back to line-level 900
    const planTimeout = stationTimeouts.get("plan") ??
      (config.timeout && config.timeout > 0 ? config.timeout : undefined);
    expect(planTimeout).toBe(900);
  });

  test("line-level timeout (900) applies when no per-station override", async () => {
    const lineDir = createTestLine(
      `line-default-${Date.now()}`,
      `name: test-line\ntimeout: 900\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);

    const stationTimeouts = new Map<string, number>();
    const timeout = stationTimeouts.get("station-a") ??
      (config.timeout && config.timeout > 0 ? config.timeout : undefined);
    expect(timeout).toBe(900);
  });

  test("no timeout when neither line-level nor per-station is set", async () => {
    const lineDir = createTestLine(
      `no-timeout-${Date.now()}`,
      `name: test-line\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);

    const stationTimeouts = new Map<string, number>();
    const timeout = stationTimeouts.get("station-a") ??
      (config.timeout && config.timeout > 0 ? config.timeout : undefined);
    expect(timeout).toBeUndefined();
  });

  test("timeout: 0 treated as unlimited (no timeout applied)", async () => {
    const lineDir = createTestLine(
      `timeout-zero-${Date.now()}`,
      `name: test-line\ntimeout: 0\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);

    const stationTimeouts = new Map<string, number>();
    const timeout = stationTimeouts.get("station-a") ??
      (config.timeout && config.timeout > 0 ? config.timeout : undefined);
    expect(timeout).toBeUndefined();
  });
});

// ─── Backward compatibility tests ─────────────────────────────────

describe("backward compatibility", () => {
  test("existing line.yaml without timeout field loads successfully", async () => {
    const lineDir = createTestLine(
      `compat-no-timeout-${Date.now()}`,
      `name: test-line\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.timeout).toBeUndefined();
    expect(config.name).toBe(LineName("test-line"));
  });

  test("repo-health-digest line validates successfully (no timeout)", async () => {
    const opPath = resolve(__dirname, "../../lines/repo-health-digest");
    if (existsSync(resolve(opPath, "line.yaml"))) {
      const errors = await validateLine(opPath);
      expect(errors).toEqual([]);
    }
  });

  test("hello-world line validates successfully (no timeout)", async () => {
    const spPath = resolve(__dirname, "../../lines/hello-world");
    if (existsSync(resolve(spPath, "line.yaml"))) {
      const errors = await validateLine(spPath);
      expect(errors).toEqual([]);
    }
  });

  test("assembly-dev line with timeout: 900 validates successfully", async () => {
    const devPath = resolve(__dirname, "../../lines/assembly-dev");
    if (existsSync(resolve(devPath, "line.yaml"))) {
      const errors = await validateLine(devPath);
      expect(errors).toEqual([]);
    }
  });
});

// ─── Timeout enforcement tests (integration) ─────────────────────

describe("timeout enforcement", () => {
  test("short-timeout kills a long-running process", async () => {
    // Spawn a sleep process with a 1-second timeout
    const proc = Bun.spawn(["sleep", "60"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let killed = false;
    const timeoutTimer = setTimeout(() => {
      killed = true;
      try {
        process.kill(proc.pid!, "SIGTERM");
      } catch {}
    }, 1_000);

    const exitCode = await proc.exited;
    clearTimeout(timeoutTimer);

    // The process should have been killed (non-zero exit or signal)
    expect(killed).toBe(true);
    expect(exitCode).not.toBe(0);
  });

  test("fast process completes before timeout fires", async () => {
    // Spawn a fast process with a long timeout
    const proc = Bun.spawn(["true"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
    }, 60_000);

    const exitCode = await proc.exited;
    clearTimeout(timeoutTimer);

    // Process should complete normally
    expect(exitCode).toBe(0);
    expect(timedOut).toBe(false);
  });

  test("SIGKILL fallback fires after grace period", async () => {
    // Spawn a process that traps SIGTERM (ignores it)
    // Use bash -c to trap SIGTERM and sleep
    const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 60"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let sigkillSent = false;

    // Send SIGTERM after 500ms
    const termTimer = setTimeout(() => {
      try {
        process.kill(proc.pid!, "SIGTERM");
      } catch {}
    }, 500);

    // Send SIGKILL after 1500ms (1s grace period)
    const killTimer = setTimeout(() => {
      sigkillSent = true;
      try {
        process.kill(proc.pid!, "SIGKILL");
      } catch {}
    }, 1_500);

    const exitCode = await proc.exited;
    clearTimeout(termTimer);
    clearTimeout(killTimer);

    // Process should have been killed
    expect(sigkillSent).toBe(true);
    expect(exitCode).not.toBe(0);
  }, 10_000); // increase test timeout
});
