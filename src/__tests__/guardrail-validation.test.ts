import { describe, it, expect } from "bun:test";
import { validateGuardrails, buildGuardrailRepairPrompt, GuardrailError } from "../envelope";
import { buildGuardrailRepairPlan } from "../section-worker";
import type { StationConfig, StationEnvelope, LLMMessage } from "../types";
import { StationName } from "../ids";

function station(guardrails: StationConfig["guardrails"]): StationConfig {
  return {
    name: StationName("test"),
    dir: "/tmp/test",
    memoryDir: "/tmp/test/memory",
    prompt: "",
    guardrails,
  };
}

describe("validateGuardrails — required paths", () => {
  const s = station({ output: { required: ["data.scored_items"] } });

  it("passes when required dotted path resolves", () => {
    const env: StationEnvelope = { summary: "ok", data: { scored_items: [{}] } };
    expect(validateGuardrails(env, s)).toEqual([]);
  });

  it("fails when required dotted path is missing", () => {
    const env: StationEnvelope = { summary: "ok", data: { other: 1 } };
    const errors = validateGuardrails(env, s);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("data.scored_items");
  });

  it("fails when entire data object is missing", () => {
    const env: StationEnvelope = { summary: "ok" };
    const errors = validateGuardrails(env, s);
    expect(errors[0]).toContain("data.scored_items");
  });

  it("skips the always-present `summary` path even when listed", () => {
    const env: StationEnvelope = { summary: "ok" };
    const s2 = station({ output: { required: ["summary"] } });
    expect(validateGuardrails(env, s2)).toEqual([]);
  });
});

describe("validateGuardrails — forbidden paths (adjacent-task drift)", () => {
  const s = station({
    output: { forbidden: ["data.enriched_items"] },
  });

  it("passes when forbidden path is absent", () => {
    const env: StationEnvelope = { summary: "ok", data: { scored_items: [] } };
    expect(validateGuardrails(env, s)).toEqual([]);
  });

  it("fails when forbidden path is present — catches today's failure mode", () => {
    // The exact drift we saw: score station emitted data.enriched_items instead
    // of data.scored_items. This guardrail must flag it.
    const env: StationEnvelope = {
      summary: "Enriched 15 of 15 jobs",
      data: { enriched_items: [{ title: "EM" }], enriched_count: 15 },
    };
    const errors = validateGuardrails(env, s);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("data.enriched_items");
  });
});

describe("validateGuardrails — schema type checks", () => {
  it("accepts flat data-subkey form (back-compat with existing assembly-dev stations)", () => {
    const s = station({ output: { schema: { data: { scored_items: "array" } } } });
    const pass: StationEnvelope = { summary: "ok", data: { scored_items: [] } };
    const fail: StationEnvelope = { summary: "ok", data: { scored_items: "not-array" } };
    expect(validateGuardrails(pass, s)).toEqual([]);
    expect(validateGuardrails(fail, s)[0]).toContain("expected array");
  });

  it("correctly distinguishes arrays from objects (fixes typeof check)", () => {
    const s = station({ output: { schema: { data: { items: "array" } } } });
    const objNotArray: StationEnvelope = { summary: "ok", data: { items: { foo: "bar" } } };
    expect(validateGuardrails(objNotArray, s)[0]).toContain("expected array, got object");
  });

  it("accepts dotted-path form with object spec", () => {
    const s = station({
      output: { schema: { "data.scored_items": { type: "array", minItems: 1 } } },
    });
    const empty: StationEnvelope = { summary: "ok", data: { scored_items: [] } };
    const ok: StationEnvelope = { summary: "ok", data: { scored_items: [{}] } };
    expect(validateGuardrails(empty, s)[0]).toContain(">= 1 items");
    expect(validateGuardrails(ok, s)).toEqual([]);
  });

  it("does not flag missing paths as schema errors (required handles that)", () => {
    // Schema should be "if present, must match" — presence is `required`'s job.
    const s = station({ output: { schema: { "data.optional": "string" } } });
    const env: StationEnvelope = { summary: "ok", data: {} };
    expect(validateGuardrails(env, s)).toEqual([]);
  });
});

describe("validateGuardrails — enum / range / array element", () => {
  // Real bug being tested: score station emitted tier "strong_match" instead
  // of "strong_prospect" and 15 prospects were silently dropped at push time.
  const tierEnumStation = station({
    output: {
      schema: {
        "data.scored_items[].tier": {
          enum: ["strong_prospect", "worth_watching", "pass"],
        },
      },
    },
  });

  it("passes when every element's tier is in the enum", () => {
    const env: StationEnvelope = {
      summary: "ok",
      data: {
        scored_items: [
          { name: "A", tier: "strong_prospect" },
          { name: "B", tier: "worth_watching" },
          { name: "C", tier: "pass" },
        ],
      },
    };
    expect(validateGuardrails(env, tierEnumStation)).toEqual([]);
  });

  it("flags every element whose tier is outside the enum (catches the 2026-04-21 drift)", () => {
    const env: StationEnvelope = {
      summary: "ok",
      data: {
        scored_items: [
          { name: "A", tier: "strong_match" },
          { name: "B", tier: "watch" },
          { name: "C", tier: "pass" },
        ],
      },
    };
    const errors = validateGuardrails(env, tierEnumStation);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("data.scored_items.0.tier");
    expect(errors[0]).toContain("strong_prospect");
    expect(errors[1]).toContain("data.scored_items.1.tier");
  });

  it("enforces numeric ranges on per-element scores", () => {
    const s = station({
      output: {
        schema: {
          "data.scored_items[].scores.culture_sustainability": {
            type: "number",
            minimum: 0,
            maximum: 20,
          },
        },
      },
    });
    const env: StationEnvelope = {
      summary: "ok",
      data: {
        scored_items: [
          { name: "A", scores: { culture_sustainability: 18 } },
          { name: "B", scores: { culture_sustainability: 25 } }, // out of range
          { name: "C", scores: { culture_sustainability: -1 } }, // out of range
        ],
      },
    };
    const errors = validateGuardrails(env, s);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("data.scored_items.1");
    expect(errors[0]).toContain("<= 20");
    expect(errors[1]).toContain("data.scored_items.2");
    expect(errors[1]).toContain(">= 0");
  });

  it("enum check works on a non-array dotted path too", () => {
    const s = station({
      output: { schema: { "data.status": { enum: ["ok", "fail"] } } },
    });
    const ok: StationEnvelope = { summary: "ok", data: { status: "ok" } };
    const bad: StationEnvelope = { summary: "ok", data: { status: "weird" } };
    expect(validateGuardrails(ok, s)).toEqual([]);
    expect(validateGuardrails(bad, s)[0]).toContain("expected one of");
  });

  it("does not flag elements when the array path itself is missing", () => {
    // Required-ness is `required`'s job, not schema's.
    const env: StationEnvelope = { summary: "ok", data: {} };
    expect(validateGuardrails(env, tierEnumStation)).toEqual([]);
  });

  it("does not flag elements whose target subfield is missing", () => {
    const env: StationEnvelope = {
      summary: "ok",
      data: { scored_items: [{ name: "A" /* no tier */ }] },
    };
    expect(validateGuardrails(env, tierEnumStation)).toEqual([]);
  });
});

describe("buildGuardrailRepairPrompt", () => {
  const guardrails = {
    required: ["data.scored_items"],
    forbidden: ["data.enriched_items"],
    schema: { "data.scored_items": { type: "array", minItems: 1 } },
  };

  it("quotes the violations and the schema contract", () => {
    const prompt = buildGuardrailRepairPrompt(
      '{"summary":"wrong","data":{"enriched_items":[]}}',
      ["Forbidden field present: data.enriched_items", "Missing required field: data.scored_items"],
      guardrails
    );
    expect(prompt).toContain("valid JSON but violated");
    expect(prompt).toContain("data.enriched_items");
    expect(prompt).toContain("data.scored_items");
    expect(prompt).toContain("Required fields");
    expect(prompt).toContain("Forbidden fields");
    expect(prompt).toContain("Schema:");
  });

  it("quotes the broken JSON up to 2000 chars", () => {
    const big = "x".repeat(3000);
    const prompt = buildGuardrailRepairPrompt(big, ["err"], undefined);
    const quoted = prompt.split("Here is the JSON you produced:\n")[1]?.split("\n\n")[0] ?? "";
    expect(quoted.length).toBe(2000);
  });

  it("forbids tool calls and code fences (same contract as envelope repair)", () => {
    const prompt = buildGuardrailRepairPrompt("{}", ["x"], undefined);
    expect(prompt).toContain("no code fences");
    expect(prompt).toContain("no tool calls");
  });
});

describe("buildGuardrailRepairPlan", () => {
  const originalMessages: LLMMessage[] = [
    { role: "system", content: "You are the score station." },
    { role: "user", content: "Score these items." },
  ];

  it("seeds the assistant turn with the shape-violating envelope JSON", () => {
    const envJson = '{"summary":"wrong","data":{"enriched_items":[1,2]}}';
    const plan = buildGuardrailRepairPlan(
      originalMessages,
      envJson,
      ["Forbidden field present: data.enriched_items"],
      { forbidden: ["data.enriched_items"] }
    );
    expect(plan.messages).toHaveLength(4);
    expect(plan.messages[0]).toEqual(originalMessages[0]);
    expect(plan.messages[1]).toEqual(originalMessages[1]);
    expect(plan.messages[2]).toEqual({ role: "assistant", content: envJson });
    expect(plan.messages[3].role).toBe("user");
    expect(plan.messages[3].content).toContain("data.enriched_items");
    expect(plan.seedSource).toBe("content");
  });
});

describe("GuardrailError", () => {
  it("carries the violation list for dashboards to render", () => {
    const err = new GuardrailError(["Missing required field: data.x", "Forbidden field present: data.y"]);
    expect(err.violations).toHaveLength(2);
    expect(err.message).toContain("data.x");
    expect(err.message).toContain("data.y");
    expect(err.name).toBe("GuardrailError");
  });
});
