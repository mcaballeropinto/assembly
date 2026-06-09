import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join as joinPath } from "path";
import { resolveAssemblyRepoRoot } from "../assembly-dev-station-utils";

function makeRepo(root: string) {
  mkdirSync(joinPath(root, "src"), { recursive: true });
  mkdirSync(joinPath(root, "lines", "assembly-dev", "stations", "develop"), { recursive: true });
  writeFileSync(joinPath(root, "package.json"), "{}");
  writeFileSync(joinPath(root, "src", "cli.ts"), "");
  writeFileSync(joinPath(root, "lines", "assembly-dev", "line.yaml"), "name: assembly-dev\n");
}

describe("assembly-dev station utils", () => {
  it("uses ASSEMBLY_REPO_ROOT when it points at an assembly repo", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-station-utils-"));
    const original = process.env.ASSEMBLY_REPO_ROOT;
    try {
      makeRepo(root);
      process.env.ASSEMBLY_REPO_ROOT = root;

      const resolved = resolveAssemblyRepoRoot(joinPath(root, "lines", "assembly-dev", "stations", "develop"));

      expect(resolved).toBe(root);
    } finally {
      if (original === undefined) delete process.env.ASSEMBLY_REPO_ROOT;
      else process.env.ASSEMBLY_REPO_ROOT = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the station-relative repo when ASSEMBLY_REPO_ROOT is stale", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "assembly-station-utils-"));
    const original = process.env.ASSEMBLY_REPO_ROOT;
    try {
      makeRepo(root);
      process.env.ASSEMBLY_REPO_ROOT = joinPath(root, "not-the-repo");

      const resolved = resolveAssemblyRepoRoot(joinPath(root, "lines", "assembly-dev", "stations", "develop"));

      expect(resolved).toBe(root);
    } finally {
      if (original === undefined) delete process.env.ASSEMBLY_REPO_ROOT;
      else process.env.ASSEMBLY_REPO_ROOT = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
