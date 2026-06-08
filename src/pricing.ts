/**
 * Token cost calculation for LLM providers.
 * Prices are per million tokens (USD).
 */

interface ModelPricing {
  input: number;  // $ per 1M input tokens
  output: number; // $ per 1M output tokens
}

// Pricing table — update when models or prices change
const PRICING: Record<string, ModelPricing> = {
  // Claude 4 / 4.5 / 4.6
  "claude-opus-4-6":             { input: 15, output: 75 },
  "claude-opus-4-20250514":      { input: 15, output: 75 },
  "claude-sonnet-4-6":           { input: 3,  output: 15 },
  "claude-sonnet-4-20250514":    { input: 3,  output: 15 },
  "claude-haiku-4-5-20251001":   { input: 0.80, output: 4 },

  // Aliases used by claude-code / pi providers
  "opus":   { input: 15, output: 75 },
  "sonnet": { input: 3,  output: 15 },
  "haiku":  { input: 0.80, output: 4 },

  // Claude 3.5 (legacy)
  "claude-3-5-sonnet-20241022":  { input: 3, output: 15 },
  "claude-3-5-haiku-20241022":   { input: 0.80, output: 4 },

  // Codex / OpenAI (GPT-5.x). Standard API list prices per 1M tokens; cached
  // input drops to 10% (handled by calculateCostWithCache). Codex runs against
  // a ChatGPT subscription so no per-call API billing actually occurs, but we
  // price usage explicitly — same as the claude-code provider — so the
  // dashboard reports a real cost-equivalent. Update on OpenAI price changes.
  "gpt-5.5":       { input: 5,    output: 30 },
  "gpt-5.4":       { input: 2.50, output: 15 },
  "gpt-5.4-mini":  { input: 0.75, output: 4.50 },

  // Script provider (no LLM — zero cost)
  "script": { input: 0, output: 0 },
};

// Default fallback if model not found
const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15 };

/**
 * Calculate cost in USD for a given model and token counts.
 */
export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = resolvePricing(model);
  const cost =
    (tokensIn / 1_000_000) * pricing.input +
    (tokensOut / 1_000_000) * pricing.output;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Calculate cost in USD with cache-aware pricing.
 * Cache reads cost 10% of base input price; cache writes cost 125%.
 */
export function calculateCostWithCache(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheRead: number = 0,
  cacheCreation: number = 0
): number {
  const pricing = resolvePricing(model);
  const baseInput = tokensIn - cacheRead - cacheCreation;
  const cost =
    (baseInput / 1_000_000) * pricing.input +
    (cacheRead / 1_000_000) * pricing.input * 0.1 +
    (cacheCreation / 1_000_000) * pricing.input * 1.25 +
    (tokensOut / 1_000_000) * pricing.output;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Format a USD cost for display.
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(4)}`;
}

function resolvePricing(model: string): ModelPricing {
  // Exact match
  if (PRICING[model]) return PRICING[model];

  // Strip a provider prefix (e.g. "codex:gpt-5.4-mini", "claude-code:sonnet",
  // "anthropic:claude-haiku-4-5...") and retry the exact match — the LLMResult
  // models are prefixed, but the table is keyed by bare model id.
  const colon = model.lastIndexOf(":");
  if (colon !== -1) {
    const bare = model.slice(colon + 1);
    if (PRICING[bare]) return PRICING[bare];
  }

  // Fuzzy match by keyword
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return PRICING["opus"];
  if (lower.includes("haiku")) return PRICING["haiku"];
  if (lower.includes("sonnet")) return PRICING["sonnet"];
  // Codex slugs that aren't in the table fall back to the flagship price.
  if (lower.includes("gpt") || lower.includes("codex")) return PRICING["gpt-5.5"];

  return DEFAULT_PRICING;
}
