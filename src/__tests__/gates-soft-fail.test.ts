/**
 * Tests for gate soft-fail behavior and eval feedback.
 *
 * This suite validates the conversion of safety gates (Gate 0, Gate 3,
 * and post-rebase max-resolutions) from hardFail to softFail. Since
 * develop.ts and eval.ts are standalone scripts (not importable modules),
 * these tests validate the logic patterns and data flow.
 */
import { describe, test, expect } from "bun:test";

describe("Gate soft-fail logic", () => {
  test("softGateFail helper captures gate failure in envelope", () => {
    // Mock the agentEnv object that softGateFail operates on
    const agentEnv: any = { data: {} };
    let gateFailed = false;

    // Replicate the softGateFail logic from develop.ts
    function softGateFail(gate: string, details: string): void {
      if (!agentEnv.data) agentEnv.data = {};
      agentEnv.data.gate_failure = { gate, details: details.slice(0, 3000) };
      agentEnv.data.tests_passed = false;
      gateFailed = true;
    }

    softGateFail("test-gate", "This is a test gate failure with details");

    expect(gateFailed).toBe(true);
    expect(agentEnv.data.gate_failure).toEqual({
      gate: "test-gate",
      details: "This is a test gate failure with details",
    });
    expect(agentEnv.data.tests_passed).toBe(false);
  });

  test("softGateFail truncates details at 3000 chars", () => {
    const agentEnv: any = { data: {} };
    let gateFailed = false;

    function softGateFail(gate: string, details: string): void {
      if (!agentEnv.data) agentEnv.data = {};
      agentEnv.data.gate_failure = { gate, details: details.slice(0, 3000) };
      agentEnv.data.tests_passed = false;
      gateFailed = true;
    }

    const longDetails = "x".repeat(5000);
    softGateFail("test-gate", longDetails);

    expect(gateFailed).toBe(true);
    expect(agentEnv.data.gate_failure.details.length).toBe(3000);
  });

  test("Gate 0 logic: empty envelope with non-empty diff triggers failure", () => {
    const changedFiles = ["src/foo.ts", "src/bar.ts"];
    const claimedAll = new Set<string>([]);

    const shouldFail = changedFiles.length > 0 && claimedAll.size === 0;
    expect(shouldFail).toBe(true);
  });

  test("Gate 0 logic: non-overlapping envelope and diff triggers failure", () => {
    const changedFiles = ["src/foo.ts", "src/bar.ts"];
    const claimedAll = new Set<string>(["src/baz.ts", "src/qux.ts"]);

    const actualBasenames = new Set(changedFiles.map((f) => f.split("/").pop()!));
    const claimedBasenames = [...claimedAll].map((f) => f.split("/").pop()!);
    const overlap = claimedBasenames.some((b) => actualBasenames.has(b));

    expect(overlap).toBe(false);
  });

  test("Gate 0 logic: overlapping envelope and diff allows pass", () => {
    const changedFiles = ["src/foo.ts", "src/bar.ts"];
    const claimedAll = new Set<string>(["src/foo.ts", "src/baz.ts"]);

    const actualBasenames = new Set(changedFiles.map((f) => f.split("/").pop()!));
    const claimedBasenames = [...claimedAll].map((f) => f.split("/").pop()!);
    const overlap = claimedBasenames.some((b) => actualBasenames.has(b));

    expect(overlap).toBe(true);
  });

  test("Gate 3 logic: off-plan files trigger failure", () => {
    const planSet = new Set(["src/a.ts"]);
    const changedFiles = ["src/a.ts", "src/b.ts"];

    // Simplified version of isAllowed from develop.ts Gate 3
    function isAllowed(path: string): boolean {
      return planSet.has(path);
    }

    const offPlan = changedFiles.filter((f) => !isAllowed(f));
    expect(offPlan).toEqual(["src/b.ts"]);
  });

  test("Gate 3 logic: planned directories allow generated descendants", () => {
    const planSet = new Set(["web/dist/index.html", "web/dist/assets/"]);
    const changedFiles = [
      "web/dist/index.html",
      "web/dist/assets/index-BCA4gQB8.css",
      "web/dist/assets/index-Bqk0OJ2c.js",
      "web/dist2/assets/index.js",
    ];

    function normalizePlanPath(path: string): string | null {
      const trimmed = path.trim();
      if (!trimmed) return null;
      const normalized = trimmed
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+/g, "/");
      if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.includes("\0")) return null;
      const segments = normalized.split("/").filter(Boolean);
      if (segments.some((segment) => segment === "." || segment === "..")) return null;
      return normalized;
    }

    function isAllowed(path: string): boolean {
      const normalizedPath = normalizePlanPath(path);
      if (!normalizedPath) return false;
      if (planSet.has(normalizedPath)) return true;

      for (const planned of planSet) {
        if (planned.endsWith("/**")) {
          const prefix = planned.slice(0, -2);
          if (normalizedPath.startsWith(prefix) && normalizedPath.length > prefix.length) return true;
        }
        if (planned.endsWith("/")) {
          if (normalizedPath.startsWith(planned) && normalizedPath.length > planned.length) return true;
        }
      }

      return false;
    }

    const offPlan = changedFiles.filter((f) => !isAllowed(f));
    expect(offPlan).toEqual(["web/dist2/assets/index.js"]);
    expect(isAllowed("web/dist/assets/../secret.js")).toBe(false);
  });

  test("Gate 3 logic: test files paired with planned src files are allowed", () => {
    const planSet = new Set(["src/a.ts"]);
    const changedFiles = ["src/a.ts", "src/__tests__/a.test.ts"];
    const planTouchesSrc = [...planSet].some((p) => /^src\//.test(p));

    function isAllowed(path: string): boolean {
      if (planSet.has(path)) return true;

      // Direct stem pair: src/foo.{ts,js} → src/__tests__/foo.test.ts
      const stemPairFor = (p: string) => {
        const m = p.match(/^src\/(.+)\.(?:ts|tsx|js|jsx)$/);
        if (!m) return null;
        return `src/__tests__/${m[1]}.test.ts`;
      };
      for (const planned of planSet) {
        const t = stemPairFor(planned);
        if (t && path === t) return true;
      }

      // Any src/__tests__/*.test.ts is allowed if the plan touches src/ at all.
      if (planTouchesSrc && /^src\/__tests__\/.+\.test\.(?:ts|tsx|js|jsx)$/.test(path)) {
        return true;
      }

      return false;
    }

    const offPlan = changedFiles.filter((f) => !isAllowed(f));
    expect(offPlan).toEqual([]);
  });

  test("Gate 3 logic: all src/__tests__ files allowed when plan touches src/", () => {
    const planSet = new Set(["src/a.ts"]);
    const changedFiles = ["src/a.ts", "src/__tests__/unrelated.test.ts"];
    const planTouchesSrc = [...planSet].some((p) => /^src\//.test(p));

    function isAllowed(path: string): boolean {
      if (planSet.has(path)) return true;

      if (planTouchesSrc && /^src\/__tests__\/.+\.test\.(?:ts|tsx|js|jsx)$/.test(path)) {
        return true;
      }

      return false;
    }

    const offPlan = changedFiles.filter((f) => !isAllowed(f));
    expect(offPlan).toEqual([]);
  });

  test("Gate 3 policy restores off-plan files before retry", () => {
    const changedFiles = ["src/a.ts", "eslint.config.js"];
    const planSet = new Set(["src/a.ts"]);
    const restored: string[] = [];

    function isAllowed(path: string): boolean {
      return planSet.has(path);
    }

    function restoreOffPlanFiles(paths: string[]) {
      restored.push(...paths);
    }

    const offPlan = changedFiles.filter((f) => !isAllowed(f));
    if (offPlan.length > 0) restoreOffPlanFiles(offPlan);

    expect(restored).toEqual(["eslint.config.js"]);
  });

  test("Develop retry policy recreates an existing worktree instead of reusing it", () => {
    function worktreeSetupActions(existingWorktree: boolean, branchExists: boolean): string[] {
      const actions: string[] = [];
      if (existingWorktree) actions.push("remove-worktree", "prune-worktrees");
      actions.push(branchExists ? "add-existing-branch-worktree" : "add-new-branch-worktree");
      return actions;
    }

    expect(worktreeSetupActions(true, true)).toEqual([
      "remove-worktree",
      "prune-worktrees",
      "add-existing-branch-worktree",
    ]);
    expect(worktreeSetupActions(false, false)).toEqual(["add-new-branch-worktree"]);
  });
});

describe("Eval feedback formatting", () => {
  test("eval recognizes gate_failure and formats feedback", () => {
    const dev = {
      gate_failure: {
        gate: "plan-alignment",
        details: "off-plan files: src/b.ts",
      },
    };

    const feedbackParts: string[] = [];

    if (dev.gate_failure && typeof dev.gate_failure === "object") {
      const gf = dev.gate_failure as { gate?: string; details?: string };
      const gate = typeof gf.gate === "string" ? gf.gate : "unknown";
      const details = typeof gf.details === "string" ? gf.details : "(no details captured)";
      feedbackParts.push(
        `## Safety gate failed: ${gate}\n\n` +
          `Previous attempt was rejected by safety gate '${gate}'.\n\n` +
          `Details:\n${details}\n\n` +
          `Fix the issue and retry. Keep changes within the plan's files_to_change and files_to_create. ` +
          `If a planned directory or generated artifact was rejected, preserve the intended change and adjust the file list rather than removing required output.`
      );
    }

    expect(feedbackParts.length).toBe(1);
    expect(feedbackParts[0]).toContain("Safety gate failed: plan-alignment");
    expect(feedbackParts[0]).toContain("off-plan files: src/b.ts");
    expect(feedbackParts[0]).toContain("Keep changes within the plan's files_to_change and files_to_create");
  });

  test("eval handles missing gate_failure gracefully", () => {
    const dev: Record<string, unknown> = {};
    const feedbackParts: string[] = [];

    if ("gate_failure" in dev && dev.gate_failure && typeof dev.gate_failure === "object") {
      feedbackParts.push("should not reach here");
    }

    expect(feedbackParts.length).toBe(0);
  });

  test("eval handles malformed gate_failure gracefully", () => {
    const dev: Record<string, unknown> = {
      gate_failure: { gate: 123, details: null },
    };

    const feedbackParts: string[] = [];

    if ("gate_failure" in dev && dev.gate_failure && typeof dev.gate_failure === "object") {
      const gf = dev.gate_failure as { gate?: unknown; details?: unknown };
      const gate = typeof gf.gate === "string" ? gf.gate : "unknown";
      const details = typeof gf.details === "string" ? gf.details : "(no details captured)";
      feedbackParts.push(
        `## Safety gate failed: ${gate}\n\n` +
          `Details:\n${details}\n\n`
      );
    }

    expect(feedbackParts.length).toBe(1);
    expect(feedbackParts[0]).toContain("Safety gate failed: unknown");
    expect(feedbackParts[0]).toContain("(no details captured)");
  });
});

describe("llm.ts FATAL line extraction", () => {
  test("extracts last FATAL line from stderr", () => {
    const stderr = `
[develop] 2026-05-26 ... log line
[develop] 2026-05-26 ... another log
[develop] FATAL: blocked path in diff
some additional context
more lines
`;

    const fatalMatch = stderr.match(/\[develop\] FATAL: .*/g);
    const fatalLine = fatalMatch ? fatalMatch[fatalMatch.length - 1] : null;

    expect(fatalLine).toBe("[develop] FATAL: blocked path in diff");
  });

  test("extracts last FATAL when multiple present", () => {
    const stderr = `
[develop] FATAL: first failure
[develop] 2026-05-26 ... log line
[develop] FATAL: second failure
more context
`;

    const fatalMatch = stderr.match(/\[develop\] FATAL: .*/g);
    const fatalLine = fatalMatch ? fatalMatch[fatalMatch.length - 1] : null;

    expect(fatalLine).toBe("[develop] FATAL: second failure");
  });

  test("returns null when no FATAL line present", () => {
    const stderr = `
[develop] 2026-05-26 ... log line
[develop] 2026-05-26 ... another log
error output
`;

    const fatalMatch = stderr.match(/\[develop\] FATAL: .*/g);
    const fatalLine = fatalMatch ? fatalMatch[fatalMatch.length - 1] : null;

    expect(fatalLine).toBeNull();
  });

  test("constructs error message with FATAL line prepended", () => {
    const stderr = "x".repeat(3000) + "\n[develop] FATAL: test failure\nmore context";
    const fatalMatch = stderr.match(/\[develop\] FATAL: .*/g);
    const fatalLine = fatalMatch ? fatalMatch[fatalMatch.length - 1] : null;
    const tail = stderr.length > 2000 ? "…" + stderr.slice(-2000) : stderr;
    const prefix = fatalLine ? fatalLine + "\n" : "";
    const errorMessage = `Script test.ts exited with code 1: ${prefix}${tail}`;

    expect(errorMessage).toContain("[develop] FATAL: test failure");
    expect(errorMessage.indexOf("[develop] FATAL:")).toBeLessThan(errorMessage.indexOf("more context"));
  });
});

describe("Envelope structure after gate failure", () => {
  test("gateFailed=true produces correct envelope fields", () => {
    const gateFailed = true;
    const testsPassed = false;
    const testOut = "(skipped — gate failure)";
    const commitSha = "";
    const typecheckPassed = undefined;
    const typecheckOutput = undefined;
    const lintPassed = undefined;
    const lintOutput = undefined;
    const gateFailure = { gate: "plan-alignment", details: "off-plan files" };

    const envelope = {
      tests_passed: gateFailed ? false : testsPassed,
      test_output: gateFailed ? "(skipped — gate failure)" : testOut,
      commit_sha: gateFailed ? "" : commitSha,
      typecheck_passed: gateFailed ? undefined : typecheckPassed,
      typecheck_output: gateFailed ? undefined : typecheckOutput,
      lint_passed: gateFailed ? undefined : lintPassed,
      lint_output: gateFailed ? undefined : lintOutput,
      gates_passed: !gateFailed,
      ...(gateFailure ? { gate_failure: gateFailure } : {}),
    };

    expect(envelope.tests_passed).toBe(false);
    expect(envelope.test_output).toBe("(skipped — gate failure)");
    expect(envelope.commit_sha).toBe("");
    expect(envelope.typecheck_passed).toBeUndefined();
    expect(envelope.typecheck_output).toBeUndefined();
    expect(envelope.lint_passed).toBeUndefined();
    expect(envelope.lint_output).toBeUndefined();
    expect(envelope.gates_passed).toBe(false);
    expect(envelope.gate_failure).toEqual({ gate: "plan-alignment", details: "off-plan files" });
  });

  test("gateFailed=false produces normal envelope fields", () => {
    const gateFailed = false;
    const testsPassed = true;
    const testOut = "5 tests pass";
    const commitSha = "abc123";
    const typecheckPassed = true;
    const typecheckOutput = "";
    const lintPassed = true;
    const lintOutput = "";
    const gateFailure = undefined;

    const envelope = {
      tests_passed: gateFailed ? false : testsPassed,
      test_output: gateFailed ? "(skipped — gate failure)" : testOut,
      commit_sha: gateFailed ? "" : commitSha,
      typecheck_passed: gateFailed ? undefined : typecheckPassed,
      typecheck_output: gateFailed ? undefined : typecheckOutput,
      lint_passed: gateFailed ? undefined : lintPassed,
      lint_output: gateFailed ? undefined : lintOutput,
      gates_passed: !gateFailed,
      ...(gateFailure ? { gate_failure: gateFailure } : {}),
    };

    expect(envelope.tests_passed).toBe(true);
    expect(envelope.test_output).toBe("5 tests pass");
    expect(envelope.commit_sha).toBe("abc123");
    expect(envelope.typecheck_passed).toBe(true);
    expect(envelope.typecheck_output).toBe("");
    expect(envelope.lint_passed).toBe(true);
    expect(envelope.lint_output).toBe("");
    expect(envelope.gates_passed).toBe(true);
    expect(envelope.gate_failure).toBeUndefined();
  });
});
