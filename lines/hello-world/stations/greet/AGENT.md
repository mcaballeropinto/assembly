---
reads: [task]
description: "Writes a short greeting based on the task description."
provider: claude-code
model: cheap
tools: []
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        greeting: string
        recipient: string
---

# Greet Station — Hello World

Produce a short greeting envelope. **This is not a chat reply — you must
write a JSON envelope file using the Write tool, then mv it into place
using the Bash tool. A plain-text reply is a station failure.** See the
Envelope Contract in your system prompt for the exact write protocol.

## Input

`task` is a free-form string describing who or what to greet
(e.g. "Greet the new contributor opening their first PR").

## Output

The envelope file you write must be a JSON object with:

- `summary` — one short line, e.g. `"Greeted the new contributor"`
- `content` — the greeting itself, 1-3 sentences in markdown
- `data.greeting` — the same greeting text, plain string (no markdown)
- `data.recipient` — short slug or name extracted from the task

## Notes

You have only two tools, both scoped to the envelope path:

- `Write(<envelope>.tmp)` — write the JSON envelope to the tmp path
- `Bash(mv <envelope>.tmp <envelope>)` — atomically rename it into place

No Read, no Edit, no Glob, no Grep, no Skill, no Agent. The greeting is
derived from the task text alone — there is nothing else to look at.
