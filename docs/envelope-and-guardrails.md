# Envelope, Guardrails, and Eval

The envelope is the contract between stations and the runner. Guardrails are how the runner enforces that contract. EVAL.md is how stations enforce quality on themselves.

Implementations:
- [`../src/envelope.ts`](../src/envelope.ts) — parse, validate, repair
- [`../src/envelope-nudge.ts`](../src/envelope-nudge.ts) — in-session repair via Anthropic SDK
- [`../src/runner.ts`](../src/runner.ts) — eval loop and retry threading

---

## The envelope

Every station, regardless of provider, returns:

```json
{
  "summary": "string — required, non-empty",
  "content": "string — optional",
  "data":    { … }   // optional object
}
```

The runner files this under `workpiece.stations[<name>]` along with bookkeeping fields (`status`, `started_at`, `finished_at`, `model`, `tokens`, `cost_usd`, `failure_class?`, `eval?`, `rounds?`).

For full schema see [`concepts.md`](./concepts.md#2-envelope).

---

## Parsing

[`parseEnvelope()`](../src/envelope.ts) is forgiving. It tries, in order:

1. **Direct `JSON.parse`** — happy path.
2. **Markdown fence extraction** — matches ` ```json … ``` ` blocks.
3. **First-brace-to-last-brace** — recovers when the model surrounds JSON with chat.

After parse it validates:
- `summary` exists, is a string, non-empty.
- `content`, if present, is a string.
- `data`, if present, is an object (not array, not primitive).

Failure throws `EnvelopeError`.

For `claude-code` and `pi` providers, the worker also writes a file at `<wp>.envelope.json` that the LLM module polls — that file is parsed the same way. See [`execution.md`](./execution.md#claude-code-invocation-in-detail) for the file-vs-stream race.

---

## Repair flow

When parsing fails, the runner tries to recover before giving up.

### Stage 1 — in-session nudge

[`envelope-nudge.ts`](../src/envelope-nudge.ts) reconstructs the message history from `<wp>.session.jsonl` and replays the last few turns through the Anthropic SDK with a strict nudge prompt. This is invoked only for `claude-code` providers where the session file exists.

If reconstruction recovers fewer than 3 messages it bails (line 141) — there's nothing to replay.

### Stage 2 — Haiku repair

The standard fallback. The runner builds a repair prompt with [`buildRepairPrompt()`](../src/envelope.ts), pointing the model at exactly what was wrong, and calls Claude Haiku via the Anthropic SDK. This is fast (sub-second) and cheap.

Configuration is per-line / per-station:

```yaml
defaults:
  repair:
    enabled: true                                    # default true
    model: claude-haiku-4-5-20251001                 # default
```

If repair succeeds → continue with the repaired envelope.
If repair fails → throw `EnvelopeError`. The orchestrator classifies as `failure_class: "envelope"`.

The repair model/tokens/cost are tracked separately and added to the station's `cost_usd`.

---

## Guardrails

Optional output validation declared in AGENT.md frontmatter:

```yaml
guardrails:
  output:
    required: [summary, data.scored_items]
    forbidden: [data.enriched_items]
    schema:
      data.scored_items:
        type: array
        minItems: 1
      data.scored_items[].tier:
        enum: [a, b, c]
      data.score:
        type: number
        minimum: 0
        maximum: 10
```

### Required

Dotted paths that must resolve to defined, non-null values in the envelope. Use this for any field downstream stations are about to read.

### Forbidden

Dotted paths that must **not** be set. Catches adjacent-task drift — e.g., a station named `score` whose prompt accidentally produces `enriched_items` (a sibling station's output shape).

### Schema

Per-path type + value checks. Two equivalent forms for the path:

```yaml
# Flat (nested objects)
schema:
  data:
    scored_items: "array"

# Dotted
schema:
  "data.scored_items": { type: array, minItems: 1 }
```

`[]` in a path iterates each element of an array. `data.scored_items[].tier` means "for every element of the array, check `.tier`".

Supported spec keys:

| Key | Meaning |
|-----|---------|
| `type` | `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"` |
| `minItems` | Array length lower bound |
| `enum` | List of allowed values (exact match) |
| `minimum`, `maximum` | Inclusive numeric range |

### Validation failure → `failure_class: "guardrail"`

A guardrail failure throws `GuardrailError`. The orchestrator classifies it as `guardrail` and applies that class's retry policy (typically a tighter budget than `crash` or `provider`). See [`reliability.md`](./reliability.md).

---

## Eval (`EVAL.md`)

When `stations/<name>/EVAL.md` is present, the runner runs a critic over the envelope after every successful station execution.

### EVAL.md frontmatter

```yaml
---
provider: api               # api | claude-code | script
model: claude-haiku-4-5-20251001
on_fail: retry              # retry | escalate | fail | warn  (default: retry)
max_retries: 2              # default: 1
script: ./check.ts          # required only when provider: script
---

# Eval prompt body
…
```

### LLM eval flow

1. Build the eval prompt: system = EVAL.md body + envelope-shape instruction; user = task + envelope.
2. Call the model.
3. Parse the response as:

   ```json
   {
     "pass": true | false,
     "feedback": "…",
     "score": 7,             // optional
     "action": "retry"|"escalate"|null
   }
   ```

   If parse fails → auto-pass with feedback `"unparseable eval response"`. This is intentional — a broken eval shouldn't block a working station.

4. Decide:
   - `pass: true` → station succeeds. `eval` block is recorded on the StationResult.
   - `pass: false` → the **response's `action`** overrides the frontmatter `on_fail` for this attempt:
     - `retry` → re-invoke the station with eval feedback embedded. Retry budget = `max_retries`.
     - `escalate` → mark station `escalated`, route workpiece to `queues/review/`, halt pipeline.
     - `fail` → throw immediately; station fails (no further eval retries).
     - `warn` → continue with current output.
   - Default when `action` is null: `on_fail` from frontmatter (default `retry`).

5. Retry budget exhausted → auto-escalate (station goes to `review/`).

### Script eval flow

Same loop, but the eval is a binary:

```bash
bun run <evalConfig.script> <tempWorkpiecePath>
```

The temp workpiece is the current workpiece with the station's envelope pre-filed under `stations[name]`. The script's stdout is parsed as `EvalResult`.

### Feedback threading on retry

For LLM stations: feedback is woven into [`buildEvalRetryPrompt`](../src/prompt.ts) — prior-station context is dropped, only a compact recap + the eval feedback go in. Cuts retry token cost by ~90%.

For script stations: the next attempt's temp workpiece is populated with `_pending_eval_feedback = { station, feedback, attempt }`. The script reads this and uses it however it wants — typically to log it or to retry differently.

---

## A worked example

Station `score` has both guardrails and EVAL.md.

```yaml
# AGENT.md
guardrails:
  output:
    required: [data.score, data.tier]
    schema:
      data.score: { type: number, minimum: 0, maximum: 10 }
      data.tier: { enum: [A, B, C] }
```

```yaml
# EVAL.md
on_fail: retry
max_retries: 1

# Body: "Reject if the rationale doesn't reference at least 2 culture signals."
```

Run-time sequence:

1. Station returns `{ summary, data: { score: 7.5, tier: "B" } }`.
2. Envelope parses cleanly.
3. Guardrails pass — `score` is in range, `tier` is in enum.
4. EVAL.md runs. The critic returns `{ pass: false, feedback: "Rationale missing culture signals", action: "retry" }`.
5. Station re-runs with `buildEvalRetryPrompt` — same system prompt, recap + feedback.
6. New envelope passes both guardrails and eval.
7. Station succeeds. The previous failed attempt is recorded under `previous_attempts[0]`.

If the retry had also failed eval, the runner would auto-escalate — the workpiece would land in `queues/review/` with `status: "escalated"`.
