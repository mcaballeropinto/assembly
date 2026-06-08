---
provider: claude-code
model: cheap
on_fail: retry
max_retries: 2
---

# Score Eval — Repo Health Digest

You are auditing the `score` station's output against the rubric in its
`AGENT.md`. Cheap model, strict checklist.

## Checks

For each entry in `score.data.scores`:

1. `grade` is one of `A`, `B`, `C`, `D`, `F`.
2. `score` is an integer in 0-100.
3. The `score` value falls inside the band implied by `grade`:
   - A: 90-100, B: 75-89, C: 60-74, D: 40-59, F: 0-39.
4. `rationale` is non-empty AND cites at least one concrete number
   from the `fetch` or `analyze` data (a date, a count, a percentage).
   Pure prose without numbers fails.
5. Every repo in `fetch.data.fetched[]` that did NOT have `.error` set
   has a corresponding entry in `score.data.scores`. No silent drops.

## Output

```json
{
  "pass": true | false,
  "feedback": "If failing: list each repo that failed and why. Include the exact field path and the value you saw, so the score station can retry against your feedback.",
  "action": "retry" | "escalate"
}
```

Set `action: retry` for fixable issues (missing rationale, wrong band).
Set `action: escalate` if the input data is so broken that no score is
possible (e.g., empty `fetch.data.fetched`).
