import { describe, test, expect } from "bun:test";
import { calculateCost, calculateCostWithCache } from "../pricing";
import type { TokenUsage, Provider } from "../types";

describe("calculateCostWithCache", () => {
  test("produces correct cost with cache breakdown for Sonnet", () => {
    // Sonnet: $3/M input, $15/M output
    // 1000 base input + 5000 cache_read + 2000 cache_creation + 500 output
    // base: 1000 * 3 / 1M = 0.003
    // cache_read: 5000 * 0.3 / 1M = 0.0015
    // cache_creation: 2000 * 3.75 / 1M = 0.0075
    // output: 500 * 15 / 1M = 0.0075
    // total = 0.003 + 0.0015 + 0.0075 + 0.0075 = 0.0195
    const totalIn = 1000 + 5000 + 2000; // 8000 total input tokens
    const cost = calculateCostWithCache("sonnet", totalIn, 500, 5000, 2000);
    expect(cost).toBeCloseTo(0.0195, 6);
  });

  test("with zero cache fields equals calculateCost", () => {
    const model = "sonnet";
    const tokensIn = 1000;
    const tokensOut = 500;
    const costWithCache = calculateCostWithCache(model, tokensIn, tokensOut, 0, 0);
    const costWithout = calculateCost(model, tokensIn, tokensOut);
    expect(costWithCache).toBe(costWithout);
  });

  test("cache-aware cost is lower than base cost when cache_read > 0", () => {
    const model = "sonnet";
    const totalIn = 10000; // all tokens
    const tokensOut = 500;
    // Without cache: all 10000 tokens at base rate
    const baseCost = calculateCost(model, totalIn, tokensOut);
    // With cache: 5000 of those tokens are cache reads (10% of base rate)
    const cachedCost = calculateCostWithCache(model, totalIn, tokensOut, 5000, 0);
    expect(cachedCost).toBeLessThan(baseCost);
  });

  test("script model returns 0 cost", () => {
    const cost = calculateCostWithCache("script", 1000, 500, 500, 200);
    expect(cost).toBe(0);
  });

  test("opus pricing with cache breakdown", () => {
    // Opus: $15/M input, $75/M output
    // 1000 base + 5000 cache_read + 2000 cache_creation + 500 output
    // base: 1000 * 15 / 1M = 0.015
    // cache_read: 5000 * 1.5 / 1M = 0.0075
    // cache_creation: 2000 * 18.75 / 1M = 0.0375
    // output: 500 * 75 / 1M = 0.0375
    // total = 0.015 + 0.0075 + 0.0375 + 0.0375 = 0.0975
    const totalIn = 1000 + 5000 + 2000;
    const cost = calculateCostWithCache("opus", totalIn, 500, 5000, 2000);
    expect(cost).toBeCloseTo(0.0975, 6);
  });
});

describe("TokenUsage backward compatibility", () => {
  test("objects with only { in, out } work correctly", () => {
    const usage: TokenUsage = { in: 100, out: 50 };
    expect(usage.in).toBe(100);
    expect(usage.out).toBe(50);
    expect(usage.cache_read).toBeUndefined();
    expect(usage.cache_creation).toBeUndefined();

    // JSON roundtrip preserves structure
    const json = JSON.stringify(usage);
    const parsed = JSON.parse(json) as TokenUsage;
    expect(parsed.in).toBe(100);
    expect(parsed.out).toBe(50);
    expect(parsed.cache_read).toBeUndefined();
    expect(parsed.cache_creation).toBeUndefined();
  });

  test("objects with cache fields preserve all fields", () => {
    const usage: TokenUsage = { in: 100, out: 50, cache_read: 30, cache_creation: 20 };
    expect(usage.in).toBe(100);
    expect(usage.out).toBe(50);
    expect(usage.cache_read).toBe(30);
    expect(usage.cache_creation).toBe(20);

    // JSON roundtrip preserves all fields
    const json = JSON.stringify(usage);
    const parsed = JSON.parse(json) as TokenUsage;
    expect(parsed.in).toBe(100);
    expect(parsed.out).toBe(50);
    expect(parsed.cache_read).toBe(30);
    expect(parsed.cache_creation).toBe(20);
  });

  test("cache fields can be accumulated via null-coalescing", () => {
    const a: TokenUsage = { in: 100, out: 50 };
    const b: TokenUsage = { in: 200, out: 100, cache_read: 50, cache_creation: 30 };

    // This is the pattern used in runner.ts
    const cumulative = {
      in: a.in + b.in,
      out: a.out + b.out,
      cache_read: (a.cache_read ?? 0) + (b.cache_read ?? 0),
      cache_creation: (a.cache_creation ?? 0) + (b.cache_creation ?? 0),
    };

    expect(cumulative.in).toBe(300);
    expect(cumulative.out).toBe(150);
    expect(cumulative.cache_read).toBe(50);
    expect(cumulative.cache_creation).toBe(30);
  });
});

describe("Provider type", () => {
  test("claude-code-cached is a valid Provider value", () => {
    // Compile-time check: this should not cause a TS error
    const provider: Provider = "claude-code-cached";
    expect(provider).toBe("claude-code-cached");
  });

  test("claude-code remains a valid Provider value", () => {
    const provider: Provider = "claude-code";
    expect(provider).toBe("claude-code");
  });

  test("script remains a valid Provider value", () => {
    const provider: Provider = "script";
    expect(provider).toBe("script");
  });
});
