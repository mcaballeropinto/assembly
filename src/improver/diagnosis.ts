import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type DiagnosisConfidence = "low" | "medium" | "high";

export type DiagnosisAction =
  | "enqueue_repair"
  | "manual"
  | "deduped"
  | "capped"
  | "skipped";

export interface FailureDiagnosis {
  source_line: string;
  file_name: string;
  workpiece_id: string | null;
  station: string | null;
  failure_class: string | null;
  root_cause: string;
  confidence: DiagnosisConfidence;
  evidence: string[];
  recommended_action: string;
  action: DiagnosisAction;
  issue_slug: string;
  title: string;
  task_body: string;
  fingerprint: string;
}

export interface FailureDiagnosisContext {
  lineName: string;
  linePath: string;
  fileName: string;
  filePath: string;
  workpiece: Record<string, unknown>;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...[truncated]`;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function failedStationEntry(
  workpiece: Record<string, unknown>
): [string, Record<string, unknown>] | null {
  const stations = (workpiece.stations ?? {}) as Record<string, Record<string, unknown>>;
  return (
    Object.entries(stations).find(([, s]) => s?.status === "failed") ??
    Object.entries(stations).find(([, s]) => s?.status === "escalated") ??
    null
  );
}

function tryRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function invalidJsonEvidence(path: string): string | null {
  const text = tryRead(path);
  if (!text || !text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return `${path}: invalid JSON (${(err as Error).message})`;
  }
}

function envelopeSidecarCandidates(ctx: FailureDiagnosisContext, station: string | null): string[] {
  const out = [`${ctx.filePath}.envelope.json`];
  if (station) {
    out.push(resolve(ctx.linePath, "stations", station, "queue", "output", `${ctx.fileName}.envelope.json`));
    out.push(resolve(ctx.linePath, "stations", station, "queue", "processing", `${ctx.fileName}.envelope.json`));
  }
  return out;
}

function sessionCandidates(ctx: FailureDiagnosisContext, station: string | null): string[] {
  const out = [`${ctx.filePath}.session.jsonl`];
  if (station) {
    out.push(resolve(ctx.linePath, "stations", station, "queue", "output", `${ctx.fileName}.session.jsonl`));
    out.push(resolve(ctx.linePath, "stations", station, "queue", "processing", `${ctx.fileName}.session.jsonl`));
  }
  return out;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null;
}

function stationText(station: Record<string, unknown> | null): string {
  if (!station) return "";
  const data = station.data as Record<string, unknown> | undefined;
  return [
    stringify(station.summary),
    stringify(station.failure_class),
    stringify(data?.error),
    stringify(station.eval),
  ].join("\n");
}

function fingerprint(parts: string[]): string {
  return parts
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9|:/._-]+/g, "-")
    .slice(0, 220)
    .replace(/-+$/, "");
}

export function diagnoseFailure(ctx: FailureDiagnosisContext): FailureDiagnosis {
  const failed = failedStationEntry(ctx.workpiece);
  const stationName = failed?.[0] ?? null;
  const station = failed?.[1] ?? null;
  const wpId = typeof ctx.workpiece.id === "string" ? ctx.workpiece.id : null;
  const failureClass = typeof station?.failure_class === "string" ? station.failure_class : null;
  const text = stationText(station);
  const evidence: string[] = [];
  if (station?.summary) evidence.push(`summary: ${clip(stringify(station.summary), 180)}`);
  if (failureClass) evidence.push(`failure_class: ${failureClass}`);

  const sidecarEvidence = envelopeSidecarCandidates(ctx, stationName)
    .map(invalidJsonEvidence)
    .find((x): x is string => !!x);
  if (sidecarEvidence) evidence.push(sidecarEvidence);

  const sessionPath = firstExisting(sessionCandidates(ctx, stationName));
  const sessionText = sessionPath ? tryRead(sessionPath) ?? "" : "";
  const fallbackMissingContent =
    /Missing required field: content/i.test(text + "\n" + sessionText) &&
    /Plan envelope written|envelope_path|fallback_bytes/i.test(sessionText) &&
    !/"content"\s*:/.test(sessionText.match(/\{"summary":"Plan envelope written"[\s\S]{0,500}/)?.[0] ?? "");
  if (sessionPath && fallbackMissingContent) {
    evidence.push(`${sessionPath}: fallback assistant JSON omitted content`);
  }

  const missingContentGuardrail = /Missing required field: content/i.test(text);
  if (missingContentGuardrail && (sidecarEvidence || fallbackMissingContent)) {
    const fp = fingerprint([
      ctx.lineName,
      wpId ?? ctx.fileName,
      stationName ?? "unknown-station",
      "malformed-envelope-missing-content",
    ]);
    return {
      source_line: ctx.lineName,
      file_name: ctx.fileName,
      workpiece_id: wpId,
      station: stationName,
      failure_class: failureClass,
      root_cause: "malformed-envelope-sidecar",
      confidence: "high",
      evidence: evidence.slice(0, 4),
      recommended_action: "Enqueue an assembly-dev repair task for the envelope watcher/provider protocol.",
      action: "enqueue_repair",
      issue_slug: "malformed-envelope-sidecar",
      title: "Repair malformed envelope sidecar fallback handling",
      task_body: [
        "A failed Assembly workpiece shows the envelope watcher/provider path accepted a malformed sidecar or fell back to incomplete assistant JSON.",
        "",
        `Source failure: ${ctx.lineName}/${wpId ?? ctx.fileName}`,
        `Failed station: ${stationName ?? "unknown"}`,
        "",
        "Evidence:",
        ...evidence.slice(0, 6).map((line) => `- ${line}`),
        "",
        "Fix the provider/envelope-writing path so a malformed sidecar cannot degrade into a guardrail-valid-looking fallback that omits required fields. Prefer structured file writes or JSON serialization over shell heredoc composition for station envelopes, and make the watcher/diagnostics preserve enough evidence for repair.",
        "",
        "Acceptance criteria:",
        "- A malformed envelope sidecar plus fallback JSON missing a required field is diagnosed deterministically.",
        "- The station either repairs the envelope or reports the malformed sidecar as the root cause without hiding behind the fallback assistant message.",
        "- Add focused tests for the malformed sidecar/fallback-missing-content case.",
      ].join("\n"),
      fingerprint: fp,
    };
  }

  const codeFailure = /tests? failed|bun test exited|typecheck failed|tsc --noEmit|lint failed|eslint|deploy\.ts exited|rebase conflict|conflict markers|gate_failure|plan-alignment|envelope-scope/i.test(text);
  if (codeFailure) {
    const fp = fingerprint([
      ctx.lineName,
      wpId ?? ctx.fileName,
      stationName ?? "unknown-station",
      failureClass ?? "code-validation",
      clip(text, 180),
    ]);
    return {
      source_line: ctx.lineName,
      file_name: ctx.fileName,
      workpiece_id: wpId,
      station: stationName,
      failure_class: failureClass,
      root_cause: "code-validation-failure",
      confidence: "high",
      evidence: evidence.slice(0, 4),
      recommended_action: "Enqueue an assembly-dev repair task with the validation evidence.",
      action: "enqueue_repair",
      issue_slug: "code-validation-failure",
      title: "Repair failed Assembly validation task",
      task_body: [
        "An Assembly workpiece failed local validation in a way that appears repairable by a focused code change.",
        "",
        `Source failure: ${ctx.lineName}/${wpId ?? ctx.fileName}`,
        `Failed station: ${stationName ?? "unknown"}`,
        "",
        "Evidence:",
        ...evidence.slice(0, 6).map((line) => `- ${line}`),
        "",
        "Fix the implementation that caused this validation failure. Keep the change scoped to the failing behavior and add or update tests that reproduce the evidence above.",
      ].join("\n"),
      fingerprint: fp,
    };
  }

  const fp = fingerprint([
    ctx.lineName,
    wpId ?? ctx.fileName,
    stationName ?? "unknown-station",
    failureClass ?? "unknown",
    clip(text, 160),
  ]);
  return {
    source_line: ctx.lineName,
    file_name: ctx.fileName,
    workpiece_id: wpId,
    station: stationName,
    failure_class: failureClass,
    root_cause: failureClass === "provider" || failureClass === "timeout" || failureClass === "aborted"
      ? "transient-or-runtime-failure"
      : "unknown-failure",
    confidence: "low",
    evidence: evidence.slice(0, 4),
    recommended_action: "Report once for human review; do not auto-repair without stronger evidence.",
    action: "manual",
    issue_slug: "unknown-failure",
    title: "Review Assembly failure",
    task_body: "",
    fingerprint: fp,
  };
}

export function formatDiagnosisReport(d: FailureDiagnosis): string {
  const lines = [
    `🧭 **improver diagnosis** — ${d.source_line}`,
    `source \`${d.workpiece_id ?? d.file_name}\`${d.station ? ` · station \`${d.station}\`` : ""}${d.failure_class ? ` · ${d.failure_class}` : ""}`,
    `root cause: \`${d.root_cause}\` · confidence: **${d.confidence}**`,
  ];
  if (d.evidence.length > 0) {
    lines.push("evidence:");
    for (const ev of d.evidence.slice(0, 4)) lines.push(`• ${clip(ev.replace(/\s+/g, " "), 260)}`);
  }
  lines.push(`next: ${d.recommended_action}`);
  lines.push(`action: ${d.action}`);
  lines.push(`fingerprint: \`${clip(d.fingerprint, 120)}\``);
  return lines.join("\n");
}
