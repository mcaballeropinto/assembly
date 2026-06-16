import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";
import { readTailLines } from "../log-tail";

const TMP = resolve("/tmp", `assembly-log-tail-test-${Date.now()}`);

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  mkdirSync(TMP, { recursive: true });
  const filePath = resolve(TMP, name);
  writeFileSync(filePath, content);
  return filePath;
}

describe("readTailLines", () => {
  test("returns all non-empty lines for a tiny file", () => {
    const filePath = writeFixture("tiny.log", "one\ntwo\nthree\n");

    expect(readTailLines(filePath)).toEqual(["one", "two", "three"]);
  });

  test("keeps the first line when maxBytes equals the file size", () => {
    const filePath = writeFixture("boundary.log", "alpha\nbeta\n");
    const size = statSync(filePath).size;

    expect(readTailLines(filePath, { maxBytes: size })).toEqual(["alpha", "beta"]);
  });

  test("drops a partial first line when reading a large tail", () => {
    const filePath = writeFixture("large.log", "older-line\ncomplete-a\ncomplete-b\n");

    expect(readTailLines(filePath, { maxBytes: "complete-a\ncomplete-b\n".length + 2 })).toEqual([
      "complete-a",
      "complete-b",
    ]);
  });

  test("returns an empty array for a missing file", () => {
    expect(readTailLines(resolve(TMP, "missing.log"))).toEqual([]);
  });

  test("limits results to the last maxLines lines", () => {
    const filePath = writeFixture("lines.log", "one\ntwo\nthree\nfour\n");

    expect(readTailLines(filePath, { maxLines: 2 })).toEqual(["three", "four"]);
  });

  test("returns an empty array when maxLines is zero", () => {
    const filePath = writeFixture("zero.log", "one\ntwo\n");

    expect(readTailLines(filePath, { maxLines: 0 })).toEqual([]);
  });
});
