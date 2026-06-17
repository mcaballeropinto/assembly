import { describe, expect, test } from "bun:test";
import { repairPlanAlignmentContract } from "../plan-contract-repair";
import { LineName, StationName, WorkpieceId } from "../ids";
import type { Workpiece } from "../types";

function makeWorkpiece(feedback: string, dashboardAffected = true): Workpiece {
  return {
    id: WorkpieceId("run_repair_test"),
    line: LineName("assembly-dev"),
    task: "Implement dashboard thing",
    input: {},
    stations: {
      [StationName("plan")]: {
        status: "done",
        summary: "plan",
        data: {
          files_to_change: ["web/src/app.tsx"],
          files_to_create: [],
          dashboard_affected: dashboardAffected,
        },
        started_at: "2026-06-17T00:00:00Z",
        finished_at: "2026-06-17T00:00:01Z",
        model: "test",
        tokens: { in: 0, out: 0 },
        cost_usd: 0,
      },
      [StationName("develop")]: {
        status: "escalated",
        summary: "Escalated: plan alignment",
        data: { escalation_reason: feedback },
        eval: { pass: false, feedback, action: "retry" },
        started_at: "2026-06-17T00:00:01Z",
        finished_at: "2026-06-17T00:00:02Z",
        model: "script",
        tokens: { in: 0, out: 0 },
        cost_usd: 0,
      },
    },
  };
}

const feedback = `Develop produced code that doesn't pass all quality gates.

## Safety gate failed: plan-alignment

Details:
Changed files extend beyond plan.files_to_change ∪ plan.files_to_create.
Planned:
  - web/src/app.tsx
Off-plan:
  - web/dist/assets/index-abc123.js
  - web/src/components/ui/button.tsx
  - web/src/components/drawer/station-timeline.tsx
Do NOT touch these off-plan files on the next attempt.`;

describe("repairPlanAlignmentContract", () => {
  test("adds safe dashboard off-plan paths and preserves develop feedback", () => {
    const result = repairPlanAlignmentContract(makeWorkpiece(feedback));

    expect(result.repaired).toBe(true);
    expect(result.added).toContain("web/dist/");
    expect(result.added).toContain("web/src/components/ui/");
    expect(result.added).toContain("web/src/components/drawer/");

    const plan = result.workpiece.stations[StationName("plan")].data as any;
    expect(plan.files_to_change).toContain("web/dist/");
    expect(plan.files_to_change).toContain("web/src/components/ui/");
    expect(plan.files_to_change).toContain("web/src/components/drawer/");
    expect((result.workpiece.input as any).plan_contract_repair.count).toBe(1);

    const attempts = result.workpiece.stations[StationName("develop")].previous_attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.eval!.feedback).toContain("plan-alignment");
  });

  test("does not repair unsafe source paths", () => {
    const unsafe = feedback.replace(
      "  - web/src/components/ui/button.tsx",
      "  - src/llm.ts"
    );
    const result = repairPlanAlignmentContract(makeWorkpiece(unsafe));

    expect(result.repaired).toBe(false);
    expect(result.reason).toContain("outside auto-repair allowlist");
  });

  test("only repairs a workpiece once", () => {
    const first = repairPlanAlignmentContract(makeWorkpiece(feedback));
    const second = repairPlanAlignmentContract(first.workpiece);

    expect(first.repaired).toBe(true);
    expect(second.repaired).toBe(false);
    expect(second.reason).toContain("already attempted");
  });
});
