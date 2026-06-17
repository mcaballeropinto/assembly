import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CLI = resolve(REPO_ROOT, "src", "cli.ts");

let testHome: string;
let linePath: string;

function sandboxedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: testHome,
    ASSEMBLY_DISABLE_USAGE_GATE: "1",
  };
  delete env.ASSEMBLY_HOME;
  delete env.ASSEMBLY_LINE_DIRS;
  delete env.INVOCATION_ID;
  return env;
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: sandboxedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function jsonFiles(queue: "inbox" | "held" | "done"): string[] {
  const dir = resolve(linePath, "queues", queue);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json") && !name.includes(".tmp."));
}

function readTask(queue: "inbox" | "held", fileName: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(linePath, "queues", queue, fileName), "utf-8"));
}

function manifestEntries(queue: "inbox" | "held"): Array<Record<string, string>> {
  const manifest = resolve(linePath, "queues", queue, ".emitted.jsonl");
  if (!existsSync(manifest)) return [];
  return readFileSync(manifest, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  testHome = resolve(tmpdir(), `assembly-cli-enqueue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  linePath = resolve(testHome, "lines", "test-line");
  mkdirSync(linePath, { recursive: true });
  writeFileSync(
    resolve(linePath, "line.yaml"),
    "name: test-line\nsequence:\n  - station-a\n"
  );
});

afterEach(() => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
});

describe("assembly enqueue", () => {
  test("single enqueue writes payload fields and records an inbox manifest emit", async () => {
    const result = await runCli([
      "enqueue",
      linePath,
      "--task",
      "one",
      "--input",
      '{"x":1}',
      "--key",
      "alpha",
      "--depends-on",
      "root",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Task enqueued:");
    const payload = readTask("inbox", "alpha.json");
    expect(payload.schema_version).toBe(1);
    expect(payload.task).toBe("one");
    expect(payload.input.x).toBe(1);
    expect(payload.taskKey).toBe("alpha");
    expect(payload.dependsOn).toEqual(["root"]);
    expect(manifestEntries("inbox")).toEqual([
      expect.objectContaining({ filename: "alpha.json", source: "cli" }),
    ]);
  });

  test("single held enqueue writes atomically and records a held manifest emit", async () => {
    const result = await runCli([
      "enqueue",
      linePath,
      "--task",
      "held",
      "--hold",
      "--key",
      "held-alpha",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Task held (not released):");
    expect(existsSync(resolve(linePath, "queues", "held", "held-alpha.json"))).toBe(true);
    expect(readdirSync(resolve(linePath, "queues", "held")).some((name) => name.includes(".tmp."))).toBe(false);
    expect(manifestEntries("held")).toEqual([
      expect.objectContaining({ filename: "held-alpha.json", source: "cli" }),
    ]);
  });

  test("bulk enqueue to held continues after malformed JSON and exits non-zero", async () => {
    const file = resolve(testHome, "tasks.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ task: "first", key: "first" }),
        JSON.stringify({ task: "second", input: { n: 2 } }),
        "{bad json",
        JSON.stringify({ task: "third", dependsOn: ["first"] }),
      ].join("\n")
    );

    const result = await runCli(["enqueue", linePath, "--from-file", file, "--hold"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Line 3:");
    expect(result.stdout).toContain("enqueued 0, held 3, failed 1");
    expect(jsonFiles("held")).toHaveLength(3);
    expect(manifestEntries("held").filter((entry) => entry.source === "cli")).toHaveLength(3);
  });

  test("bulk enqueue to inbox writes all valid rows and summarizes success", async () => {
    const file = resolve(testHome, "tasks.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ task: "first", key: "first" }),
        JSON.stringify({ task: "second", input: { n: 2 } }),
        "",
      ].join("\n")
    );

    const result = await runCli(["enqueue", linePath, "--from-file", file]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("enqueued 2, held 0, failed 0");
    expect(jsonFiles("inbox")).toHaveLength(2);
    expect(manifestEntries("inbox").filter((entry) => entry.source === "cli")).toHaveLength(2);
  });

  test("bulk enqueue reports invalid keys with line numbers and keeps later rows", async () => {
    const file = resolve(testHome, "tasks.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ task: "bad", key: "bad/key" }),
        JSON.stringify({ task: "good", key: "good-key" }),
      ].join("\n")
    );

    const result = await runCli(["enqueue", linePath, "--from-file", file]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Line 1:");
    expect(result.stderr).toContain("must be alphanumeric with . _ -");
    expect(result.stdout).toContain("enqueued 1, held 0, failed 1");
    expect(existsSync(resolve(linePath, "queues", "inbox", "good-key.json"))).toBe(true);
  });

  test("bulk enqueue reports duplicate key collisions without overwriting", async () => {
    const file = resolve(testHome, "tasks.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ task: "first", key: "dupe" }),
        JSON.stringify({ task: "second", key: "dupe" }),
      ].join("\n")
    );

    const result = await runCli(["enqueue", linePath, "--from-file", file]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Line 2:");
    expect(result.stderr).toContain("task key 'dupe' already exists");
    expect(result.stdout).toContain("enqueued 1, held 0, failed 1");
    expect(readTask("inbox", "dupe.json").task).toBe("first");
  });

  test("bulk enqueue rejects single-task-only flags before writing", async () => {
    const file = resolve(testHome, "tasks.jsonl");
    writeFileSync(file, JSON.stringify({ task: "first", key: "first" }) + "\n");

    const result = await runCli([
      "enqueue",
      linePath,
      "--from-file",
      file,
      "--key",
      "global-key",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--key is only valid with --task");
    expect(jsonFiles("inbox")).toHaveLength(0);
    expect(jsonFiles("held")).toHaveLength(0);
  });
});
