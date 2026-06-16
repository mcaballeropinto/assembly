import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { assertBuiltBundle } from "./check-dashboard-release";

const TEMP_DIR = resolve("/tmp", `assembly-dashboard-release-test-${Date.now()}-${process.pid}`);

afterEach(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

function writeBundle(js: string): string {
  const distDir = resolve(TEMP_DIR, crypto.randomUUID());
  const assetsDir = resolve(distDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    resolve(distDir, "index.html"),
    '<!doctype html><html><head><script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css"></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(resolve(assetsDir, "index.js"), js);
  writeFileSync(resolve(assetsDir, "index.css"), ".dashboard { display: block; }\n");
  return distDir;
}

describe("dashboard release check", () => {
  test("passes for a built dashboard bundle with required overview markers", () => {
    const distDir = writeBundle(
      "console.log('Overview', 'Activity', 'Loading overview...', 'No lines discovered.')",
    );

    expect(() => assertBuiltBundle(distDir)).not.toThrow();
  });

  test("fails when a stale smoke bundle is present", () => {
    const distDir = writeBundle(
      "console.log('Overview', 'Activity', 'Loading overview...', 'No lines discovered.', 'shadcn/ui smoke check', 'It works')",
    );

    expect(() => assertBuiltBundle(distDir)).toThrow(/banned placeholder text/);
  });

  test("fails when index.html references a missing asset", () => {
    const distDir = resolve(TEMP_DIR, crypto.randomUUID());
    mkdirSync(resolve(distDir, "assets"), { recursive: true });
    writeFileSync(
      resolve(distDir, "index.html"),
      '<!doctype html><script type="module" src="/assets/missing.js"></script>',
    );
    writeFileSync(
      resolve(distDir, "assets", "index.js"),
      "console.log('Overview', 'Activity', 'Loading overview...', 'No lines discovered.')",
    );

    expect(() => assertBuiltBundle(distDir)).toThrow(/missing asset/);
  });
});
