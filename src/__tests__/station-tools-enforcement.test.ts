/**
 * Tests that a station's `tools:` frontmatter is actually enforced when
 * spawning the claude-code CLI. Regression: until 2026-04-20 the tools
 * field was decorative — llm.ts hardcoded the --allowedTools set, so the
 * plan station (declared tools: [Bash, Read, Glob, Grep]) still received
 * Write and Edit and tried to implement features instead of planning.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveAllowedTools,
  resolveDisallowedTools,
  DEFAULT_ALLOWED_TOOLS,
  KNOWN_BUILTIN_TOOLS,
} from "../llm";

describe("resolveAllowedTools()", () => {
  it("returns DEFAULT_ALLOWED_TOOLS when station declares no tools", () => {
    expect(resolveAllowedTools(undefined)).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it("treats `tools: []` as an explicit opt-out, NOT as a request for defaults", () => {
    // Regression guard (2026-05-18): until today, `tools: []` collapsed
    // into DEFAULT_ALLOWED_TOOLS. hello-world's greet station, declaring
    // tools:[], received auto-injected Bash and ran `git init` in the
    // repo root. An explicit empty array now means "no tools" — only
    // envelope-protocol shims are added when usingWatcher=true.
    expect(resolveAllowedTools([])).toEqual([]);
  });

  it("scopes auto-injected Bash to the envelope mv when station declared no Bash", () => {
    const envelopePath = "/tmp/envelope-scope-test.json";
    const allowed = resolveAllowedTools([], true, envelopePath);
    // Only envelope-protocol shims; both scoped to the envelope path.
    expect(allowed).toContain(`Write(${envelopePath}.tmp)`);
    expect(allowed).toContain(`Bash(mv ${envelopePath}.tmp ${envelopePath})`);
    // Crucially, unscoped Bash must not be present — that's what let the
    // greet station run `git init`.
    expect(allowed).not.toContain("Bash");
    expect(allowed).not.toContain("Write");
  });

  it("keeps station-declared Bash unscoped when explicitly listed", () => {
    const envelopePath = "/tmp/envelope-explicit-bash.json";
    const allowed = resolveAllowedTools(["Bash"], true, envelopePath);
    expect(allowed).toContain("Bash");
    // No scoped form added — the station asked for full Bash.
    expect(allowed).not.toContain(`Bash(mv ${envelopePath}.tmp ${envelopePath})`);
  });

  it("returns the station's declared tools when non-empty", () => {
    expect(resolveAllowedTools(["Read", "Grep"])).toEqual(["Read", "Grep"]);
  });

  it("enforces a planner-style restriction that excludes Write and Edit", () => {
    const planTools = ["Bash", "Read", "Glob", "Grep"];
    const resolved = resolveAllowedTools(planTools);
    expect(resolved).not.toContain("Write");
    expect(resolved).not.toContain("Edit");
    expect(resolved).not.toContain("NotebookEdit");
  });

  it("does not mutate the input array", () => {
    const input = ["Read"];
    resolveAllowedTools(input);
    expect(input).toEqual(["Read"]);
  });
});

describe("DEFAULT_ALLOWED_TOOLS", () => {
  it("includes the standard claude-code toolset", () => {
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Bash");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Read");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Write");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Edit");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Glob");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Grep");
  });
});

describe("resolveDisallowedTools()", () => {
  it("always disallows Skill, even with default tools", () => {
    expect(resolveDisallowedTools(undefined)).toContain("Skill");
  });

  it("disallows every known built-in not in the station's allowlist", () => {
    // test-scraper/scrape declared tools: [Bash, WebFetch]. The agent's
    // 2026-05-01 timeout came from drifting into Read/Glob/Agent — this is
    // the regression guard that proves those are blocked at spawn.
    const scrapeTools = ["Bash", "WebFetch"];
    const disallowed = resolveDisallowedTools(scrapeTools, true);
    for (const drift of ["Read", "Glob", "Grep", "Edit", "Agent", "TodoWrite", "ToolSearch", "RemoteTrigger", "WebSearch"]) {
      expect(disallowed).toContain(drift);
    }
    expect(disallowed).not.toContain("Bash");
    expect(disallowed).not.toContain("WebFetch");
  });

  it("does not disallow Write when the watcher path injects it", () => {
    // resolveAllowedTools auto-injects Write when usingWatcher=true.
    // The disallow list must not double-block what was just allowed.
    const disallowed = resolveDisallowedTools(["Bash"], true);
    expect(disallowed).not.toContain("Write");
    expect(disallowed).not.toContain("Bash");
  });

  it("does not disallow scoped Write when envelopePath is supplied", () => {
    // Sandbox-leak fix (2026-05-15): when envelopePath is supplied, the
    // auto-injected Write is scoped — `Write(<envelopePath>.tmp)`. The
    // disallow logic strips parens via bareToolName, so Write should still
    // count as allowed and NOT appear on the disallow list.
    const envelopePath = "/tmp/sandbox-test.json";
    const disallowed = resolveDisallowedTools(["Bash"], true, envelopePath);
    expect(disallowed).not.toContain("Write");
    expect(disallowed).not.toContain("Bash");
  });

  it("falls back to DEFAULT_ALLOWED_TOOLS when station declares none", () => {
    // No explicit tools → block Agent/Skill/CronCreate but keep Read/Edit/etc.
    const disallowed = resolveDisallowedTools(undefined);
    expect(disallowed).toContain("Agent");
    expect(disallowed).toContain("Skill");
    expect(disallowed).toContain("CronCreate");
    expect(disallowed).not.toContain("Read");
    expect(disallowed).not.toContain("Edit");
  });

  it("treats parameterized allowlist entries by their bare name", () => {
    // `Bash(git *)` should mark Bash as allowed; the disallow list must not
    // re-include Bash just because of the parens.
    const disallowed = resolveDisallowedTools(["Bash(git *)", "WebFetch"], true);
    expect(disallowed).not.toContain("Bash");
  });
});

describe("KNOWN_BUILTIN_TOOLS", () => {
  it("covers the drift tools observed in the 2026-05-01 timeout incident", () => {
    for (const t of ["Read", "Glob", "Grep", "Edit", "Agent", "TodoWrite", "ToolSearch", "RemoteTrigger", "WebSearch", "Skill"]) {
      expect(KNOWN_BUILTIN_TOOLS).toContain(t);
    }
  });
});
