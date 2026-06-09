---
reads: [discover, fetch, analyze]
description: "Scores repository health on multiple dimensions and identifies priority issues."
provider: codex
model: cheap
tools: []
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        scores: array
---

# Score Station — Repo Health Digest

LLM station with an `EVAL.md` gate. Combines the qualitative signals
from `analyze` with the quantitative numbers from `fetch` into a letter
grade per repo.

## Output

`data.scores[]`:

```json
{
  "repo": "owner/name",
  "grade": "A" | "B" | "C" | "D" | "F",
  "score": 0-100,
  "rationale": "1-2 sentences citing concrete signals"
}
```

## Rubric

- **A (90-100)** — active commits in last 30 days, low issue backlog,
  recent releases, responsive maintainers.
- **B (75-89)** — active in last 90 days, some backlog, sporadic releases.
- **C (60-74)** — quiet, growing backlog, but not abandoned.
- **D (40-59)** — mostly dormant; last commit > 6 months, large backlog.
- **F (0-39)** — archived, abandoned, or no commits in > 1 year.

`rationale` must cite at least one concrete number (commit dates, issue
counts, etc.) — pure vibes will fail the eval.
