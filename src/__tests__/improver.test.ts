import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadImproverConfig, IMPROVER_DEFAULTS, isHardExcluded } from "../improver/config";
import { ImproverState } from "../improver/state";
import {
  sanitizeNeutral,
  containsCliInvocation,
  normalizeSlug,
  parseVerdict,
  buildAssessmentMessages,
  guardedDownstreamSuccessVerdict,
  VerdictParseError,
  type AssessmentVerdict,
} from "../improver/assess";
import { normalizeDiscordTarget, truncateForDiscord } from "../improver/discord";
import {
  enqueueDevTask,
  devTaskStillPresent,
  requeueDoneWorkpiece,
  requeueSource,
} from "../improver/devline";
import { startImproverWatcher, type ImproverWatcherHandle } from "../improver/watcher";
import { isEmitted, _resetCacheForTests } from "../emit-manifest";

const TEMP_ROOT = resolve("/tmp", `improver-test-${process.pid}`);
let caseId = 0;
let tempDir: string;

function makeLine(name: string): string {
  const linePath = resolve(tempDir, "lines", name);
  for (const bucket of ["inbox", "held", "done", "error", "review"]) {
    mkdirSync(resolve(linePath, "queues", bucket), { recursive: true });
  }
  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: ${name}\nsequence:\n  - work\n`
  );
  const stationDir = resolve(linePath, "stations", "work");
  mkdirSync(stationDir, { recursive: true });
  writeFileSync(resolve(stationDir, "AGENT.md"), `---\nreads: [task]\n---\n\nDo the work for ${name}.\n`);
  for (const sub of ["inbox", "processing", "output"]) {
    mkdirSync(resolve(stationDir, "queue", sub), { recursive: true });
  }
  return linePath;
}

function makeGuardedProspectorLine(name: string): string {
  const linePath = resolve(tempDir, "lines", name);
  for (const bucket of ["inbox", "held", "done", "error", "review"]) {
    mkdirSync(resolve(linePath, "queues", bucket), { recursive: true });
  }
  writeFileSync(
    resolve(linePath, "line.yaml"),
    `name: ${name}\nsequence:\n  - score\n  - push-to-attio\n`
  );
  for (const station of ["score", "push-to-attio"]) {
    const stationDir = resolve(linePath, "stations", station);
    mkdirSync(stationDir, { recursive: true });
    for (const sub of ["inbox", "processing", "output"]) {
      mkdirSync(resolve(stationDir, "queue", sub), { recursive: true });
    }
  }
  writeFileSync(
    resolve(linePath, "stations", "score", "AGENT.md"),
    [
      "---",
      "guardrails:",
      "  output:",
      "    required:",
      "      - data.scored_companies",
      "---",
      "",
      "Score companies.",
    ].join("\n")
  );
  writeFileSync(resolve(linePath, "stations", "push-to-attio", "AGENT.md"), "---\n---\n\nPush to Attio.\n");
  return linePath;
}

function writeWorkpiece(
  linePath: string,
  bucket: "done" | "error",
  id: string,
  extra: Record<string, unknown> = {}
): string {
  const fileName = `${id}.json`;
  const wp = {
    id,
    schema_version: 1,
    line: linePath.split("/").pop(),
    task: "Fetch listings and score them",
    input: {},
    stations: {
      work: {
        status: bucket === "error" ? "failed" : "done",
        summary: bucket === "error" ? "Failed: fetch timed out" : "Scored 12 listings",
        started_at: "2026-06-11T00:00:00.000Z",
        finished_at: "2026-06-11T00:01:00.000Z",
        ...(bucket === "error" ? { failure_class: "timeout" } : {}),
      },
    },
    ...extra,
  };
  writeFileSync(resolve(linePath, "queues", bucket, fileName), JSON.stringify(wp, null, 2));
  return fileName;
}

const NO_ACTION: AssessmentVerdict = {
  outcome: "success",
  should_improve: false,
  confidence: "low",
  target_station: null,
  issue_slug: "nothing",
  title: "",
  task_body: "",
  requeue_after_fix: false,
  reasoning: "all fine",
};

function proposeVerdict(slug: string, overrides: Partial<AssessmentVerdict> = {}): AssessmentVerdict {
  return {
    outcome: "failure",
    should_improve: true,
    confidence: "high",
    target_station: "work",
    issue_slug: slug,
    title: `Fix ${slug}`,
    task_body: `The work station of this line shows repeated timeouts. Update lines/<line>/stations/work/AGENT.md to harden the fetch instructions.`,
    requeue_after_fix: true,
    reasoning: "repeated timeout with specific evidence",
    ...overrides,
  };
}

beforeEach(() => {
  caseId++;
  tempDir = resolve(TEMP_ROOT, `case-${caseId}`);
  mkdirSync(tempDir, { recursive: true });
  _resetCacheForTests();
});

afterEach(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

// ─── config ──────────────────────────────────────────────────────────

describe("loadImproverConfig", () => {
  test("returns defaults when config file is missing", () => {
    const cfg = loadImproverConfig(resolve(tempDir, "nope.yaml"));
    expect(cfg).toEqual(IMPROVER_DEFAULTS);
    expect(cfg.enabled).toBe(false);
  });

  test("parses the improver section and falls back on bad values", () => {
    const path = resolve(tempDir, "config.yaml");
    writeFileSync(
      path,
      [
        "line_dirs:",
        "  - /somewhere",
        "improver:",
        "  enabled: true",
        "  model: haiku",
        "  dev_line: my-dev",
        "  exclude_lines: [hello-world, 42]",
        "  max_open_proposals: 5",
        "  max_dev_task_retries: 3",
        "  sweep_interval_minutes: -3",
      ].join("\n")
    );
    const cfg = loadImproverConfig(path);
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("haiku");
    expect(cfg.devLine).toBe("my-dev");
    expect(cfg.excludeLines).toEqual(["hello-world"]);
    expect(cfg.maxOpenProposals).toBe(5);
    expect(cfg.maxDevTaskRetries).toBe(3);
    // negative interval falls back to the default
    expect(cfg.sweepIntervalMs).toBe(IMPROVER_DEFAULTS.sweepIntervalMs);
  });

  test("hard exclusion always covers the dev line", () => {
    const cfg = { ...IMPROVER_DEFAULTS, devLine: "assembly-dev", excludeLines: ["hello-world"] };
    expect(isHardExcluded("assembly-dev", cfg)).toBe(true);
    expect(isHardExcluded("hello-world", cfg)).toBe(true);
    expect(isHardExcluded("em-prospector", cfg)).toBe(false);
  });
});

// ─── state ───────────────────────────────────────────────────────────

describe("ImproverState", () => {
  test("assessed registry and per-line baseline markers persist across loads", () => {
    const dir = resolve(tempDir, "state");
    const s1 = ImproverState.load(dir);
    expect(s1.isLineBaselined("/lines/a")).toBe(false);
    s1.markAssessed({
      key: "k1",
      wp_id: "run_x",
      line: "a",
      bucket: "done",
      file_name: "run_x.json",
      verdict: "bootstrap",
      at: new Date().toISOString(),
    });
    s1.markLineBaselined("/lines/a", "a");
    expect(s1.hasAssessed("k1")).toBe(true);
    expect(s1.isLineBaselined("/lines/a")).toBe(true);

    const s2 = ImproverState.load(dir);
    expect(s2.hasAssessed("k1")).toBe(true);
    expect(s2.hasAssessed("k2")).toBe(false);
    expect(s2.isLineBaselined("/lines/a")).toBe(true);
    expect(s2.isLineBaselined("/lines/b")).toBe(false);
  });

  test("notice markers dedupe one-shot alerts", () => {
    const dir = resolve(tempDir, "state");
    const s = ImproverState.load(dir);
    expect(s.hasNotice("exhausted", "a/work/x")).toBe(false);
    s.appendEvent({ type: "notice", kind: "exhausted", issue_key: "a/work/x", at: new Date().toISOString() });
    expect(s.hasNotice("exhausted", "a/work/x")).toBe(true);
    expect(s.hasNotice("cap", "a/work/x")).toBe(false);
    expect(ImproverState.load(dir).hasNotice("exhausted", "a/work/x")).toBe(true);
  });

  test("recurrence with no open proposal is a safe no-op in the fold", () => {
    const s = ImproverState.load(resolve(tempDir, "state"));
    s.appendEvent({
      type: "recurrence",
      issue_key: "a/work/orphan",
      item: { line_path: "/lines/a", line: "a", bucket: "error", file_name: "r1.json", wp_id: "r1" },
      wants_requeue: true,
      at: new Date().toISOString(),
    });
    expect(s.openProposals()).toEqual([]);
  });

  test("open-proposal fold: recurrence attaches requeue items, resolve closes", () => {
    const s = ImproverState.load(resolve(tempDir, "state"));
    const base = {
      type: "proposed" as const,
      proposal_id: "imp_1",
      issue_key: "a/work/slow-fetch",
      source_line: "a",
      source_line_path: "/lines/a",
      issue_slug: "slow-fetch",
      target_station: "work",
      title: "Fix slow fetch",
      dev_task_key: "improver-a-slow-fetch-1",
      dev_task_file: "improver-a-slow-fetch-1.json",
      requeue: [
        { line_path: "/lines/a", line: "a", bucket: "error" as const, file_name: "r1.json", wp_id: "r1" },
      ],
      at: new Date().toISOString(),
    };
    s.appendEvent(base);
    s.appendEvent({
      type: "recurrence",
      issue_key: "a/work/slow-fetch",
      item: { line_path: "/lines/a", line: "a", bucket: "error", file_name: "r2.json", wp_id: "r2" },
      wants_requeue: true,
      at: new Date().toISOString(),
    });
    s.appendEvent({
      type: "recurrence",
      issue_key: "a/work/slow-fetch",
      item: { line_path: "/lines/a", line: "a", bucket: "done", file_name: "r3.json", wp_id: "r3" },
      wants_requeue: false,
      at: new Date().toISOString(),
    });

    const open = s.openProposals();
    expect(open.length).toBe(1);
    expect(open[0].requeue.map((r) => r.file_name)).toEqual(["r1.json", "r2.json"]);
    expect(s.proposalCountForIssue("a/work/slow-fetch")).toBe(1);
    expect(s.recentSlugsForLine("a")).toEqual(["slow-fetch"]);

    s.appendEvent({
      type: "resolved",
      proposal_id: "imp_1",
      issue_key: "a/work/slow-fetch",
      outcome: "fixed",
      requeued: 2,
      at: new Date().toISOString(),
    });
    expect(s.openProposals().length).toBe(0);
    // Lifetime count survives resolution — feeds the per-issue cap.
    expect(s.proposalCountForIssue("a/work/slow-fetch")).toBe(1);
  });

  test("dev_retry retargets an open proposal without increasing lifetime proposal count", () => {
    const s = ImproverState.load(resolve(tempDir, "state"));
    s.appendEvent({
      type: "proposed",
      proposal_id: "imp_1",
      issue_key: "a/work/slow-fetch",
      source_line: "a",
      source_line_path: "/lines/a",
      issue_slug: "slow-fetch",
      target_station: "work",
      title: "Fix slow fetch",
      dev_task_key: "old-task",
      dev_task_file: "old-task.json",
      requeue: [{ line_path: "/lines/a", line: "a", bucket: "error", file_name: "r1.json", wp_id: "r1" }],
      at: new Date().toISOString(),
    });
    s.appendEvent({
      type: "dev_retry",
      proposal_id: "imp_1",
      issue_key: "a/work/slow-fetch",
      previous_dev_task_key: "old-task",
      dev_task_key: "new-task",
      dev_task_file: "new-task.json",
      dev_wp_id: "run_dev1",
      reason: "tests failed",
      at: new Date().toISOString(),
    });

    const open = s.openProposals();
    expect(open.length).toBe(1);
    expect(open[0].dev_task_key).toBe("new-task");
    expect(open[0].dev_retry_count).toBe(1);
    expect(open[0].requeue.map((r) => r.file_name)).toEqual(["r1.json"]);
    expect(s.proposalCountForIssue("a/work/slow-fetch")).toBe(1);
  });
});

// ─── assess helpers ──────────────────────────────────────────────────

describe("sanitizeNeutral", () => {
  test("replaces recursion-trigger phrasings", () => {
    const out = sanitizeNeutral(
      "Run a smoke test, then run the full pipeline via bun src/cli.ts run and assembly enqueue, plus a migration."
    );
    expect(out.toLowerCase()).not.toContain("smoke");
    expect(out.toLowerCase()).not.toContain("migration");
    expect(out).not.toMatch(/bun (run )?src\/cli\.ts run/i);
    expect(out.toLowerCase()).not.toContain("assembly enqueue");
    expect(out.toLowerCase()).not.toContain("run the full pipeline");
  });

  test("covers runtime variants, verb variants, and word forms", () => {
    const out = sanitizeNeutral(
      "First node src/cli.ts run foo, or /root/assembly/src/cli.ts daemon, then execute the pipeline, " +
        "start the dev line, kick off the line, while migrating data via smoketests."
    );
    expect(out).not.toMatch(/src\/cli\.ts\s+(run|daemon)/i);
    expect(out.toLowerCase()).not.toContain("execute the pipeline");
    expect(out.toLowerCase()).not.toMatch(/start the dev line/);
    expect(out.toLowerCase()).not.toMatch(/kick off the line/);
    expect(out.toLowerCase()).not.toContain("migrating");
    expect(out.toLowerCase()).not.toContain("smoketest");
  });
});

describe("containsCliInvocation", () => {
  test("catches normalized and unicode-disguised invocations, allows benign prose", () => {
    expect(containsCliInvocation("please   assembly\n run the thing")).toBe(true);
    expect(containsCliInvocation("ｓｍｏｋｅ test this")).toBe(true); // fullwidth → NFKC
    expect(containsCliInvocation("src/cli.ts   enqueue stuff")).toBe(true);
    expect(containsCliInvocation("assembly daemon start now")).toBe(true);
    expect(containsCliInvocation("the assembly daemon watches queues for new files")).toBe(false);
    expect(containsCliInvocation("update lines/foo/stations/work/AGENT.md")).toBe(false);
  });
});

describe("normalizeSlug", () => {
  test("kebab-cases and bounds the slug", () => {
    expect(normalizeSlug("LinkedIn Fetch TIMEOUT!!")).toBe("linkedin-fetch-timeout");
    expect(normalizeSlug("")).toBe("unnamed-issue");
    expect(normalizeSlug("x".repeat(80)).length).toBeLessThanOrEqual(50);
  });
});

describe("parseVerdict", () => {
  test("parses a clean verdict and one wrapped in fences", () => {
    const obj = {
      outcome: "failure",
      should_improve: true,
      confidence: "high",
      target_station: "work",
      issue_slug: "Slow Fetch",
      title: "Fix it",
      task_body: "Do the fix",
      requeue_after_fix: true,
      reasoning: "evidence",
    };
    const v1 = parseVerdict(JSON.stringify(obj));
    expect(v1.issue_slug).toBe("slow-fetch");
    expect(v1.should_improve).toBe(true);
    const v2 = parseVerdict("```json\n" + JSON.stringify(obj) + "\n```");
    expect(v2.title).toBe("Fix it");
  });

  test("rejects garbage and inconsistent verdicts", () => {
    expect(() => parseVerdict("no json here")).toThrow(VerdictParseError);
    expect(() =>
      parseVerdict(
        JSON.stringify({ outcome: "failure", should_improve: true, confidence: "high", title: "", task_body: "" })
      )
    ).toThrow(VerdictParseError);
    expect(() =>
      parseVerdict(JSON.stringify({ outcome: "maybe", should_improve: false, confidence: "low" }))
    ).toThrow(VerdictParseError);
  });

  test("sanitizes trigger words inside title and body", () => {
    const v = parseVerdict(
      JSON.stringify({
        outcome: "failure",
        should_improve: true,
        confidence: "high",
        target_station: null,
        issue_slug: "x",
        title: "Add smoke test for line",
        task_body: "Then run the pipeline as a migration check.",
        requeue_after_fix: false,
        reasoning: "",
      })
    );
    expect(v.title.toLowerCase()).not.toContain("smoke");
    expect(v.task_body.toLowerCase()).not.toContain("migration");
  });

  test("REJECTS a verdict whose body dodges the sanitizer but trips the deny-list", () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          outcome: "failure",
          should_improve: true,
          confidence: "high",
          target_station: null,
          issue_slug: "x",
          title: "Innocent title",
          task_body: "Afterwards do a ｓｍｏｋｅ check of the station.", // fullwidth dodges regex, NFKC catches it
          requeue_after_fix: false,
          reasoning: "",
        })
      )
    ).toThrow(VerdictParseError);
  });
});

describe("discord helpers", () => {
  test("normalizeDiscordTarget prefixes bare ids and truncateForDiscord caps length", () => {
    expect(normalizeDiscordTarget("12345")).toBe("channel:12345");
    expect(normalizeDiscordTarget("channel:12345")).toBe("channel:12345");
    const long = "x".repeat(2500);
    const out = truncateForDiscord(long);
    expect(out.length).toBeLessThanOrEqual(1900);
    expect(out.endsWith("…")).toBe(true);
    expect(truncateForDiscord("short")).toBe("short");
  });
});

describe("buildAssessmentMessages", () => {
  test("includes workpiece evidence, line context, and dedupe slugs", () => {
    const linePath = makeLine("ctx-line");
    const messages = buildAssessmentMessages({
      workpiece: {
        id: "run_1",
        task: "do things",
        input: {},
        stations: { work: { status: "failed", failure_class: "timeout", summary: "Failed: boom" } },
      },
      lineName: "ctx-line",
      linePath,
      bucket: "error",
      recentSlugs: ["slow-fetch"],
      openTitles: ["[ctx-line/work/slow-fetch] Fix slow fetch"],
    });
    const user = messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("run_1");
    expect(user).toContain("failure_class: timeout");
    expect(user).toContain("Do the work for ctx-line");
    expect(user).toContain("slow-fetch");
    expect(messages.find((m) => m.role === "system")!.content).toContain("fabrication is not");
  });
});

describe("guardedDownstreamSuccessVerdict", () => {
  test("returns no-action when guarded data exists and downstream station succeeded", () => {
    const linePath = makeGuardedProspectorLine("em-prospector");
    const verdict = guardedDownstreamSuccessVerdict({
      workpiece: {
        id: "run_ok",
        task: "score",
        stations: {
          score: {
            status: "done",
            summary: "Unable to write the envelope file because of a bind-mount issue.",
            data: { scored_companies: [{ name: "Platphorm", score: 84 }] },
          },
          "push-to-attio": { status: "done", summary: "Created Platphorm in Attio" },
        },
      },
      lineName: "em-prospector",
      linePath,
      bucket: "done",
      recentSlugs: [],
      openTitles: [],
    });
    expect(verdict?.should_improve).toBe(false);
    expect(verdict?.issue_slug).toBe("guarded-success");
  });

  test("returns null when guarded data is missing or downstream failed", () => {
    const linePath = makeGuardedProspectorLine("em-prospector");
    const base = {
      id: "run_bad",
      task: "score",
      stations: {
        score: { status: "done", summary: "scary summary", data: {} },
        "push-to-attio": { status: "done", summary: "ok" },
      },
    };
    expect(
      guardedDownstreamSuccessVerdict({
        workpiece: base,
        lineName: "em-prospector",
        linePath,
        bucket: "done",
        recentSlugs: [],
        openTitles: [],
      })
    ).toBeNull();
    expect(
      guardedDownstreamSuccessVerdict({
        workpiece: {
          ...base,
          stations: {
            score: { status: "done", data: { scored_companies: [] } },
            "push-to-attio": { status: "failed", summary: "Attio failed" },
          },
        },
        lineName: "em-prospector",
        linePath,
        bucket: "done",
        recentSlugs: [],
        openTitles: [],
      })
    ).toBeNull();
  });
});

// ─── devline ─────────────────────────────────────────────────────────

describe("devline", () => {
  test("enqueueDevTask writes a CLI-shaped task with manifest entry and linkage", () => {
    const devPath = makeLine("assembly-dev");
    const { fileName, taskKey } = enqueueDevTask(devPath, {
      proposalId: "imp_1",
      issueKey: "a/work/slow-fetch",
      issueSlug: "slow-fetch",
      sourceLine: "a",
      sourceWorkpieceId: "run_a1",
      title: "Fix slow fetch",
      taskBody: "Harden the fetch.",
    });
    const inbox = resolve(devPath, "queues", "inbox");
    const filePath = resolve(inbox, fileName);
    expect(existsSync(filePath)).toBe(true);
    expect(isEmitted(inbox, fileName)).toBe(true);
    expect(taskKey).toMatch(/^[A-Za-z0-9._-]+$/);
    const payload = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(payload.schema_version).toBe(1);
    expect(payload.taskKey).toBe(taskKey);
    expect(payload.task).toContain("Fix slow fetch");
    expect(payload.task).toContain("Harden the fetch.");
    expect(payload.input.improver.proposal_id).toBe("imp_1");
    expect(payload.input.improver.issue_key).toBe("a/work/slow-fetch");
    // No leftover tmp files from the atomic write.
    expect(readdirSync(inbox).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  test("devTaskStillPresent finds the task across line and station queues", () => {
    const devPath = makeLine("assembly-dev");
    expect(devTaskStillPresent(devPath, "improver-x")).toBe(false);
    writeFileSync(resolve(devPath, "queues", "held", "improver-x.json"), "{}");
    expect(devTaskStillPresent(devPath, "improver-x")).toBe(true);
    rmSync(resolve(devPath, "queues", "held", "improver-x.json"));
    writeFileSync(resolve(devPath, "stations", "work", "queue", "processing", "improver-x.json"), "{}");
    expect(devTaskStillPresent(devPath, "improver-x")).toBe(true);
  });

  test("requeueDoneWorkpiece re-runs a done task with lineage and allowlist", () => {
    const linePath = makeLine("src-line");
    const fileName = writeWorkpiece(linePath, "done", "run_done1");
    const { newFileName } = requeueDoneWorkpiece(linePath, fileName);
    const inbox = resolve(linePath, "queues", "inbox");
    const requeued = JSON.parse(readFileSync(resolve(inbox, newFileName), "utf-8"));
    expect(requeued.parent_run_id).toBe("run_done1");
    expect(requeued.task).toBe("Fetch listings and score them");
    expect(requeued.stations).toEqual({});
    expect(isEmitted(inbox, newFileName)).toBe(true);
    // Original stays in done/.
    expect(existsSync(resolve(linePath, "queues", "done", fileName))).toBe(true);
  });

  test("requeueSource handles error bucket via retry-manual and reports missing files", () => {
    const linePath = makeLine("src-line");
    const fileName = writeWorkpiece(linePath, "error", "run_err1");
    const ok = requeueSource({
      line_path: linePath,
      line: "src-line",
      bucket: "error",
      file_name: fileName,
      wp_id: "run_err1",
    });
    expect(ok.ok).toBe(true);
    const inboxFiles = readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    const missing = requeueSource({
      line_path: linePath,
      line: "src-line",
      bucket: "error",
      file_name: "not-there.json",
      wp_id: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("no longer present");
  });
});

// ─── watcher end-to-end (injected assess + notify, no LLM, no Discord) ──

describe("startImproverWatcher", () => {
  let handle: ImproverWatcherHandle | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  function startWatcher(opts: {
    lines: Array<{ linePath: string; lineName: string }>;
    verdicts?:
      | AssessmentVerdict[]
      | ((ctx: { lineName: string; bucket: string }) => AssessmentVerdict | Promise<AssessmentVerdict>);
    config?: Record<string, unknown>;
    staleProposalMs?: number;
  }) {
    const calls: Array<{ lineName: string; bucket: string }> = [];
    const notifications: string[] = [];
    const verdicts = opts.verdicts ?? [];
    let i = 0;
    handle = startImproverWatcher({
      getLines: () => opts.lines,
      stateDir: resolve(tempDir, "improver-state"),
      configPath: resolve(tempDir, "no-config.yaml"),
      config: { enabled: true, devLine: "assembly-dev", ...(opts.config ?? {}) },
      staleProposalMs: opts.staleProposalMs,
      assessFn: async (ctx) => {
        calls.push({ lineName: ctx.lineName, bucket: ctx.bucket });
        if (typeof verdicts === "function") return verdicts(ctx);
        const v = verdicts[Math.min(i, verdicts.length - 1)] ?? NO_ACTION;
        i++;
        return v;
      },
      notifyFn: async (msg) => {
        notifications.push(msg);
        return true;
      },
    });
    return { calls, notifications, handle: handle!, lines: opts.lines };
  }

  test("disabled config returns an inert handle", () => {
    const h = startImproverWatcher({
      getLines: () => [],
      configPath: resolve(tempDir, "no-config.yaml"),
      stateDir: resolve(tempDir, "improver-state"),
    });
    expect(h.enabled).toBe(false);
    h.stop();
  });

  test("bootstrap baselines pre-existing completions without assessing", async () => {
    const linePath = makeLine("line-a");
    writeWorkpiece(linePath, "done", "run_old1");
    writeWorkpiece(linePath, "error", "run_old2");
    const { calls, handle: h } = startWatcher({
      lines: [{ linePath, lineName: "line-a" }, { linePath: makeLine("assembly-dev"), lineName: "assembly-dev" }],
    });
    await h.sweep();
    expect(calls.length).toBe(0);
    // ...but a completion arriving after bootstrap IS assessed.
    writeWorkpiece(linePath, "done", "run_new1");
    await h.sweep();
    expect(calls).toEqual([{ lineName: "line-a", bucket: "done" }]);
  });

  test("no_action verdicts are registered and never re-assessed", async () => {
    const linePath = makeLine("line-a");
    const { calls, handle: h } = startWatcher({
      lines: [{ linePath, lineName: "line-a" }, { linePath: makeLine("assembly-dev"), lineName: "assembly-dev" }],
      verdicts: [NO_ACTION],
    });
    await h.sweep();
    writeWorkpiece(linePath, "done", "run_n1");
    await h.sweep();
    await h.sweep();
    expect(calls.length).toBe(1);
  });

  test("guarded downstream success bypasses assessment despite scary station summary", async () => {
    const linePath = makeGuardedProspectorLine("em-prospector");
    const devPath = makeLine("assembly-dev");
    const { calls, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "em-prospector" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => {
        throw new Error("assessor should not run");
      },
    });
    await h.sweep();
    writeWorkpiece(linePath, "done", "run_guarded", {
      stations: {
        score: {
          status: "done",
          summary: "Unable to write the envelope file because the bind-mount path was unavailable.",
          data: { scored_companies: [{ name: "Platphorm", score: 84 }] },
        },
        "push-to-attio": { status: "done", summary: "Platphorm was created in Attio" },
      },
    });
    await h.sweep();
    expect(calls.length).toBe(0);
    expect(readdirSync(resolve(devPath, "queues", "inbox")).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  test("high-confidence failure queues a dev task, duplicates become recurrences, fix completion requeues", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const lines = [
      { linePath, lineName: "line-a" },
      { linePath: devPath, lineName: "assembly-dev" },
    ];
    const { calls, notifications, handle: h } = startWatcher({
      lines,
      verdicts: () => proposeVerdict("fetch-timeout"),
    });
    await h.sweep();

    // First failure → proposal queued on the dev line.
    const errFile1 = writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTasks = readdirSync(devInbox).filter((f) => f.endsWith(".json"));
    expect(devTasks.length).toBe(1);
    const devTask = JSON.parse(readFileSync(resolve(devInbox, devTasks[0]), "utf-8"));
    const proposalId = devTask.input.improver.proposal_id;
    expect(devTask.input.improver.issue_key).toBe("line-a/work/fetch-timeout");
    expect(notifications.some((n) => n.includes("queued improvement"))).toBe(true);

    // Second failure with the same issue → recurrence, no second dev task.
    const errFile2 = writeWorkpiece(linePath, "error", "run_f2");
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
    expect(calls.length).toBe(2);

    // Dev line finishes the improvement task → both failures requeued.
    writeWorkpiece(devPath, "done", "run_dev1", {
      input: { improver: { proposal_id: proposalId, issue_key: "line-a/work/fetch-timeout" } },
    });
    await h.sweep();
    const requeuedFiles = readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json"));
    expect(requeuedFiles.length).toBe(2);
    const parents = requeuedFiles
      .map((f) => JSON.parse(readFileSync(resolve(linePath, "queues", "inbox", f), "utf-8")).parent_run_id)
      .sort();
    expect(parents).toEqual(["run_f1", "run_f2"]);
    expect(notifications.some((n) => n.includes("improvement deployed"))).toBe(true);
    // Original error files were used for the requeue copies.
    expect(errFile1).toBe("run_f1.json");
    expect(errFile2).toBe("run_f2.json");
  });

  test("failed dev task resolves the proposal without requeueing", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );

    writeWorkpiece(devPath, "error", "run_dev1", {
      input: { improver: devTask.input.improver },
    });
    await h.sweep();
    expect(readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(notifications.some((n) => n.includes("failed"))).toBe(true);

    // Slot released — a fresh failure can propose again (lifetime cap = 2).
    writeWorkpiece(linePath, "error", "run_f2");
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(2);
  });

  test("recoverable failed dev task queues one repair without requeueing source tasks", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const firstDevFile = readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0];
    const firstDevTask = JSON.parse(readFileSync(resolve(devInbox, firstDevFile), "utf-8"));

    writeWorkpiece(devPath, "error", "run_dev_fail1", {
      input: { improver: firstDevTask.input.improver },
      stations: {
        deploy: {
          status: "failed",
          summary: "deploy.ts exited with code 1; bun test exited 1; 1 tests failed",
          data: { error: "startImproverWatcher stale sweep test failed" },
        },
      },
    });
    await h.sweep();

    const devTasks = readdirSync(devInbox).filter((f) => f.endsWith(".json"));
    expect(devTasks.length).toBe(2);
    expect(readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(notifications.some((n) => n.includes("queued a repair task"))).toBe(true);

    const repairFile = devTasks.find((f) => f !== firstDevFile)!;
    const repairTask = JSON.parse(readFileSync(resolve(devInbox, repairFile), "utf-8"));
    expect(repairTask.input.improver.proposal_id).toBe(firstDevTask.input.improver.proposal_id);
    expect(repairTask.task).toContain("Repair failed improvement");

    writeWorkpiece(devPath, "done", "run_dev_repair_done", {
      input: { improver: repairTask.input.improver },
    });
    await h.sweep();
    const requeued = readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json"));
    expect(requeued.length).toBe(1);
    expect(JSON.parse(readFileSync(resolve(linePath, "queues", "inbox", requeued[0]), "utf-8")).parent_run_id).toBe(
      "run_f1"
    );
  });

  test("recoverable dev failures resolve as fix_failed after retry limit", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      config: { maxDevTaskRetries: 1 },
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const firstDevFile = readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0];
    const firstDevTask = JSON.parse(readFileSync(resolve(devInbox, firstDevFile), "utf-8"));
    const failureStations = {
      deploy: {
        status: "failed",
        summary: "deploy.ts exited with code 1; bun test exited 1; 1 tests failed",
      },
    };

    writeWorkpiece(devPath, "error", "run_dev_fail1", {
      input: { improver: firstDevTask.input.improver },
      stations: failureStations,
    });
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(2);
    const repairFile = readdirSync(devInbox).filter((f) => f.endsWith(".json") && f !== firstDevFile)[0];
    const repairTask = JSON.parse(readFileSync(resolve(devInbox, repairFile), "utf-8"));

    writeWorkpiece(devPath, "error", "run_dev_fail2", {
      input: { improver: repairTask.input.improver },
      stations: failureStations,
    });
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(2);
    expect(readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(notifications.some((n) => n.includes("failed in assembly-dev"))).toBe(true);
  });

  test("open-proposal cap drops further proposals", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: (ctx) => proposeVerdict(`issue-${ctx.lineName}`, {}),
      config: { maxOpenProposals: 1 },
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();

    // Different issue slug for the second failure via a fresh verdict fn is
    // overkill — same line, same slug would be a recurrence. Use a second
    // line to force a distinct issue key.
    const lineB = makeLine("line-b");
    h.stop();
    const second = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: lineB, lineName: "line-b" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: (ctx) => proposeVerdict(`issue-${ctx.lineName}`, {}),
      config: { maxOpenProposals: 1 },
    });
    await second.handle.sweep();
    writeWorkpiece(lineB, "error", "run_g1");
    await second.handle.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
    expect(
      [...notifications, ...second.notifications].some((n) => n.includes("cap"))
    ).toBe(true);
  });

  test("per-issue lifetime cap stops the propose-fix-fail loop", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      config: { maxProposalsPerIssue: 1 },
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    // Fix deploys but the issue comes back.
    writeWorkpiece(devPath, "done", "run_dev1", { input: { improver: devTask.input.improver } });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f9");
    await h.sweep();
    // No second proposal; exhaustion notice posted.
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
    expect(notifications.some((n) => n.includes("recurring"))).toBe(true);
  });

  test("excluded lines and the dev line are never assessed", async () => {
    const linePath = makeLine("hello-world");
    const devPath = makeLine("assembly-dev");
    const { calls, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "hello-world" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      config: { excludeLines: ["hello-world"] },
    });
    await h.sweep();
    writeWorkpiece(linePath, "done", "run_h1");
    writeWorkpiece(devPath, "done", "run_d1");
    await h.sweep();
    expect(calls.length).toBe(0);
  });

  test("assessment budget defers work to the next sweep window", async () => {
    const linePath = makeLine("line-a");
    const { calls, handle: h } = startWatcher({
      lines: [{ linePath, lineName: "line-a" }, { linePath: makeLine("assembly-dev"), lineName: "assembly-dev" }],
      verdicts: [NO_ACTION],
      config: { maxAssessmentsPerSweep: 1 },
    });
    await h.sweep();
    writeWorkpiece(linePath, "done", "run_b1");
    writeWorkpiece(linePath, "done", "run_b2");
    await h.sweep();
    expect(calls.length).toBe(1);
    // Next window picks up the deferred one.
    await h.sweep();
    expect(calls.length).toBe(2);
  });

  test("a line discovered after first boot is baselined, not mass-assessed", async () => {
    const lineA = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const lines = [
      { linePath: lineA, lineName: "line-a" },
      { linePath: devPath, lineName: "assembly-dev" },
    ];
    const { calls, handle: h } = startWatcher({ lines, verdicts: [NO_ACTION] });
    await h.sweep();

    // A new line appears later (hot-reload) with months of history.
    const lineB = makeLine("line-b");
    writeWorkpiece(lineB, "done", "run_hist1");
    writeWorkpiece(lineB, "error", "run_hist2");
    lines.push({ linePath: lineB, lineName: "line-b" });
    await h.sweep();
    expect(calls.length).toBe(0); // history baselined, no LLM calls

    writeWorkpiece(lineB, "done", "run_fresh");
    await h.sweep();
    expect(calls).toEqual([{ lineName: "line-b", bucket: "done" }]);
  });

  test("unparseable source workpiece is registered as error without an LLM call", async () => {
    const linePath = makeLine("line-a");
    const { calls, handle: h } = startWatcher({
      lines: [{ linePath, lineName: "line-a" }, { linePath: makeLine("assembly-dev"), lineName: "assembly-dev" }],
    });
    await h.sweep();
    writeFileSync(resolve(linePath, "queues", "error", "garbage.json"), "{not json");
    await h.sweep();
    await h.sweep();
    expect(calls.length).toBe(0);
  });

  test("repeated verdict-parse failures register the file as error instead of looping forever", async () => {
    const linePath = makeLine("line-a");
    const calls: string[] = [];
    handle = startImproverWatcher({
      getLines: () => [
        { linePath, lineName: "line-a" },
        { linePath: makeLine("assembly-dev"), lineName: "assembly-dev" },
      ],
      stateDir: resolve(tempDir, "improver-state"),
      configPath: resolve(tempDir, "no-config.yaml"),
      config: { enabled: true, devLine: "assembly-dev" },
      assessFn: async () => {
        calls.push("call");
        throw new VerdictParseError("forbidden phrase");
      },
      notifyFn: async () => true,
    });
    await handle.sweep();
    writeWorkpiece(linePath, "error", "run_bad");
    await handle.sweep(); // attempt 1 — left unregistered
    await handle.sweep(); // attempt 2 — registered as error
    await handle.sweep(); // no further attempts
    expect(calls.length).toBe(2);
  });

  test("no_op dev completion resolves without requeueing", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    writeWorkpiece(devPath, "done", "run_dev1", {
      input: { improver: devTask.input.improver },
      stations: { develop: { status: "done", summary: "no-op", data: { no_op: true } } },
    });
    await h.sweep();
    expect(readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(notifications.some((n) => n.includes("no-op"))).toBe(true);
  });

  test("done-bucket tasks are not requeued unless requeue_done_tasks is enabled", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("slow-output", { outcome: "success", requeue_after_fix: true }),
      // requeueDoneTasks defaults to false
    });
    await h.sweep();
    writeWorkpiece(linePath, "done", "run_ok1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    writeWorkpiece(devPath, "done", "run_dev1", { input: { improver: devTask.input.improver } });
    await h.sweep();
    // Improvement deployed, but the successful source task was NOT re-run.
    expect(readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
  });

  test("done-bucket requeue happens with operator opt-in plus assessor consent", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("slow-output", { outcome: "success", requeue_after_fix: true }),
      config: { requeueDoneTasks: true },
    });
    await h.sweep();
    writeWorkpiece(linePath, "done", "run_ok1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    writeWorkpiece(devPath, "done", "run_dev1", { input: { improver: devTask.input.improver } });
    await h.sweep();
    const requeued = readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json"));
    expect(requeued.length).toBe(1);
    expect(
      JSON.parse(readFileSync(resolve(linePath, "queues", "inbox", requeued[0]), "utf-8")).parent_run_id
    ).toBe("run_ok1");
  });

  test("requeue_on_fix=false deploys the fix without requeueing", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      config: { requeueOnFix: false },
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    writeWorkpiece(devPath, "done", "run_dev1", { input: { improver: devTask.input.improver } });
    await h.sweep();
    expect(readdirSync(resolve(linePath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(notifications.some((n) => n.includes("improvement deployed"))).toBe(true);
  });

  test("stale sweep releases proposals whose dev task vanished or finished unprocessed", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      staleProposalMs: 0,
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTasks = readdirSync(devInbox).filter((f) => f.endsWith(".json"));
    expect(devTasks.length).toBe(1);
    // Operator deletes the queued dev task entirely.
    rmSync(resolve(devInbox, devTasks[0]));
    await h.sweep();
    expect(notifications.some((n) => n.includes("releasing its slot") || n.includes("disappeared"))).toBe(true);
    // Slot released — a different line/issue can propose again.
    writeWorkpiece(linePath, "error", "run_f2");
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
  });

  test("stale sweep releases terminal dev tasks whose completion could not resolve", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      staleProposalMs: 0,
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devFile = readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0];
    rmSync(resolve(devInbox, devFile));
    writeFileSync(resolve(devPath, "queues", "error", devFile), "{not json");

    await h.sweep();
    expect(notifications.some((n) => n.includes("finished (error/)"))).toBe(true);
    writeWorkpiece(linePath, "error", "run_f2");
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
  });

  test("escalated dev task (review/) releases the proposal slot with a notice", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    // The dev workpiece escalates to review/ instead of finishing.
    writeFileSync(
      resolve(devPath, "queues", "review", "run_dev1.json"),
      JSON.stringify({ id: "run_dev1", input: { improver: devTask.input.improver }, stations: {} })
    );
    await h.sweep();
    expect(notifications.some((n) => n.includes("escalated"))).toBe(true);
    // Slot released.
    writeWorkpiece(linePath, "error", "run_f2");
    await h.sweep();
    expect(readdirSync(devInbox).filter((f) => f.endsWith(".json")).length).toBe(2);
  });

  test("proposal_mode=held stages dev tasks in held/ instead of inbox/", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      config: { proposalMode: "held" },
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    expect(readdirSync(resolve(devPath, "queues", "inbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
    const held = readdirSync(resolve(devPath, "queues", "held")).filter((f) => f.endsWith(".json"));
    expect(held.length).toBe(1);
    expect(notifications.some((n) => n.includes("held"))).toBe(true);
  });

  test("exhaustion and cap notices are posted once per issue, not per occurrence", async () => {
    const linePath = makeLine("line-a");
    const devPath = makeLine("assembly-dev");
    const { notifications, handle: h } = startWatcher({
      lines: [
        { linePath, lineName: "line-a" },
        { linePath: devPath, lineName: "assembly-dev" },
      ],
      verdicts: () => proposeVerdict("fetch-timeout"),
      config: { maxProposalsPerIssue: 1 },
    });
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f1");
    await h.sweep();
    const devInbox = resolve(devPath, "queues", "inbox");
    const devTask = JSON.parse(
      readFileSync(resolve(devInbox, readdirSync(devInbox).filter((f) => f.endsWith(".json"))[0]), "utf-8")
    );
    writeWorkpiece(devPath, "done", "run_dev1", { input: { improver: devTask.input.improver } });
    await h.sweep();
    // Issue recurs three times after exhaustion — one notice only.
    writeWorkpiece(linePath, "error", "run_f7");
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f8");
    await h.sweep();
    writeWorkpiece(linePath, "error", "run_f9");
    await h.sweep();
    expect(notifications.filter((n) => n.includes("keeps recurring")).length).toBe(1);
  });

  test("event-driven inotify path assesses a completion without an explicit sweep", async () => {
    const linePath = makeLine("line-a");
    const { calls, handle: h } = startWatcher({
      lines: [{ linePath, lineName: "line-a" }, { linePath: makeLine("assembly-dev"), lineName: "assembly-dev" }],
      verdicts: [NO_ACTION],
    });
    await h.sweep(); // baseline + initial catch-up done
    writeWorkpiece(linePath, "done", "run_evt1");
    // No sweep — rely on fs.watch. Poll up to 3s for the assessment.
    const deadline = Date.now() + 3000;
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await h.settle();
    expect(calls.length).toBe(1);
  });
});
