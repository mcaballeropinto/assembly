import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { listCompletedTaskKeys, filterReadyByDeps } from "../queue";

let TMP: string;
let DONE: string;
let INBOX: string;

beforeEach(() => {
  TMP = resolve("/tmp", `assembly-deps-${Date.now()}-${Math.random()}`);
  DONE = resolve(TMP, "queues", "done");
  INBOX = resolve(TMP, "queues", "inbox");
  mkdirSync(DONE, { recursive: true });
  mkdirSync(INBOX, { recursive: true });
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function writeInbox(name: string, body: Record<string, unknown>): string {
  const p = resolve(INBOX, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

function writeDone(name: string): void {
  writeFileSync(resolve(DONE, name), "{}");
}

describe("listCompletedTaskKeys", () => {
  test("returns empty set when done/ doesn't exist", () => {
    const keys = listCompletedTaskKeys(resolve(TMP, "no-such-dir"));
    expect(keys.size).toBe(0);
  });

  test("strips .json from filenames", () => {
    writeDone("alpha.json");
    writeDone("beta.json");
    const keys = listCompletedTaskKeys(DONE);
    expect(keys.has("alpha")).toBe(true);
    expect(keys.has("beta")).toBe(true);
    expect(keys.size).toBe(2);
  });

  test("ignores sidecar files", () => {
    writeDone("alpha.json");
    writeDone("alpha.retry.json");
    writeDone("alpha.envelope.json");
    const keys = listCompletedTaskKeys(DONE);
    expect(keys.has("alpha")).toBe(true);
    expect(keys.size).toBe(1);
  });
});

describe("filterReadyByDeps", () => {
  test("workpieces with no dependsOn always pass", () => {
    const p = writeInbox("free.json", { task: "go" });
    const ready = filterReadyByDeps([p], new Set());
    expect(ready).toEqual([p]);
  });

  test("workpiece with all deps satisfied passes", () => {
    const p = writeInbox("b.json", { task: "after a", dependsOn: ["a"] });
    const ready = filterReadyByDeps([p], new Set(["a"]));
    expect(ready).toEqual([p]);
  });

  test("workpiece with unmet deps is filtered out", () => {
    const p = writeInbox("b.json", { task: "after a", dependsOn: ["a"] });
    const ready = filterReadyByDeps([p], new Set());
    expect(ready).toEqual([]);
  });

  test("partial deps satisfaction filters out", () => {
    const p = writeInbox("c.json", { task: "after a+b", dependsOn: ["a", "b"] });
    const ready = filterReadyByDeps([p], new Set(["a"]));
    expect(ready).toEqual([]);
  });

  test("mixed inbox: ready tasks pass, blocked tasks filtered", () => {
    const free = writeInbox("free.json", { task: "go" });
    const blocked = writeInbox("blocked.json", { task: "wait", dependsOn: ["never"] });
    const ready = writeInbox("ready.json", { task: "fire", dependsOn: ["a"] });
    const out = filterReadyByDeps([free, blocked, ready], new Set(["a"]));
    expect(out).toContain(free);
    expect(out).toContain(ready);
    expect(out).not.toContain(blocked);
  });

  test("malformed JSON falls through (handled by normal pipeline)", () => {
    const bad = resolve(INBOX, "bad.json");
    writeFileSync(bad, "{not json");
    const ready = filterReadyByDeps([bad], new Set());
    expect(ready).toEqual([bad]);
  });

  test("non-string entries in dependsOn are ignored", () => {
    const p = writeInbox("weird.json", { task: "x", dependsOn: [123, null, "a"] });
    expect(filterReadyByDeps([p], new Set(["a"]))).toEqual([p]);
    expect(filterReadyByDeps([p], new Set())).toEqual([]);
  });

  test("empty dependsOn array is treated as no deps", () => {
    const p = writeInbox("empty.json", { task: "x", dependsOn: [] });
    expect(filterReadyByDeps([p], new Set())).toEqual([p]);
  });
});
