/**
 * Flat-rate cost estimation from a Run's token usage. Real per-model Ark
 * pricing isn't published for every endpoint, so this uses a single
 * platform-wide rate (config.costPerMillion*TokensUsd) as a stated
 * approximation rather than an invoice figure - good enough to demonstrate
 * a real cost/budget control without fabricating precision the platform
 * doesn't have.
 */
import type { RunUsage } from "./types.js";

export interface CostRates {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export function estimateCostUsd(usage: RunUsage | null, rates: CostRates): number | null {
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  const cost =
    (inputTokens / 1_000_000) * rates.inputPerMillionUsd +
    (outputTokens / 1_000_000) * rates.outputPerMillionUsd;
  // Round to a hundredth of a cent - enough precision to be useful, not so
  // much that it implies false accuracy.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
