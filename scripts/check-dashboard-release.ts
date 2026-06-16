import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

export const DEFAULT_PUBLIC_URL = "https://assembly.14seven.dev/";
export const DEFAULT_DIST_DIR = resolve(import.meta.dir, "..", "web", "dist");
const BANNED_TEXT = [
  "shadcn/ui smoke check",
  "Chrome primitive mock wiring",
  "Header chips and page banners are rendered from mock data",
  "It works",
];
const REQUIRED_DIST_TEXT = [
  "Overview",
  "Activity",
  "Loading overview...",
  "No lines discovered.",
];

interface Options {
  distDir: string;
  publicUrl: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    distDir: process.env.ASSEMBLY_DASHBOARD_DIST_DIR
      ? resolve(process.env.ASSEMBLY_DASHBOARD_DIST_DIR)
      : DEFAULT_DIST_DIR,
    publicUrl: process.env.ASSEMBLY_DASHBOARD_PUBLIC_URL ?? null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dist") {
      const value = argv[++i];
      if (!value) throw new Error("--dist requires a path");
      options.distDir = resolve(value);
    } else if (arg === "--url") {
      const value = argv[++i];
      if (!value) throw new Error("--url requires a URL");
      options.publicUrl = value;
    } else if (arg === "--public") {
      options.publicUrl = DEFAULT_PUBLIC_URL;
    } else if (arg === "--no-public") {
      options.publicUrl = null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function assertNoBannedText(label: string, content: string): void {
  for (const banned of BANNED_TEXT) {
    if (content.includes(banned)) {
      throw new Error(`${label} contains banned placeholder text: ${banned}`);
    }
  }
}

export function assertBuiltBundle(distDir: string): void {
  const indexPath = join(distDir, "index.html");
  const assetsDir = join(distDir, "assets");

  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(`Missing built dashboard index: ${indexPath}`);
  }
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    throw new Error(`Missing built dashboard assets directory: ${assetsDir}`);
  }

  const indexHtml = readFileSync(indexPath, "utf8");
  assertNoBannedText(indexPath, indexHtml);

  const referencedAssets = getReferencedAssetNames(indexHtml);
  if (referencedAssets.length === 0) {
    throw new Error(`${indexPath} does not reference any /assets files`);
  }

  const pending = [...referencedAssets];
  const seen = new Set<string>();
  const assetContents: string[] = [];

  while (pending.length > 0) {
    const assetName = pending.shift();
    if (!assetName || seen.has(assetName)) continue;
    seen.add(assetName);

    const assetPath = join(assetsDir, assetName);
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      throw new Error(`${indexPath} references missing asset: /assets/${assetName}`);
    }

    if (/\.(css|html|js|mjs)$/i.test(assetPath)) {
      const content = readFileSync(assetPath, "utf8");
      assetContents.push(content);
      pending.push(...getNestedAssetNames(content));
    }
  }

  const assetText = assetContents.join("\n");
  if (!assetText) {
    throw new Error(`${indexPath} does not reference any readable JS/CSS assets`);
  }

  assertNoBannedText("web/dist referenced assets", assetText);

  const distText = `${indexHtml}\n${assetText}`;
  for (const required of REQUIRED_DIST_TEXT) {
    if (!distText.includes(required)) {
      throw new Error(`Built dashboard bundle is missing required text: ${required}`);
    }
  }
}

function getReferencedAssetNames(indexHtml: string): string[] {
  return [...indexHtml.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)]
    .map((match) => normalizeAssetName(match[1]))
    .filter((name): name is string => Boolean(name));
}

function getNestedAssetNames(content: string): string[] {
  return [
    ...new Set(
      [...content.matchAll(/["'`](?:\.\/|\/assets\/|assets\/)([^"'`]+\.(?:css|html|js|mjs))["'`]/gi)]
        .map((match) => normalizeAssetName(match[1]))
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

function normalizeAssetName(assetName: string | undefined): string | null {
  if (!assetName) return null;
  return assetName.replace(/^assets\//, "");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

export async function assertPublicDashboard(publicUrl: string): Promise<void> {
  const response = await fetch(publicUrl, {
    headers: { "cache-control": "no-cache" },
  });

  if (!response.ok) {
    throw new Error(`Public dashboard returned HTTP ${response.status}: ${publicUrl}`);
  }

  const body = await response.text();
  assertNoBannedText(publicUrl, body);

  const referencedAssets = getReferencedAssetNames(body);
  if (referencedAssets.length === 0) {
    throw new Error(`Public dashboard does not look like the Vite bundle: ${publicUrl}`);
  }

  const baseUrl = new URL(publicUrl);
  const pending = [...referencedAssets];
  const seen = new Set<string>();
  const assetContents: string[] = [];

  while (pending.length > 0) {
    const assetName = pending.shift();
    if (!assetName || seen.has(assetName)) continue;
    seen.add(assetName);

    const assetUrl = new URL(`/assets/${assetName}`, baseUrl).toString();
    const content = await fetchText(assetUrl);
    assetContents.push(content);
    pending.push(...getNestedAssetNames(content));
  }

  const assetText = assetContents.join("\n");
  assertNoBannedText("public dashboard assets", assetText);

  const publicText = `${body}\n${assetText}`;
  for (const required of REQUIRED_DIST_TEXT) {
    if (!publicText.includes(required)) {
      throw new Error(`Public dashboard is missing required text: ${required}`);
    }
  }
}

export async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  assertBuiltBundle(options.distDir);

  if (options.publicUrl) {
    await assertPublicDashboard(options.publicUrl);
  }

  const target = options.publicUrl ? ` and ${options.publicUrl}` : "";
  console.log(`Dashboard release check passed for ${options.distDir}${target}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
