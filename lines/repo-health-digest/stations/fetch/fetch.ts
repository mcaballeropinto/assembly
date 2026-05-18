#!/usr/bin/env bun
/**
 * Fetch GitHub metadata + recent commits + issue counts for each repo
 * resolved by the discover station.
 */
import { readFileSync, existsSync } from "fs";

const wpPath = process.argv[2];
if (!wpPath || !existsSync(wpPath)) {
  process.stderr.write(`workpiece path missing: argv[2]=${wpPath}\n`);
  process.exit(1);
}

const wp = JSON.parse(readFileSync(wpPath, "utf-8"));
const repos: Array<{ owner: string; name: string; full_name: string }> =
  wp.stations?.discover?.data?.repos ?? [];

if (repos.length === 0) {
  process.stderr.write("discover.data.repos is empty\n");
  process.exit(1);
}

const headers: Record<string, string> = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "assembly-repo-health-digest",
};
if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url} — ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

async function fetchOne(r: { owner: string; name: string; full_name: string }) {
  try {
    const meta = await fetchJSON<{
      stargazers_count?: number;
      forks_count?: number;
      archived?: boolean;
      default_branch?: string;
      license?: { spdx_id?: string } | null;
      pushed_at?: string;
    }>(`https://api.github.com/repos/${r.full_name}`);

    const commits = await fetchJSON<Array<{
      sha?: string;
      commit?: { author?: { name?: string; date?: string }; message?: string };
    }>>(`https://api.github.com/repos/${r.full_name}/commits?per_page=10`);

    const search = (q: string) =>
      fetchJSON<{ total_count?: number }>(
        `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${r.full_name} ${q}`)}`
      );
    const [issues, prs] = await Promise.all([search("is:issue is:open"), search("is:pr is:open")]);

    return {
      repo: r.full_name,
      stars: meta.stargazers_count ?? 0,
      forks: meta.forks_count ?? 0,
      archived: meta.archived === true,
      default_branch: meta.default_branch ?? "main",
      license: meta.license?.spdx_id ?? null,
      pushed_at: meta.pushed_at ?? null,
      open_issues: issues.total_count ?? 0,
      open_prs: prs.total_count ?? 0,
      recent_commits: (commits ?? []).map((c) => ({
        sha: c.sha?.slice(0, 8) ?? "",
        author: c.commit?.author?.name ?? "",
        date: c.commit?.author?.date ?? "",
        message: (c.commit?.message ?? "").split("\n")[0].slice(0, 200),
      })),
    };
  } catch (e) {
    return { repo: r.full_name, error: String(e instanceof Error ? e.message : e) };
  }
}

const fetched = [] as Array<Record<string, unknown>>;
for (const r of repos) {
  process.stderr.write(`[fetch] ${r.full_name}\n`);
  fetched.push(await fetchOne(r));
}

const okCount = fetched.filter((f) => !("error" in f)).length;
const envelope = {
  summary: `Fetched ${okCount}/${repos.length} repos`,
  content: fetched
    .map((f) => ("error" in f ? `- ❌ \`${f.repo}\`: ${f.error}` : `- ✅ \`${f.repo}\` (${f.stars}★, ${f.open_issues} issues, ${f.open_prs} PRs)`))
    .join("\n"),
  data: { fetched },
};

process.stdout.write(JSON.stringify(envelope) + "\n");
