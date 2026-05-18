---
reads: [discover]
provider: script
script: fetch.ts
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        fetched: array
---

# Fetch Station — Repo Health Digest

Deterministic. For each repo from `discover.data.repos`, pulls:

- Repo metadata: stars, forks, archived flag, default branch, license
- Most recent 10 commits (with author, date, message)
- Open issue/PR counts (split via `is:issue` vs `is:pr`)

Stores per-repo results under `data.fetched[]`. Failures on individual
repos are captured as `data.fetched[].error` rather than failing the
whole station — the downstream `analyze` station will just note them.

## Auth

Optional `GITHUB_TOKEN` env var. Without it you get rate-limited at 60
req/hr per IP — fine for an example, painful for production.
