# Data Flow — How Input/Output Actually Works

## The Standard Envelope

Every station returns the same JSON shape. No exceptions.

```json
{
  "summary": "One-line description (required)",
  "content": "Full text output (optional)",
  "data": { "structured": "fields (optional)" }
}
```

The runner takes this envelope and files it into the workpiece under `stations.<name>`.
The station doesn't touch the workpiece — the runner does all the plumbing.

---

## Step-by-Step Trace

```bash
assembly run lines/content-pipeline \
  --task "Write a post about AI agents" \
  --input '{"tone": "casual"}'
```

### Step 0: Runner creates the workpiece

```
runs/2026-04-04T10-30-00-content-pipeline/workpiece.json
```

```json
{
  "id": "run_2026-04-04T10-30-00",
  "line": "content-pipeline",
  "task": "Write a post about AI agents",
  "input": { "tone": "casual" },
  "stations": {}
}
```

---

### Step 1: `research` runs

**Runner builds the LLM call:**

```
┌─ SYSTEM ──────────────────────────────────────────────┐
│ [body of research/AGENT.md]                           │
│                                                       │
│ You MUST respond with valid JSON:                     │
│ {                                                     │
│   "summary": "one-line description (required)",       │
│   "content": "full text output (optional)",           │
│   "data": { structured fields (optional) }            │
│ }                                                     │
└───────────────────────────────────────────────────────┘

┌─ USER ────────────────────────────────────────────────┐
│ # Task                                                │
│ Write a post about AI agents                          │
│                                                       │
│ # Input                                               │
│ {"tone": "casual"}                                    │
│                                                       │
│ # Previous Stations                                   │
│ (none)                                                │
│                                                       │
│ Produce your output now.                              │
└───────────────────────────────────────────────────────┘
```

**LLM responds:**
```json
{
  "summary": "Compiled 12 sources on AI agent trends for 2026",
  "content": "## Key Findings\n- AI agent frameworks grew 3x...\n- 78% of devs...",
  "data": { "source_count": 12, "confidence": "high", "top_topics": ["frameworks", "adoption", "cost"] }
}
```

**Runner validates:**
- ✅ Has `summary`? Yes.
- ✅ Valid JSON? Yes.
- ✅ Guardrails pass? (if defined) Yes.

**Runner writes to workpiece:**
```json
"stations": {
  "research": {
    "status": "done",
    "summary": "Compiled 12 sources on AI agent trends for 2026",
    "content": "## Key Findings\n- AI agent frameworks grew 3x...",
    "data": { "source_count": 12, "confidence": "high", "top_topics": ["frameworks", "adoption", "cost"] },
    "started_at": "2026-04-04T10:30:01Z",
    "finished_at": "2026-04-04T10:30:08Z",
    "model": "claude-sonnet-4-20250514",
    "tokens": { "in": 420, "out": 1250 }
  }
}
```

**Runner saves workpiece.json to disk.** ← checkpoint.

---

### Step 2: `draft` runs

**Runner builds the LLM call — now with prior context:**

```
┌─ SYSTEM ──────────────────────────────────────────────┐
│ [body of draft/AGENT.md]                              │
│                                                       │
│ You MUST respond with valid JSON:                     │
│ { "summary": "...", "content": "...", "data": {} }    │
└───────────────────────────────────────────────────────┘

┌─ USER ────────────────────────────────────────────────┐
│ # Task                                                │
│ Write a post about AI agents                          │
│                                                       │
│ # Input                                               │
│ {"tone": "casual"}                                    │
│                                                       │
│ # Previous Stations                                   │
│                                                       │
│ ## research                                           │
│ **Summary:** Compiled 12 sources on AI agent trends   │
│                                                       │
│ **Content:**                                          │
│ ## Key Findings                                       │
│ - AI agent frameworks grew 3x in 2025                 │
│ - 78% of devs have tried at least one...              │
│                                                       │
│ **Data:** source_count=12, confidence=high            │
│                                                       │
│ ---                                                   │
│ Produce your output now.                              │
└───────────────────────────────────────────────────────┘
```

**LLM responds:**
```json
{
  "summary": "Wrote 800-word casual blog post targeting developers",
  "content": "# AI Agents Are Eating Software\n\nIn 2026, if you're not using...",
  "data": { "word_count": 823, "reading_time": "4 min" }
}
```

**Runner validates, writes to workpiece, saves to disk.**

---

### Step 3: `review` runs

Same pattern. Gets research + draft in "Previous Stations". Returns:

```json
{
  "summary": "Approved with 2 minor suggestions",
  "data": {
    "approved": true,
    "score": 8,
    "issues": ["Tighten the intro", "Add a CTA"]
  }
}
```

Note: no `content` field. This station is data-heavy, not text-heavy. The envelope
accommodates both styles.

---

### Step 4: `publish` runs (with gate)

If the line has a gate before publish:

```yaml
sequence:
  - research
  - draft
  - review
  - gate:
      check: review.data.approved
      if_true: publish
      if_false: revise
  - publish
```

The runner checks `workpiece.stations.review.data.approved`.
- If `true` → proceeds to `publish`
- If `false` → jumps to `revise` station instead

This works because `data` is always structured JSON. The runner just reads a path.

---

## Context Modes — Controlling Token Usage

As lines get longer, you don't want every station seeing every prior station's
full output. Three strategies:

### Mode 1: `full` (default)

Every station sees all prior summaries + content + data.
Good for short lines (2-4 stations).

### Mode 2: `summary`

Every station sees all prior **summaries only**. Content and data are omitted
from the prompt unless explicitly requested.

```
# Previous Stations
- research: Compiled 12 sources on AI agent trends for 2026
- draft: Wrote 800-word casual blog post targeting developers
```

This is much more token-efficient. The summary field exists specifically
for this purpose.

### Mode 3: `explicit reads`

Each station declares exactly what it needs in its AGENT.md frontmatter:

```yaml
---
reads: [task, input, research.content, draft.summary]
---
```

The runner only includes those specific fields in the prompt. Everything else
is omitted. Most efficient for long lines (5+ stations).

**This is why `summary` is required.** It's the compressed representation
that lets downstream stations get context without reading full outputs.

---

## Failure Handling

### Station Fails to Return Valid JSON

The runner retries once with a repair prompt:
```
Your previous response was not valid JSON. Here's what you returned:
[raw response]

Please return valid JSON with at minimum a "summary" field.
```

If retry fails → `status: "failed"`, raw response saved in `content`.

### Station Fails (Model Error / Timeout)

1. Try fallback model (if configured)
2. If all models fail → `status: "failed"`, error saved in `data.error`
3. Workpiece is saved (checkpoint) — can resume later

### Guardrail Validation Fails

1. Retry with specific feedback: "Your output is missing required field X"
2. If retry fails → `status: "failed"`, validation errors in `data.validation_errors`

---

## Summary

```
 CONCEPT              WHAT                    WHERE
────────────────────────────────────────────────────────
 Envelope             { summary, content,     Every station returns this
                        data }

 Workpiece            Accumulation of all     runs/.../workpiece.json
                      envelopes + metadata

 Prompt Construction  System = AGENT.md       Runner builds this
                      User = task + input
                      + previous stations

 Context Control      full / summary /        line.yaml or AGENT.md
                      explicit reads          frontmatter

 Checkpointing        Save after each         workpiece.json on disk
                      station

 Validation           JSON parse + required   Runner checks after each
                      fields + optional       station responds
                      schema
```

The workpiece is a **file**. You can `cat` it, `jq` it, `git diff` it,
email it, pipe it. No databases, no message queues, no hidden state.
