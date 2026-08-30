import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./cost.js";

const rates = { inputPerMillionUsd: 0.5, outputPerMillionUsd: 1.5 };

describe("estimateCostUsd", () => {
  it("returns null for missing usage", () => {
    expect(estimateCostUsd(null, rates)).toBeNull();
  });

  it("returns null when usage has no reported tokens", () => {
    expect(estimateCostUsd({}, rates)).toBeNull();
  });

  it("computes cost from input and output tokens at the configured rate", () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rates);
    expect(cost).toBe(2); // $0.50 + $1.50
  });

  it("scales linearly below one million tokens", () => {
    const cost = estimateCostUsd({ inputTokens: 7_500, outputTokens: 40 }, rates);
    expect(cost).toBeCloseTo(0.0038, 4);
  });

  it("ignores cachedInputTokens for cost - only inputTokens/outputTokens are priced", () => {
    const withCache = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
      rates,
    );
    expect(withCache).toBe(0.5);
  });
});
