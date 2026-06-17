import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const deploySource = readFileSync("lines/assembly-dev/stations/deploy/deploy.ts", "utf-8");

function expectBefore(before: string, after: string) {
  const beforeIndex = deploySource.indexOf(before);
  const afterIndex = deploySource.indexOf(after);

  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThanOrEqual(0);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

describe("deploy dependency installation", () => {
  it("installs workspace dependencies deterministically before deploy validations and builds", () => {
    expect(deploySource).toContain("function installWorkspaceDependencies(cwd: string, label: string): void");
    expect(deploySource).toContain('spawnSync("bun", ["install", "--frozen-lockfile"]');
    expect(deploySource).toContain("timeout: 300_000");
    expect(deploySource).toContain("maxBuffer: 1024 * 1024 * 20");
    expect(deploySource).toContain("fatal(`bun install failed in ${label}`, installOut)");

    expectBefore(
      'installWorkspaceDependencies(worktreePath, "develop worktree")',
      'spawnSync("bun", ["test", "src/__tests__/improver.test.ts"]'
    );
    expectBefore(
      'installWorkspaceDependencies(deployWtRoot, "deploy worktree")',
      'buildDashboardBundle(deployWtRoot, "deploy worktree")'
    );
    expectBefore(
      'installWorkspaceDependencies(LIVE, "LIVE")',
      'buildDashboardBundle(LIVE, "LIVE")'
    );
  });
});
