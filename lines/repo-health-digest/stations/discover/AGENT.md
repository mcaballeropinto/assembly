---
reads: [task, input]
description: "Discovers repositories to analyze from GitHub organization or user account."
provider: script
script: discover.ts
guardrails:
  output:
    required: [summary, content, data]
    schema:
      data:
        repos: array
---

# Discover Station — Repo Health Digest

Deterministic. Given `input.repos` (an explicit array of `"owner/name"` strings)
or `input.topic` (a GitHub search topic), resolves a list of repositories to
audit and emits them under `data.repos`.

## Why script, not LLM?

Resolving a list of repos from a fixed input is cheap and deterministic.
An LLM here would be expensive, slow, and could fabricate repo names that
don't exist. Stick to code for boundary-of-system lookups like this.

## Input contract

Pass exactly one of:

```json
{ "repos": ["anthropic-sdk-python", "anthropic-sdk-typescript"] }
```

or

```json
{ "topic": "claude-sdk", "limit": 10 }
```

If `topic` is given, the script calls the GitHub search API (auth optional
via `GITHUB_TOKEN`) and returns up to `limit` repos sorted by stars.

## Output

```json
{
  "summary": "Discovered N repos to audit",
  "data": { "repos": [{ "owner": "...", "name": "...", "full_name": "..." }] }
}
```
