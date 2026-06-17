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

function writeHeldFile(name: string, task: string) {
  const heldDir = resolve(linePath, "queues", "held");
  mkdirSync(heldDir, { recursive: true });
  writeFileSync(resolve(heldDir, name), JSON.stringify({ task, input: {} }));
}

function jsonFiles(queue: "inbox" | "held"): string[] {
  const dir = resolve(linePath, "queues", queue);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json") && !name.includes(".tmp.")).sort();
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
  testHome = resolve(tmpdir(), `assembly-cli-release-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("assembly release", () => {
  test("release --next 2 moves the two oldest held files and records release emits", async () => {
    writeHeldFile("task-next-cli-1.json", "Next CLI 1");
    await Bun.sleep(10);
    writeHeldFile("task-next-cli-2.json", "Next CLI 2");
    await Bun.sleep(10);
    writeHeldFile("task-next-cli-3.json", "Next CLI 3");
    await Bun.sleep(10);
    writeHeldFile("task-next-cli-4.json", "Next CLI 4");

    const result = await runCli(["release", linePath, "--next", "2"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Released: 2 | Skipped: 0 | Errors: 0");
    expect(jsonFiles("inbox")).toEqual(["task-next-cli-1.json", "task-next-cli-2.json"]);
    expect(jsonFiles("held")).toEqual(["task-next-cli-3.json", "task-next-cli-4.json"]);
    expect(manifestEntries("inbox").filter((entry) => entry.source === "release")).toEqual([
      expect.objectContaining({ filename: "task-next-cli-1.json", source: "release" }),
      expect.objectContaining({ filename: "task-next-cli-2.json", source: "release" }),
    ]);
  });

  test("release --next 0 exits non-zero without moving held files", async () => {
    writeHeldFile("task-next-invalid-cli.json", "Invalid next should stay held");

    const result = await runCli(["release", linePath, "--next", "0"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--next must be a positive integer");
    expect(jsonFiles("held")).toEqual(["task-next-invalid-cli.json"]);
    expect(jsonFiles("inbox")).toEqual([]);
  });
});
