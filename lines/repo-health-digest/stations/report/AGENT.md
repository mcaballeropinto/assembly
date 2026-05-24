---
reads: [discover, fetch, analyze, score]
description: "Generates a comprehensive health digest report in markdown format."
provider: script
script: report.ts
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        digest_path: string
---

# Report Station — Repo Health Digest

Deterministic. Aggregates everything upstream into a single markdown
digest under `lines/repo-health-digest/digests/<timestamp>.md`.

## Format

```markdown
# Repo Health Digest — <ISO timestamp>

| Repo | Grade | Score | Stars | Issues | Last commit |
|------|-------|-------|-------|--------|-------------|
| ...  | A     | 92    | 1.2k  | 14     | 2026-05-12  |

## Per-repo notes
### owner/name (A — 92)
<rationale + analyze.notes>
- last commit: ...
- open issues: ...
```

The digest path is returned in `data.digest_path` so a downstream
hook (or `on_complete`) can email/post it.
