import { describe, it, expect } from "bun:test";
import { buildRepairPrompt } from "../envelope";

describe("buildRepairPrompt", () => {
  it("uses rawResponse as the seed when present", () => {
    const prompt = buildRepairPrompt("broken { json", "Unexpected token");
    expect(prompt).toContain("Here is the text you produced:");
    expect(prompt).toContain("broken { json");
    expect(prompt).toContain("Unexpected token");
    expect(prompt).toContain("Respond now with ONLY valid JSON");
    expect(prompt).toContain("do not call tools");
  });

  it("falls back to fallbackText when rawResponse is empty", () => {
    const prompt = buildRepairPrompt("", "no content", "salvaged stream text");
    expect(prompt).toContain("Here is the text you produced:");
    expect(prompt).toContain("salvaged stream text");
    expect(prompt).not.toContain("finished without producing");
  });

  it("prefers rawResponse over fallbackText when both exist", () => {
    const prompt = buildRepairPrompt("raw-seed", "err", "fallback-seed");
    expect(prompt).toContain("raw-seed");
    expect(prompt).not.toContain("fallback-seed");
  });

  it("uses the empty-seed form when neither source has content", () => {
    const prompt = buildRepairPrompt("", "timeout", undefined);
    expect(prompt).toContain("finished without producing the required JSON output");
    expect(prompt).toContain("timeout");
    expect(prompt).not.toContain("Here is the text you produced:");
  });

  it("treats an empty fallbackText string as absent", () => {
    const prompt = buildRepairPrompt("", "nope", "");
    expect(prompt).toContain("finished without producing the required JSON output");
  });

  it("quotes seed up to 2000 chars", () => {
    const big = "x".repeat(3000);
    const prompt = buildRepairPrompt(big, "too long");
    const quoted = prompt.split("Here is the text you produced:\n")[1].split("\n\n")[0];
    expect(quoted.length).toBe(2000);
  });

  it("always instructs minimum-valid JSON shape", () => {
    const prompt = buildRepairPrompt("anything", "x");
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"content"');
    expect(prompt).toContain('"data"');
  });
});
