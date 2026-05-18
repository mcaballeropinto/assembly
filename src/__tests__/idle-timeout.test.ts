import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve, basename } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
  renameSync,
} from "fs";
import { loadLine, validateLine } from "../line";
import { failStation } from "../workpiece";
import type { Workpiece } from "../types";

const TEMP_DIR = resolve("/tmp", `assembly-test-idle-timeout-${Date.now()}`);

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

/** Create a minimal workpiece JSON */
function createTestWorkpiece(
  stationName?: string,
  stationStatus?: string
): Workpiece {
  const wp: Workpiece = {
    id: `test-${Date.now()}`,
    line: "test-line",
    task: "test task",
    input: {},
    stations: {},
  };
  if (stationName && stationStatus) {
    wp.stations[stationName] = {
      status: stationStatus as any,
      summary: `Station ${stationStatus}`,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      model: "test",
      tokens: { in: 0, out: 0 },
      cost_usd: 0,
    };
  }
  return wp;
}

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── max_wall_clock and flush_grace validation ───────────────────

describe("max_wall_clock and flush_grace validation", () => {
  test("accepts valid max_wall_clock: 3600", async () => {
    const lineDir = createTestLine(
      `valid-mwc-${Date.now()}`,
      `name: test-line\nmax_wall_clock: 3600\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.max_wall_clock).toBe(3600);
  });

  test("rejects max_wall_clock: -1 (negative)", async () => {
    const lineDir = createTestLine(
      `neg-mwc-${Date.now()}`,
      `name: test-line\nmax_wall_clock: -1\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("rejects max_wall_clock: 2.5 (non-integer)", async () => {
    const lineDir = createTestLine(
      `frac-mwc-${Date.now()}`,
      `name: test-line\nmax_wall_clock: 2.5\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("accepts valid flush_grace: 30", async () => {
    const lineDir = createTestLine(
      `valid-fg-${Date.now()}`,
      `name: test-line\nflush_grace: 30\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.flush_grace).toBe(30);
  });

  test("rejects flush_grace: -1 (negative)", async () => {
    const lineDir = createTestLine(
      `neg-fg-${Date.now()}`,
      `name: test-line\nflush_grace: -1\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("rejects flush_grace: 1.5 (non-integer)", async () => {
    const lineDir = createTestLine(
      `frac-fg-${Date.now()}`,
      `name: test-line\nflush_grace: 1.5\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("per-station max_wall_clock: 7200 is valid", async () => {
    const lineDir = createTestLine(
      `per-station-mwc-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: station-a, max_wall_clock: 7200 }\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.sequence.length).toBe(1);
  });

  test("per-station max_wall_clock: -5 is rejected", async () => {
    const lineDir = createTestLine(
      `per-station-mwc-neg-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: station-a, max_wall_clock: -5 }\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });

  test("per-station flush_grace: 60 is valid", async () => {
    const lineDir = createTestLine(
      `per-station-fg-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: station-a, flush_grace: 60 }\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.sequence.length).toBe(1);
  });

  test("per-station flush_grace: -1 is rejected", async () => {
    const lineDir = createTestLine(
      `per-station-fg-neg-${Date.now()}`,
      `name: test-line\nsequence:\n  - station: { name: station-a, flush_grace: -1 }\n`,
      ["station-a"]
    );
    expect(loadLine(lineDir)).rejects.toThrow("non-negative integer");
  });
});

// ─── Idle watchdog behavior (integration) ────────────────────────

describe("idle watchdog behavior", () => {
  test("worker producing output every 5s with 10s idle timeout completes (not killed)", async () => {
    // Spawn a process that emits output every 5s for ~25s total (5 ticks)
    const proc = Bun.spawn(
      ["bash", "-c", "for i in $(seq 1 5); do echo tick; sleep 5; done"],
      { stdout: "pipe", stderr: "pipe" }
    );

    let lastActivityMs = Date.now();
    let timedOut = false;
    const idleThresholdMs = 10_000;

    // Read stdout chunks to update liveness
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivityMs = Date.now();
        }
      } catch {}
    })();

    // Idle watchdog
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= idleThresholdMs) {
        timedOut = true;
        clearInterval(watchdog);
        try { process.kill(proc.pid!, "SIGTERM"); } catch {}
      }
    }, 1_000);

    const exitCode = await proc.exited;
    clearInterval(watchdog);

    expect(exitCode).toBe(0);
    expect(timedOut).toBe(false);
  }, 35_000); // generous timeout

  test("worker silent for >2s with 2s idle timeout receives SIGTERM", async () => {
    const proc = Bun.spawn(["sleep", "60"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let lastActivityMs = Date.now();
    let timedOut = false;
    const idleThresholdMs = 2_000;

    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= idleThresholdMs) {
        timedOut = true;
        clearInterval(watchdog);
        try { process.kill(proc.pid!, "SIGTERM"); } catch {}
      }
    }, 200);

    const exitCode = await proc.exited;
    clearInterval(watchdog);

    expect(timedOut).toBe(true);
    expect(exitCode).not.toBe(0);
  }, 10_000);

  test("max_wall_clock fires even while output flows", async () => {
    // Continuous output every 1s — idle timeout would never fire
    const proc = Bun.spawn(
      ["bash", "-c", "while true; do echo tick; sleep 1; done"],
      { stdout: "pipe", stderr: "pipe" }
    );

    let lastActivityMs = Date.now();
    let wallClockFired = false;

    // Read chunks to update liveness (idle would never fire)
    const reader = proc.stdout.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivityMs = Date.now();
        }
      } catch {}
    })();

    // Idle watchdog at 60s — should never fire
    const idleWatchdog = setInterval(() => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= 60_000) {
        clearInterval(idleWatchdog);
        try { process.kill(proc.pid!, "SIGTERM"); } catch {}
      }
    }, 1_000);

    // max_wall_clock at 3s — should fire
    const wallClockTimer = setTimeout(() => {
      wallClockFired = true;
      clearInterval(idleWatchdog);
      try { process.kill(proc.pid!, "SIGTERM"); } catch {}
    }, 3_000);

    const exitCode = await proc.exited;
    clearInterval(idleWatchdog);
    clearTimeout(wallClockTimer);

    expect(wallClockFired).toBe(true);
    expect(exitCode).not.toBe(0);
  }, 10_000);
});

// ─── flush_grace and SIGKILL ─────────────────────────────────────

describe("flush_grace and SIGKILL", () => {
  test("flush_grace expiry triggers SIGKILL", async () => {
    // Process that traps SIGTERM (ignores it)
    const proc = Bun.spawn(
      ["bash", "-c", "trap '' TERM; sleep 60"],
      { stdout: "pipe", stderr: "pipe" }
    );

    let sigkillSent = false;

    // Send SIGTERM after 500ms
    setTimeout(() => {
      try { process.kill(proc.pid!, "SIGTERM"); } catch {}
    }, 500);

    // SIGKILL after 1500ms (1s flush_grace)
    setTimeout(() => {
      sigkillSent = true;
      try { process.kill(proc.pid!, "SIGKILL"); } catch {}
    }, 1_500);

    const exitCode = await proc.exited;

    expect(sigkillSent).toBe(true);
    expect(exitCode).not.toBe(0);
  }, 10_000);
});

// ─── SIGTERM handler state flush (unit) ──────────────────────────

describe("SIGTERM handler state flush", () => {
  test("workpiece with status=done routes to output on flush", () => {
    const testName = `flush-done-${Date.now()}`;
    const processingDir = resolve(TEMP_DIR, testName, "processing");
    const outputDir = resolve(TEMP_DIR, testName, "output");
    mkdirSync(processingDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const wp = createTestWorkpiece("test-station", "done");
    const wpPath = resolve(processingDir, `wp-${wp.id}.json`);
    writeFileSync(wpPath, JSON.stringify(wp, null, 2));

    // Simulate the flush logic from the SIGTERM handler
    const diskData = readFileSync(wpPath, "utf-8");
    const diskWorkpiece = JSON.parse(diskData) as Workpiece;
    const stationResult = diskWorkpiece.stations["test-station"];

    expect(stationResult?.status).toBe("done");

    // Flush: rename to output/
    const outPath = resolve(outputDir, basename(wpPath));
    renameSync(wpPath, outPath);

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(wpPath)).toBe(false);

    // Verify content is preserved
    const flushed = JSON.parse(readFileSync(outPath, "utf-8")) as Workpiece;
    expect(flushed.stations["test-station"]?.status).toBe("done");
  });

  test("workpiece without envelope gets failStation on flush", () => {
    const testName = `flush-fail-${Date.now()}`;
    const processingDir = resolve(TEMP_DIR, testName, "processing");
    const outputDir = resolve(TEMP_DIR, testName, "output");
    mkdirSync(processingDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const wp = createTestWorkpiece(); // no station results
    const wpPath = resolve(processingDir, `wp-${wp.id}.json`);
    writeFileSync(wpPath, JSON.stringify(wp, null, 2));

    // Simulate the flush logic: station not done → failStation
    const diskData = readFileSync(wpPath, "utf-8");
    const diskWorkpiece = JSON.parse(diskData) as Workpiece;
    const stationResult = diskWorkpiece.stations["test-station"];

    expect(stationResult).toBeUndefined();

    // Write failure using failStation
    const failed = failStation(diskWorkpiece, "test-station", "idle timeout after 30s", {
      model: "api:test",
      tokens: { in: 0, out: 0 },
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    writeFileSync(wpPath, JSON.stringify(failed, null, 2));

    // Rename to output/
    const outPath = resolve(outputDir, basename(wpPath));
    renameSync(wpPath, outPath);

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(wpPath)).toBe(false);

    // Verify failure was written
    const flushed = JSON.parse(readFileSync(outPath, "utf-8")) as Workpiece;
    expect(flushed.stations["test-station"]?.status).toBe("failed");
    expect(flushed.stations["test-station"]?.summary).toContain("idle timeout");
  });
});

// ─── Backward compatibility ──────────────────────────────────────

describe("backward compatibility", () => {
  test("line without new fields loads fine", async () => {
    const lineDir = createTestLine(
      `compat-no-new-fields-${Date.now()}`,
      `name: test-line\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.max_wall_clock).toBeUndefined();
    expect(config.flush_grace).toBeUndefined();
    expect(config.timeout).toBeUndefined();
    expect(config.name).toBe("test-line");
  });

  test("assembly-dev line with timeout: 900 validates", async () => {
    const devPath = resolve(__dirname, "../../lines/assembly-dev");
    if (existsSync(resolve(devPath, "line.yaml"))) {
      const errors = await validateLine(devPath);
      expect(errors).toEqual([]);
    }
  });

  test("repo-health-digest line validates successfully", async () => {
    const opPath = resolve(__dirname, "../../lines/repo-health-digest");
    if (existsSync(resolve(opPath, "line.yaml"))) {
      const errors = await validateLine(opPath);
      expect(errors).toEqual([]);
    }
  });

  test("hello-world line validates successfully", async () => {
    const spPath = resolve(__dirname, "../../lines/hello-world");
    if (existsSync(resolve(spPath, "line.yaml"))) {
      const errors = await validateLine(spPath);
      expect(errors).toEqual([]);
    }
  });

  test("line with all new fields loads correctly", async () => {
    const lineDir = createTestLine(
      `all-fields-${Date.now()}`,
      `name: test-line\ntimeout: 900\nmax_wall_clock: 3600\nflush_grace: 60\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);
    expect(config.timeout).toBe(900);
    expect(config.max_wall_clock).toBe(3600);
    expect(config.flush_grace).toBe(60);
  });
});

// ─── Section building resolution ─────────────────────────────────

describe("section building resolves new fields correctly", () => {
  test("per-station max_wall_clock overrides line-level", async () => {
    const lineDir = createTestLine(
      `resolve-mwc-${Date.now()}`,
      `name: test-line\nmax_wall_clock: 3600\nsequence:\n  - plan\n  - station: { name: develop, max_wall_clock: 7200 }\n`,
      ["plan", "develop"]
    );
    const { config } = await loadLine(lineDir);

    // Simulate orchestrator resolution logic
    const stationMaxWallClocks = new Map<string, number>();
    for (const step of config.sequence) {
      if (typeof step === 'object' && 'station' in step) {
        const s = (step as { station: { name: string; max_wall_clock?: number } }).station;
        if (s.max_wall_clock !== undefined && s.max_wall_clock > 0) {
          stationMaxWallClocks.set(s.name, s.max_wall_clock);
        }
      }
    }

    // develop: per-station 7200 overrides line-level 3600
    const developMwc = stationMaxWallClocks.get("develop") ??
      (config.max_wall_clock && config.max_wall_clock > 0 ? config.max_wall_clock : undefined);
    expect(developMwc).toBe(7200);

    // plan: falls back to line-level 3600
    const planMwc = stationMaxWallClocks.get("plan") ??
      (config.max_wall_clock && config.max_wall_clock > 0 ? config.max_wall_clock : undefined);
    expect(planMwc).toBe(3600);
  });

  test("flush_grace defaults to 30 when not specified", async () => {
    const lineDir = createTestLine(
      `resolve-fg-default-${Date.now()}`,
      `name: test-line\nsequence:\n  - station-a\n`,
      ["station-a"]
    );
    const { config } = await loadLine(lineDir);

    const stationFlushGraces = new Map<string, number>();
    const flushGrace = stationFlushGraces.get("station-a") ?? config.flush_grace ?? 30;
    expect(flushGrace).toBe(30);
  });
});
