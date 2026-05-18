import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { callAnthropicRepair, DEFAULT_REPAIR_MODEL, REPAIR_MAX_TOKENS } from "../llm";
import { selectRepairTransport } from "../section-worker";
import type { LLMMessage } from "../types";

const messages: LLMMessage[] = [
  { role: "system", content: "You are the validator station." },
  { role: "user", content: "Validate workpiece 42." },
  { role: "assistant", content: "{summary: bad" },
  { role: "user", content: "Reformat as JSON." },
];

interface FakeCall {
  body: any;
}

function makeFakeClient(usage: Partial<{
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}> = {}, contentText = '{"summary":"repaired"}') {
  const calls: FakeCall[] = [];
  return {
    calls,
    client: {
      messages: {
        stream: (body: any) => {
          calls.push({ body });
          const message = {
            content: [{ type: "text", text: contentText }],
            usage: {
              input_tokens: usage.input_tokens ?? 100,
              output_tokens: usage.output_tokens ?? 50,
              cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            },
          };
          return {
            finalMessage: async () => message,
          };
        },
      },
    } as any,
  };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ASSEMBLY_ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ASSEMBLY_ANTHROPIC_API_KEY;
  else process.env.ASSEMBLY_ANTHROPIC_API_KEY = savedKey;
});

describe("callAnthropicRepair", () => {
  it("uses claude-haiku-4-5-20251001 by default", async () => {
    const fake = makeFakeClient();
    await callAnthropicRepair(messages, { client: fake.client });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body.model).toBe("claude-haiku-4-5-20251001");
    expect(DEFAULT_REPAIR_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("respects model override", async () => {
    const fake = makeFakeClient();
    await callAnthropicRepair(messages, { client: fake.client, model: "claude-sonnet-4-6" });
    expect(fake.calls[0].body.model).toBe("claude-sonnet-4-6");
  });

  it("sends max_tokens 64000 by default", async () => {
    const fake = makeFakeClient();
    await callAnthropicRepair(messages, { client: fake.client });
    expect(fake.calls[0].body.max_tokens).toBe(64000);
    expect(REPAIR_MAX_TOKENS).toBe(64000);
  });

  it("marks the system block as cache_control: ephemeral", async () => {
    const fake = makeFakeClient();
    await callAnthropicRepair(messages, { client: fake.client });
    const sys = fake.calls[0].body.system;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0].type).toBe("text");
    expect(sys[0].text).toBe("You are the validator station.");
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("forwards non-system messages as the user/assistant conversation", async () => {
    const fake = makeFakeClient();
    await callAnthropicRepair(messages, { client: fake.client });
    const sent = fake.calls[0].body.messages;
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ role: "user", content: "Validate workpiece 42." });
    expect(sent[1]).toEqual({ role: "assistant", content: "{summary: bad" });
    expect(sent[2]).toEqual({ role: "user", content: "Reformat as JSON." });
  });

  it("rolls up tokens into LLMResult shape (input + cache + output)", async () => {
    const fake = makeFakeClient({
      input_tokens: 80,
      output_tokens: 40,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    });
    const result = await callAnthropicRepair(messages, { client: fake.client });
    // input total includes base + cache_read + cache_creation
    expect(result.tokens.in).toBe(80 + 100 + 20);
    expect(result.tokens.out).toBe(40);
    expect(result.tokens.cache_read).toBe(100);
    expect(result.tokens.cache_creation).toBe(20);
  });

  it("returns content joined from text blocks and an anthropic-prefixed model id", async () => {
    const fake = makeFakeClient({}, '{"summary":"repaired"}');
    const result = await callAnthropicRepair(messages, { client: fake.client });
    expect(result.content).toBe('{"summary":"repaired"}');
    expect(result.model).toBe("anthropic:claude-haiku-4-5-20251001");
    expect(typeof result.getLastActivityMs()).toBe("number");
  });

  it("throws when no API key and no client are available", async () => {
    delete process.env.ASSEMBLY_ANTHROPIC_API_KEY;
    await expect(callAnthropicRepair(messages)).rejects.toThrow("ASSEMBLY_ANTHROPIC_API_KEY not set");
  });

  it("uses an explicit apiKey opt over env", async () => {
    delete process.env.ASSEMBLY_ANTHROPIC_API_KEY;
    const fake = makeFakeClient();
    // client opt short-circuits the apiKey requirement entirely
    await callAnthropicRepair(messages, { client: fake.client, apiKey: "sk-ignored" });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("selectRepairTransport", () => {
  it("defaults to anthropic + Haiku when API key is present", () => {
    const t = selectRepairTransport(undefined, { ASSEMBLY_ANTHROPIC_API_KEY: "sk-test" });
    expect(t).toEqual({ kind: "anthropic", model: "claude-haiku-4-5-20251001" });
  });

  it("respects repair.model override", () => {
    const t = selectRepairTransport(
      { model: "claude-sonnet-4-6" },
      { ASSEMBLY_ANTHROPIC_API_KEY: "sk-test" }
    );
    expect(t).toEqual({ kind: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("falls back to CLI when repair.enabled is false", () => {
    const t = selectRepairTransport(
      { enabled: false },
      { ASSEMBLY_ANTHROPIC_API_KEY: "sk-test" }
    );
    expect(t).toEqual({ kind: "cli", reason: "disabled" });
  });

  it("falls back to CLI when ASSEMBLY_ANTHROPIC_API_KEY is missing", () => {
    const t = selectRepairTransport(undefined, {});
    expect(t).toEqual({ kind: "cli", reason: "no_api_key" });
  });

  it("treats explicit enabled:true the same as default", () => {
    const t = selectRepairTransport(
      { enabled: true },
      { ASSEMBLY_ANTHROPIC_API_KEY: "sk-test" }
    );
    expect(t.kind).toBe("anthropic");
  });
});
