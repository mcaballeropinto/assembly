---
reads: [task, greet]
provider: script
script: record.ts
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        log_path: string
        appended: boolean
---

# Record Station — Hello World

Deterministic script station. Appends the greeting from the upstream
`greet` station to a markdown log file.

## Why a script provider here?

Filesystem appends and timestamping are pure code — there's no judgement
to make. Doing this in an LLM station would be wasteful, slow, and
non-deterministic. Pairing a creative station (`greet`) with a
deterministic one (`record`) is a common Assembly pattern.

## Input

Reads the upstream `greet.data.greeting` and `greet.data.recipient`.

## Output

Appends one entry to `lines/hello-world/greetings.md` (created if absent)
with a timestamp, recipient, and greeting text. Emits an envelope with
`log_path` and `appended: true`.
