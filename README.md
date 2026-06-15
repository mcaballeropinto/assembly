# Assembly

Folder-driven agent workflows. You describe a pipeline as directories on disk,
and a daemon runs it.

```
lines/repo-health-digest/
  line.yaml                          ← the sequence
  stations/
    discover/    AGENT.md   discover.ts   ← deterministic script
    fetch/       AGENT.md   fetch.ts      ← deterministic script
    analyze/     AGENT.md                 ← LLM (Sonnet)
    score/       AGENT.md   EVAL.md       ← LLM + eval gate (Haiku)
    report/      AGENT.md   report.ts     ← deterministic script
```

That's the whole interface. `ls` shows the pipeline. `cat AGENT.md` is the
system prompt. There's no DAG file, no orchestration DSL, no hidden database.

## What's in here

- `src/` — the framework (CLI, runner, daemon, dashboard API server, envelope contract, queues)
- `web/` — the React + shadcn live dashboard served by the Bun dashboard server
- `lines/` — three example pipelines you can read or run
  - `hello-world` — smallest possible line (LLM + script)
  - `repo-health-digest` — five-station GitHub-repo grader with an EVAL gate
  - `assembly-dev` — meta-line that evolves Assembly itself in a git worktree
- `docs/` — the manual; start with [`docs/README.md`](./docs/README.md)
- `DESIGN.md`, `DATA-FLOW.md` — the conceptual model

## Install

Requires [Bun](https://bun.sh) (the runtime + bundler this project depends on).
Run installs from the repository root; Bun installs the root package and the `web/` workspace together.

```bash
bun install
bun run build:web       # build web/dist when missing or after dashboard changes
./install.sh             # builds `assembly` and drops it in ~/.local/bin
```

Global installs and publishes ship the prebuilt `web/dist/` dashboard bundle, so
users do not need a local frontend build step after installation.

Or run uncompiled:

```bash
bun run src/cli.ts --help
```

## Run something

```bash
# Copy .env.example to .env and set ANTHROPIC_API_KEY first
cp .env.example .env

# Start the daemon
assembly daemon start

# Try the smallest line
assembly enqueue hello-world --task "Greet a new contributor"

# Or the multi-station example
assembly enqueue repo-health-digest \
  --task "Audit Anthropic SDKs" \
  --input '{"repos":["anthropics/anthropic-sdk-python","anthropics/anthropic-sdk-typescript"]}'

# Watch progress
assembly dashboard --port 4111
# → serves the built dashboard at http://localhost:4111
```

If you're running from a source checkout and `web/dist/` is missing, run
`bun run build:web` before starting the dashboard.

## The model in 30 seconds

Four nouns:

1. **Line** — a folder with `line.yaml` and a `stations/` subdir. The yaml lists the sequence.
2. **Station** — a folder with `AGENT.md` (frontmatter + system prompt). Optionally `EVAL.md`. Optionally a `script.ts` for deterministic stations.
3. **Workpiece** — a JSON file accumulating results as it moves through the stations.
4. **Envelope** — the standard return shape every station produces: `{ summary, content, data }`.

Read [`docs/concepts.md`](./docs/concepts.md) for the longer version.

## Why this exists

Most agent frameworks are a Python library wrapping a graph of nodes. That's
fine until you want to: pause a running pipeline, retry one stage from a
checkpoint, hand a teammate a single prompt to edit, swap a flaky LLM stage
for a deterministic script, or just `grep` the system prompt that produced
yesterday's output.

Assembly answers all of those by keeping the pipeline as plain files. Edits
are PRs, retries are file moves, and inspection is `cat`.

## Status

This is a personal tool released as open source. It works for the
author's use cases on Linux + Bun. Expect rough edges, especially around
the systemd integration in `assembly-dev` and the `claude-code-cached`
provider's dependency on the Claude Code CLI. PRs welcome.

## License

MIT. See [LICENSE](./LICENSE).
