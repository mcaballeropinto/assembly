#!/usr/bin/env bun
/**
 * Aggregate fetch + analyze + score into a single markdown digest.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const wpPath = process.argv[2];
if (!wpPath || !existsSync(wpPath)) {
  process.stderr.write(`workpiece path missing: argv[2]=${wpPath}\n`);
  process.exit(1);
}

const wp = JSON.parse(readFileSync(wpPath, "utf-8"));
const fetched: any[] = wp.stations?.fetch?.data?.fetched ?? [];
const signals: any[] = wp.stations?.analyze?.data?.signals ?? [];
const scores: any[] = wp.stations?.score?.data?.scores ?? [];

const byRepo = new Map<string, Record<string, any>>();
for (const f of fetched) byRepo.set(f.repo, { fetch: f });
for (const s of signals) {
  const e = byRepo.get(s.repo) ?? {};
  e.analyze = s;
  byRepo.set(s.repo, e);
}
for (const s of scores) {
  const e = byRepo.get(s.repo) ?? {};
  e.score = s;
  byRepo.set(s.repo, e);
}

const ordered = Array.from(byRepo.entries()).sort(
  (a, b) => (b[1].score?.score ?? 0) - (a[1].score?.score ?? 0)
);

const lines: string[] = [];
const ts = new Date().toISOString();
lines.push(`# Repo Health Digest — ${ts}`, "");
lines.push("| Repo | Grade | Score | Stars | Issues | Last commit |");
lines.push("|------|-------|-------|-------|--------|-------------|");

for (const [repo, e] of ordered) {
  const f = e.fetch ?? {};
  const sc = e.score ?? {};
  if (f.error) {
    lines.push(`| \`${repo}\` | — | — | — | — | fetch error |`);
    continue;
  }
  const lastCommit = (f.recent_commits ?? [])[0]?.date?.slice(0, 10) ?? "—";
  lines.push(
    `| \`${repo}\` | ${sc.grade ?? "—"} | ${sc.score ?? "—"} | ${f.stars ?? "—"} | ${f.open_issues ?? "—"} | ${lastCommit} |`
  );
}

lines.push("", "## Per-repo notes", "");
for (const [repo, e] of ordered) {
  const f = e.fetch ?? {};
  const a = e.analyze ?? {};
  const sc = e.score ?? {};
  lines.push(`### ${repo} (${sc.grade ?? "—"} — ${sc.score ?? "—"})`, "");
  if (f.error) {
    lines.push(`- fetch error: ${f.error}`, "");
    continue;
  }
  if (sc.rationale) lines.push(`- **Rationale:** ${sc.rationale}`);
  if (a.notes) lines.push(`- **Analyst notes:** ${a.notes}`);
  if (a.activity) lines.push(`- **Activity:** ${a.activity}`);
  if (a.maintenance) lines.push(`- **Maintenance:** ${a.maintenance}`);
  lines.push(`- ${f.stars} stars, ${f.open_issues} open issues, ${f.open_prs} open PRs`);
  lines.push(`- License: ${f.license ?? "unknown"} · Default branch: ${f.default_branch}`);
  lines.push("");
}

const outDir = resolve(import.meta.dir, "..", "..", "digests");
mkdirSync(outDir, { recursive: true });
const digestPath = resolve(outDir, `${ts.replace(/[:.]/g, "-")}.md`);
writeFileSync(digestPath, lines.join("\n"));

const envelope = {
  summary: `Wrote digest for ${ordered.length} repos to ${digestPath}`,
  content: lines.slice(0, 30).join("\n") + "\n\n…(truncated; full digest on disk)",
  data: { digest_path: digestPath, repo_count: ordered.length },
};

process.stdout.write(JSON.stringify(envelope) + "\n");
