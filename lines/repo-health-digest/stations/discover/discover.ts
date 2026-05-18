#!/usr/bin/env bun
/**
 * Resolve an input topic or explicit repo list into a normalised array
 * of { owner, name, full_name } entries for downstream stations.
 */
import { readFileSync, existsSync } from "fs";

const wpPath = process.argv[2];
if (!wpPath || !existsSync(wpPath)) {
  process.stderr.write(`workpiece path missing: argv[2]=${wpPath}\n`);
  process.exit(1);
}

const wp = JSON.parse(readFileSync(wpPath, "utf-8"));
const input = wp.input ?? {};

type Repo = { owner: string; name: string; full_name: string };

function parseFull(s: string): Repo | null {
  const m = s.match(/^([^\/\s]+)\/([^\/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], full_name: `${m[1]}/${m[2]}` };
}

let repos: Repo[] = [];

if (Array.isArray(input.repos) && input.repos.length > 0) {
  for (const r of input.repos) {
    const parsed = typeof r === "string" ? parseFull(r) : null;
    if (parsed) repos.push(parsed);
  }
} else if (typeof input.topic === "string" && input.topic.trim()) {
  const limit = Math.min(Number(input.limit) || 5, 25);
  const url = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(input.topic.trim())}&sort=stars&order=desc&per_page=${limit}`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "assembly-repo-health-digest",
  };
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    process.stderr.write(`GitHub search failed: ${resp.status} ${await resp.text()}\n`);
    process.exit(1);
  }
  const body = (await resp.json()) as { items?: Array<{ full_name?: string }> };
  for (const item of body.items ?? []) {
    if (typeof item.full_name === "string") {
      const parsed = parseFull(item.full_name);
      if (parsed) repos.push(parsed);
    }
  }
} else {
  process.stderr.write("input must include either 'repos' (array) or 'topic' (string)\n");
  process.exit(1);
}

if (repos.length === 0) {
  process.stderr.write("no repos resolved from input\n");
  process.exit(1);
}

const envelope = {
  summary: `Discovered ${repos.length} repo${repos.length === 1 ? "" : "s"} to audit`,
  content: repos.map((r) => `- \`${r.full_name}\``).join("\n"),
  data: { repos },
};

process.stdout.write(JSON.stringify(envelope) + "\n");
