import { basename } from "path";
import { StationName } from "./ids";
import type { StationResult, Workpiece } from "./types";

export interface PlanContractRepairResult {
  repaired: boolean;
  reason: string;
  added: string[];
  workpiece: Workpiece;
}

const DEVELOP_STATION = StationName("develop");
const PLAN_STATION = StationName("plan");
const REPAIR_LIMIT = 1;

function planData(workpiece: Workpiece): Record<string, unknown> | null {
  const data = workpiece.stations?.[PLAN_STATION]?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

function repairState(workpiece: Workpiece): { count: number } {
  const input = workpiece.input as Record<string, unknown>;
  const state = input.plan_contract_repair;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { count: 0 };
  }
  const count = (state as { count?: unknown }).count;
  return { count: typeof count === "number" ? count : 0 };
}

function extractOffPlanPaths(feedback: string): string[] {
  const lines = feedback.split(/\r?\n/);
  const paths: string[] = [];
  let inOffPlan = false;

  for (const line of lines) {
    if (/^Off-plan:\s*$/.test(line.trim())) {
      inOffPlan = true;
      continue;
    }
    if (!inOffPlan) continue;
    if (/^(Do NOT|Fix the issue|Planned:|Details:)/.test(line.trim())) break;
    const match = line.match(/^\s*-\s+(.+?)\s*$/);
    if (match) paths.push(match[1]);
    else if (line.trim() && !line.startsWith(" ")) break;
  }

  return [...new Set(paths)];
}

function isSafeAutoRepairPath(path: string, workpiece: Workpiece): boolean {
  if (path.includes("\0") || path.includes("..") || path.startsWith("/") || path.startsWith("\\")) {
    return false;
  }

  const dashboardAffected = planData(workpiece)?.dashboard_affected === true;

  if (dashboardAffected && path.startsWith("web/")) return true;
  if (dashboardAffected && path.startsWith("scripts/dashboard-")) return true;
  if (dashboardAffected && ["package.json", "bun.lock", "tsconfig.json"].includes(path)) return true;

  return false;
}

function compressedPlanSpec(path: string): string {
  if (path.startsWith("web/dist/")) return "web/dist/";
  if (path.startsWith("web/src/components/ui/")) return "web/src/components/ui/";
  if (path.startsWith("web/src/components/drawer/")) return "web/src/components/drawer/";
  if (path.startsWith("web/src/components/") && basename(path).includes(".test.")) {
    return path;
  }
  return path;
}

function appendUnique(list: unknown, specs: string[]): string[] {
  const out = Array.isArray(list)
    ? list.filter((item): item is string => typeof item === "string")
    : [];
  for (const spec of specs) {
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

function preserveDevelopAttempt(workpiece: Workpiece): Workpiece {
  const current = workpiece.stations?.[DEVELOP_STATION];
  if (!current) return workpiece;

  const { previous_attempts: previousAttempts, ...flatCurrent } = current;
  const attempts = Array.isArray(previousAttempts) ? previousAttempts : [];
  const nextDevelop: StationResult = {
    ...current,
    previous_attempts: [...attempts, flatCurrent],
  };

  return {
    ...workpiece,
    stations: {
      ...workpiece.stations,
      [DEVELOP_STATION]: nextDevelop,
    },
  };
}

export function repairPlanAlignmentContract(workpiece: Workpiece): PlanContractRepairResult {
  const develop = workpiece.stations?.[DEVELOP_STATION];
  const feedback =
    typeof develop?.eval?.feedback === "string"
      ? develop.eval.feedback
      : typeof develop?.data?.escalation_reason === "string"
        ? develop.data.escalation_reason
        : develop?.summary ?? "";

  if (!/Safety gate failed:\s*plan-alignment|gate_failure.+plan-alignment|plan-alignment/i.test(feedback)) {
    return { repaired: false, reason: "not a plan-alignment failure", added: [], workpiece };
  }

  const state = repairState(workpiece);
  if (state.count >= REPAIR_LIMIT) {
    return { repaired: false, reason: "plan contract repair already attempted", added: [], workpiece };
  }

  const offPlan = extractOffPlanPaths(feedback);
  if (offPlan.length === 0) {
    return { repaired: false, reason: "no off-plan paths found in feedback", added: [], workpiece };
  }

  const unsafe = offPlan.filter((path) => !isSafeAutoRepairPath(path, workpiece));
  if (unsafe.length > 0) {
    return {
      repaired: false,
      reason: `off-plan paths outside auto-repair allowlist: ${unsafe.join(", ")}`,
      added: [],
      workpiece,
    };
  }

  const plan = planData(workpiece);
  if (!plan) {
    return { repaired: false, reason: "plan data missing", added: [], workpiece };
  }

  const added = [...new Set(offPlan.map(compressedPlanSpec))];
  const repairedPlan = {
    ...plan,
    files_to_change: appendUnique(plan.files_to_change, added),
    files_to_create: appendUnique(plan.files_to_create, []),
    plan_contract_repaired_at: new Date().toISOString(),
    plan_contract_repair_added: added,
  };

  const next = preserveDevelopAttempt({
    ...workpiece,
    input: {
      ...workpiece.input,
      plan_contract_repair: {
        count: state.count + 1,
        repaired_at: new Date().toISOString(),
        added,
        source_station: "develop",
      },
    },
    stations: {
      ...workpiece.stations,
      [PLAN_STATION]: {
        ...workpiece.stations[PLAN_STATION],
        data: repairedPlan,
      },
    },
  });

  return {
    repaired: true,
    reason: `added ${added.length} plan contract path spec(s)`,
    added,
    workpiece: next,
  };
}
