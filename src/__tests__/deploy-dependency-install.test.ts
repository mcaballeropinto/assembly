import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const deploySource = readFileSync("lines/assembly-dev/stations/deploy/deploy.ts", "utf-8");
const rootPackage = JSON.parse(readFileSync("package.json", "utf-8"));
const webPackage = JSON.parse(readFileSync("web/package.json", "utf-8"));

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

  it("uses the web workspace build script so Vite plugins resolve from installed dependencies", () => {
    const rootBuildScript = rootPackage.scripts["build:web"];

    expect(rootBuildScript).toBe("bun --cwd web run build");
    expect(rootBuildScript).not.toContain("bunx");
    expect(webPackage.scripts.build).toContain("vite build");
    expect(webPackage.devDependencies["@vitejs/plugin-react"]).toBeString();
    expect(webPackage.devDependencies["@vitejs/plugin-react"].length).toBeGreaterThan(0);
  });
});
