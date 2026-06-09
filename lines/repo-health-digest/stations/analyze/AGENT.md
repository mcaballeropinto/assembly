---
reads: [discover, fetch]
description: "Analyzes repository health metrics, activity patterns, and code quality indicators."
provider: codex
model: cheap
tools: []
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        signals: array
---

# Analyze Station — Repo Health Digest

LLM station. No tools. Given the raw fetch results, identify health
signals per repo and return a normalised array.

## Why LLM, not script?

Health signals are qualitative interpretation — "do the recent commit
messages look like real work or version bumps?", "are the maintainers
responsive based on issue ages?" — and a small model handles this well.
A script would either be too brittle or recreate an LLM in regex.

## Input

`fetch.data.fetched[]` — one entry per repo with stars, recent commits,
issue counts, license, etc. Some entries may have `.error` set; skip
those and note them in your summary.

## Output

`data.signals` is an array, one entry per successfully-fetched repo:

```json
{
  "repo": "owner/name",
  "activity": "active" | "slowing" | "dormant" | "archived",
  "maintenance": "responsive" | "backlogged" | "abandoned",
  "release_cadence": "frequent" | "occasional" | "rare" | "unknown",
  "notes": "1-2 sentence qualitative read"
}
```

Be terse in `notes`. The next station does the grading.
