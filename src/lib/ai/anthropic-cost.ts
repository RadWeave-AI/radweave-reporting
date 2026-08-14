export interface AnthropicUsageInput {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface NormalizedAnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AnthropicPricingUsdPerMillion {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const ANTHROPIC_PRICING_USD_PER_MILLION = {
  "claude-sonnet-4-6": {
    input_tokens: 3,
    output_tokens: 15,
    cache_creation_input_tokens: 3.75,
    cache_read_input_tokens: 0.3,
  },
  "claude-opus-4-6": {
    input_tokens: 5,
    output_tokens: 25,
    cache_creation_input_tokens: 6.25,
    cache_read_input_tokens: 0.5,
  },
  "claude-haiku-4-5": {
    input_tokens: 1,
    output_tokens: 5,
    cache_creation_input_tokens: 1.25,
    cache_read_input_tokens: 0.1,
  },
  "claude-sonnet-4-5": {
    input_tokens: 3,
    output_tokens: 15,
    cache_creation_input_tokens: 3.75,
    cache_read_input_tokens: 0.3,
  },
} as const satisfies Record<string, AnthropicPricingUsdPerMillion>;

export type SupportedAnthropicModel = keyof typeof ANTHROPIC_PRICING_USD_PER_MILLION;

export class UnsupportedAnthropicModelError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(`Unsupported Anthropic pricing model: ${model}`);
    this.name = "UnsupportedAnthropicModelError";
    this.model = model;
  }
}

function normalizeTokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function normalizeAnthropicUsage(usage: AnthropicUsageInput): NormalizedAnthropicUsage {
  return {
    input_tokens: normalizeTokenCount(usage.input_tokens),
    output_tokens: normalizeTokenCount(usage.output_tokens),
    cache_creation_input_tokens: normalizeTokenCount(usage.cache_creation_input_tokens),
    cache_read_input_tokens: normalizeTokenCount(usage.cache_read_input_tokens),
  };
}

export function aggregateAnthropicUsage(...usages: AnthropicUsageInput[]): NormalizedAnthropicUsage {
  return usages.reduce<NormalizedAnthropicUsage>((total, usage) => {
    const normalized = normalizeAnthropicUsage(usage);
    return {
      input_tokens: total.input_tokens + normalized.input_tokens,
      output_tokens: total.output_tokens + normalized.output_tokens,
      cache_creation_input_tokens:
        total.cache_creation_input_tokens + normalized.cache_creation_input_tokens,
      cache_read_input_tokens: total.cache_read_input_tokens + normalized.cache_read_input_tokens,
    };
  }, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
}

export function calculateAnthropicCost(input: AnthropicUsageInput & { model: string }): {
  model: SupportedAnthropicModel;
  estimated_cost_usd: number;
  usage: NormalizedAnthropicUsage;
  pricing_usd_per_million: AnthropicPricingUsdPerMillion;
} {
  const pricing = ANTHROPIC_PRICING_USD_PER_MILLION[
    input.model as SupportedAnthropicModel
  ];
  if (!pricing) throw new UnsupportedAnthropicModelError(input.model);

  const usage = normalizeAnthropicUsage(input);
  const estimatedCostUsd = (
    usage.input_tokens * pricing.input_tokens
    + usage.output_tokens * pricing.output_tokens
    + usage.cache_creation_input_tokens * pricing.cache_creation_input_tokens
    + usage.cache_read_input_tokens * pricing.cache_read_input_tokens
  ) / 1_000_000;

  return {
    model: input.model as SupportedAnthropicModel,
    estimated_cost_usd: estimatedCostUsd,
    usage,
    pricing_usd_per_million: pricing,
  };
}

