# Cost Accounting and Station Memory

Two related observability features: how Assembly tracks token cost across runs, and how stations persist learnings between runs.

Implementations:
- [`../src/pricing.ts`](../src/pricing.ts) — model pricing table
- [`../src/usage.ts`](../src/usage.ts) — provider usage snapshot
- [`../src/usage-snapshot.ts`](../src/usage-snapshot.ts) — reads `~/.assembly/usage-status.json`
- [`../src/memory.ts`](../src/memory.ts) — station memory loading + writing
- [`../src/prompt.ts`](../src/prompt.ts) — memory injection into prompts

---

## Cost tracking

Every LLM call returns `tokens: { in, out, cache_read?, cache_creation? }`. [`pricing.ts`](../src/pricing.ts) converts to USD using:

```
cost = (base_in / 1M) * input_price
     + (cache_read / 1M) * input_price * 0.10            # cached reads are 10% of input
     + (cache_creation / 1M) * input_price * 1.25        # cache writes are 125% of input
     + (out / 1M) * output_price
```

Model pricing (per million tokens, input / output):

| Model | Input | Output |
|-------|-------|--------|
| Opus 4 / 4.6 / 4.7 | $15 | $75 |
| Sonnet 4 / 4.6 / 4.7 | $3 | $15 |
| Haiku 4.5 | $0.80 | $4 |

Pricing for unknown model ids falls back to "best guess based on prefix" with a warning logged.

### Where costs accumulate

| Granularity | Field | Implementation |
|-------------|-------|----------------|
| Per LLM call | `LLMResponse.cost_usd` | computed in `llm.ts` |
| Per station | `workpiece.stations[name].cost_usd` | summed across the main call + repair + eval |
| Per eval | `workpiece.stations[name].eval.cost_usd` | tracked separately |
| Per workpiece | `workpiece.totals.cost_usd` | summed across stations |
| Per session (dashboard) | `/api/usage` `sessionTotals.cost_usd` | walks `queues/done|error|review/` |
| Per station (dashboard) | `sessionTotals.byStation[name]` | rolled up across all completed workpieces |

### Token attribution

The same fan-out as cost — every step that calls a model contributes:

- **Main station call** → `stations[name].tokens`
- **Envelope repair (Haiku)** → added to the same `stations[name]` (recorded as a separate sub-attempt internally)
- **Eval LLM call** → `stations[name].eval.tokens`
- **Eval retry** → on the new attempt's main call; the prior attempt is preserved in `previous_attempts[]`

If the stream dies before the final `result` event, the worker uses approximate token counts (counting chunks already received) and logs a warning. This lets cost reporting degrade gracefully rather than zero-out on hangs.

### Cache awareness

For `claude-code` and `claude-code-cached`, prompt caching is critical to keeping costs low on retries.

- Use `claude-code-cached` when the system prompt is large and stable. It moves dynamic instructions out of the system message into the user message, preserving the cache key.
- Eval retries explicitly use `buildEvalRetryPrompt` which keeps the system byte-identical, so the cache hit on retry is large.
- Memory injection appends to the system prompt — adding new memory invalidates the cache, so don't churn `memory/MEMORY.md` mid-run.

---

## Provider usage / quota

`~/.assembly/usage-status.json` is written by the orchestrator's usage poller (when configured) and contains provider-side quota state:

```json
{
  "paused": false,
  "threshold": "warn",
  "pauseReason": null,
  "providers": {
    "anthropic": { "remaining": 0.42, "reset_at": "2026-05-14T03:00:00Z" }
  }
}
```

The dashboard surfaces this. The orchestrator uses it as a **gate** — when `paused: true`, new worker spawns are blocked at the line level and a resume poll re-checks every 60s.

---

## Station memory

A station can keep persistent notes between runs at `stations/<name>/memory/MEMORY.md`.

### Loading

[`loadMemory(stationDir)`](../src/memory.ts) at station construction:
- Reads `memory/MEMORY.md` if present.
- Strips frontmatter via `gray-matter`.
- Returns the body string.
- Warns at >8000 chars (≈2000 tokens) — keep it tight.

### Injection into prompts

[`buildSystemMessage`](../src/prompt.ts) appends:

```
<AGENT.md body>

# Station Memory
<body of memory/MEMORY.md>

You MUST respond with valid JSON…
```

For `claude-code` providers, an extra instruction tells the agent it can write additional `.md` files into the `memory/` directory. The directory path is exposed as `station.memoryDir`.

### Writing — automatic eval logging

When EVAL.md fails, the runner appends the failure to `stations/<name>/memory/eval-feedback.md` via [`writeEvalToMemory`](../src/memory.ts). This is append-only — every eval failure leaves a trail. The runner also updates `MEMORY.md`'s "Eval Improvements" section with a one-line index entry (date + summary).

### Writing — agent-initiated

For `claude-code` stations, the agent can write into `memory/` as part of its tool use. Common patterns:

- `memory/learned-patterns.md` — outcomes worth remembering long-term.
- `memory/seen-domains.json` — dedup index, written by the agent itself.
- Anything else useful — the directory is the agent's persistent notepad.

The runner doesn't enforce structure. The convention is that `MEMORY.md` is the human-readable index and indexes other `.md` files in the directory.

### Memory sections (the convention)

```markdown
# Memory

## Operational Notes
- GitHub search API caps `per_page` at 100; paginate with `&page=`.
- The `recent_commits` endpoint returns short SHAs only with `?per_page=` set.

## Learned Patterns
- 2026-04-12: dormant-but-archived repos are graded F, not D.

## Eval Improvements
- 2026-04-22: tightened rubric to require rationale citing concrete numbers.
```

These three section headers are recognized by [`updateMemoryIndex()`](../src/memory.ts) → `categoryToHeader()` and auto-maintained when eval feedback is appended.

---

## Cost-saving patterns

1. **Use `claude-code-cached` for large-system-prompt stations.** Big AGENT.md + lots of retries → cache hits save 90% of input cost.
2. **Use `explicit reads` for late-stage stations.** A station 6 deep in a line doesn't need station 1's full content — list just what it reads.
3. **Use `script` provider for deterministic work.** Source discovery, API calls with structured responses, aggregation, dedup — none of those need an LLM. See `discover`, `fetch`, and `report` in `lines/repo-health-digest/` for examples.
4. **Eval with Haiku, not Sonnet.** Most eval prompts are "did this output meet the rubric?" — Haiku is fast enough and 1/4 the cost.
5. **Set tight `max_wall_clock`.** A drifting agent can burn $10 chasing a hallucination. Pin the ceiling at twice the longest legitimate run.
6. **Avoid `context: full` past 3 stations.** It re-sends the entire workpiece in every prompt. Switch to `summary` or `explicit`.
