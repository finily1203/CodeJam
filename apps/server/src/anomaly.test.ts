import { describe, expect, it } from "vitest";
import { detectAnomalies } from "./anomaly.js";

const TS = "2026-01-01T00:00:00.000Z";
const normalHistory = [
  { costUsd: 0.01, durationMs: 2000 },
  { costUsd: 0.012, durationMs: 2200 },
  { costUsd: 0.009, durationMs: 1800 },
];

describe("detectAnomalies", () => {
  it("flags nothing when there is not enough history yet", () => {
    const spans = detectAnomalies(
      { costUsd: 5, durationMs: 60_000 },
      [{ costUsd: 0.01, durationMs: 2000 }],
      TS,
    );
    expect(spans).toEqual([]);
  });

  it("flags nothing when cost and duration are in line with history", () => {
    const spans = detectAnomalies({ costUsd: 0.011, durationMs: 2100 }, normalHistory, TS);
    expect(spans).toEqual([]);
  });

  it("flags a cost anomaly when a Run costs more than 3x the Agent's average", () => {
    const spans = detectAnomalies({ costUsd: 0.05, durationMs: 2100 }, normalHistory, TS);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      id: "anomaly-cost",
      category: "warning",
      status: "completed",
    });
    expect(spans[0]?.detail).toContain("over 3x");
  });

  it("flags a duration anomaly independently of cost", () => {
    const spans = detectAnomalies({ costUsd: 0.011, durationMs: 30_000 }, normalHistory, TS);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ id: "anomaly-duration", category: "warning" });
  });

  it("can flag both at once", () => {
    const spans = detectAnomalies({ costUsd: 0.05, durationMs: 30_000 }, normalHistory, TS);
    expect(spans.map((span) => span.id).sort()).toEqual(["anomaly-cost", "anomaly-duration"]);
  });

  it("ignores prior samples with null values when building the baseline", () => {
    const historyWithGaps = [
      { costUsd: null, durationMs: 2000 },
      { costUsd: 0.01, durationMs: null },
      { costUsd: 0.01, durationMs: 2000 },
      { costUsd: 0.01, durationMs: 2000 },
    ];
    // Only 3 non-null cost samples and 3 non-null duration samples exist;
    // a Run in line with them should not be flagged.
    const spans = detectAnomalies({ costUsd: 0.011, durationMs: 2100 }, historyWithGaps, TS);
    expect(spans).toEqual([]);
  });

  it("does nothing for a Run with no cost or duration data at all", () => {
    const spans = detectAnomalies({ costUsd: null, durationMs: null }, normalHistory, TS);
    expect(spans).toEqual([]);
  });
});
