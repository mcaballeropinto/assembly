import { existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { spawnSync } from "child_process";
import { loadEnvFiles } from "./paths";

export function bootstrapStationEnv(): void {
  loadEnvFiles();
}

function gitRoot(candidate: string): string | null {
  const r = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

function isAssemblyRepo(candidate: string): boolean {
  return (
    existsSync(resolvePath(candidate, "package.json")) &&
    existsSync(resolvePath(candidate, "src", "cli.ts")) &&
    existsSync(resolvePath(candidate, "lines", "assembly-dev", "line.yaml"))
  );
}

export function resolveAssemblyRepoRoot(stationDir: string): string {
  const candidates = [
    process.env.ASSEMBLY_REPO_ROOT,
    resolvePath(stationDir, "../../../.."),
    "/root/assembly",
    "/srv/assembly",
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  const inspected: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolvePath(candidate);
    inspected.push(resolved);
    const root = gitRoot(resolved) ?? resolved;
    if (isAssemblyRepo(root)) return root;
  }

  throw new Error(
    `ASSEMBLY_REPO_ROOT must point at the cloned assembly repo root. ` +
      `Checked: ${[...new Set(inspected)].join(", ")}`
  );
}
