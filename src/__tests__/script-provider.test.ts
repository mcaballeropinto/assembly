import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { callScript } from "../llm";
import { calculateCost } from "../pricing";
import { parseEnvelope } from "../envelope";
import { loadStation } from "../station";
import { validateLine } from "../line";

const TEMP_DIR = resolve("/tmp", `assembly-test-script-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── Helper: create a temp script file ───────────────────────────────

function createScript(name: string, content: string): string {
  const path = resolve(TEMP_DIR, name);
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

function createWorkpieceFile(data: any = {}): string {
  const path = resolve(TEMP_DIR, `workpiece-${Date.now()}.json`);
  const workpiece = {
    id: "test-run",
    line: "test-line",
    task: "test task",
    input: {},
    stations: {},
    ...data,
  };
  writeFileSync(path, JSON.stringify(workpiece));
  return path;
}

// ─── callScript() tests ──────────────────────────────────────────────

describe("callScript()", () => {
  test("executes a script and returns stdout as content", async () => {
    const script = createScript(
      "success.ts",
      `console.log(JSON.stringify({ summary: "test passed", data: { count: 1 } }));`
    );
    const wpPath = createWorkpieceFile();

    const result = await callScript(script, wpPath);

    expect(result.tokens).toEqual({ in: 0, out: 0 });
    expect(result.model).toBe("script");

    const envelope = JSON.parse(result.content);
    expect(envelope.summary).toBe("test passed");
    expect(envelope.data.count).toBe(1);
  });

  test("throws on non-zero exit code", async () => {
    const script = createScript(
      "fail.ts",
      `console.error("Error: something broke"); process.exit(1);`
    );
    const wpPath = createWorkpieceFile();

    expect(callScript(script, wpPath)).rejects.toThrow(/exited with code 1/);
  });

  test("throws on empty stdout", async () => {
    const script = createScript("empty.ts", `// outputs nothing`);
    const wpPath = createWorkpieceFile();

    expect(callScript(script, wpPath)).rejects.toThrow(/produced no output/);
  });

  test("passes workpiece path as argument", async () => {
    const script = createScript(
      "read-wp.ts",
      `
      const wp = JSON.parse(await Bun.file(process.argv[2]).text());
      console.log(JSON.stringify({ summary: wp.task, data: { id: wp.id } }));
      `
    );
    const wpPath = createWorkpieceFile({ task: "check argv" });

    const result = await callScript(script, wpPath);
    const envelope = JSON.parse(result.content);
    expect(envelope.summary).toBe("check argv");
    expect(envelope.data.id as string).toBe("test-run");
  });

  test("includes stderr in error message on failure", async () => {
    const script = createScript(
      "stderr-fail.ts",
      `console.error("detailed error info"); process.exit(1);`
    );
    const wpPath = createWorkpieceFile();

    try {
      await callScript(script, wpPath);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("detailed error info");
    }
  });
});

// ─── Pricing tests ──────────────────────────────────────────────────

describe("pricing for script provider", () => {
  test("calculateCost returns 0 for script model", () => {
    expect(calculateCost("script", 0, 0)).toBe(0);
  });

  test("calculateCost returns 0 for script model with any token count", () => {
    // Even if tokens were somehow non-zero, the pricing is 0/0
    expect(calculateCost("script", 1000, 1000)).toBe(0);
  });
});

// ─── Envelope parsing for script output ─────────────────────────────

describe("parseEnvelope with script output", () => {
  test("parses clean JSON from script", () => {
    const envelope = parseEnvelope(
      '{"summary":"Pushed 3 records","content":"## Log","data":{"created":3}}'
    );
    expect(envelope.summary).toBe("Pushed 3 records");
    expect(envelope.content).toBe("## Log");
    expect(envelope.data?.created).toBe(3);
  });

  test("handles text before JSON (e.g., debug output)", () => {
    const envelope = parseEnvelope(
      'Processing...\nLoading data...\n{"summary":"done","data":{"count":1}}'
    );
    expect(envelope.summary).toBe("done");
  });

  test("handles script output with trailing newline", () => {
    const envelope = parseEnvelope(
      '{"summary":"test"}\n'
    );
    expect(envelope.summary).toBe("test");
  });
});

// ─── loadStation() tests ─────────────────────────────────────────────

describe("loadStation() with script provider", () => {
  test("parses script field from frontmatter", async () => {
    const stationDir = resolve(TEMP_DIR, "test-station");
    mkdirSync(stationDir, { recursive: true });
    mkdirSync(resolve(stationDir, "memory"), { recursive: true });

    writeFileSync(
      resolve(stationDir, "AGENT.md"),
      `---
provider: script
script: push.ts
reads: [score.data]
---

# This body is ignored for script stations
`
    );

    const station = await loadStation(stationDir, "test-station");

    expect(station.provider).toBe("script");
    expect(station.script).toBe("push.ts");
    expect(station.reads).toEqual(["score.data"]);
  });

  test("script field is undefined when not in frontmatter", async () => {
    const stationDir = resolve(TEMP_DIR, "test-station-no-script");
    mkdirSync(stationDir, { recursive: true });
    mkdirSync(resolve(stationDir, "memory"), { recursive: true });

    writeFileSync(
      resolve(stationDir, "AGENT.md"),
      `---
provider: api
model: sonnet
---

# Regular LLM station
Do something.
`
    );

    const station = await loadStation(stationDir, "test-station-no-script");

    expect(station.provider).toBe("api");
    expect(station.script).toBeUndefined();
  });
});

// ─── validateLine() tests ────────────────────────────────────────────

describe("validateLine() with script stations", () => {
  function createTestLine(options: {
    provider: string;
    script?: string;
    createScriptFile?: boolean;
    prompt?: string;
  }): string {
    const linePath = resolve(TEMP_DIR, `line-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const stationDir = resolve(linePath, "stations", "test-station");
    mkdirSync(stationDir, { recursive: true });
    mkdirSync(resolve(stationDir, "memory"), { recursive: true });

    // line.yaml
    writeFileSync(
      resolve(linePath, "line.yaml"),
      `name: test-line
sequence:
  - test-station
`
    );

    // AGENT.md
    const frontmatter = [`provider: ${options.provider}`];
    if (options.script) frontmatter.push(`script: ${options.script}`);

    writeFileSync(
      resolve(stationDir, "AGENT.md"),
      `---
${frontmatter.join("\n")}
---

${options.prompt ?? ""}
`
    );

    // Optionally create the script file
    if (options.createScriptFile && options.script) {
      writeFileSync(
        resolve(stationDir, options.script),
        `console.log(JSON.stringify({ summary: "test" }));`
      );
    }

    return linePath;
  }

  test("accepts script station with empty prompt and valid script file", async () => {
    const linePath = createTestLine({
      provider: "script",
      script: "push.ts",
      createScriptFile: true,
    });

    const errors = await validateLine(linePath);
    expect(errors).toEqual([]);
  });

  test("rejects script station with no script field", async () => {
    const linePath = createTestLine({
      provider: "script",
      prompt: "ignored",
    });

    const errors = await validateLine(linePath);
    expect(errors.some((e) => e.includes('has no "script" field'))).toBe(true);
  });

  test("rejects script station when script file does not exist", async () => {
    const linePath = createTestLine({
      provider: "script",
      script: "nonexistent.ts",
    });

    const errors = await validateLine(linePath);
    expect(errors.some((e) => e.includes("script file not found"))).toBe(true);
  });

  test("still requires prompt for non-script stations", async () => {
    const linePath = createTestLine({
      provider: "api",
      prompt: "",
    });

    const errors = await validateLine(linePath);
    expect(errors.some((e) => e.includes("empty AGENT.md body"))).toBe(true);
  });
});
