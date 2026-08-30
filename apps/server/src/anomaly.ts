/**
 * Flags a Run as anomalous when its cost or duration is far outside what
 * this specific Agent's own history looks like - a lightweight statistical
 * reliability signal, not one of the brief's recommended examples. Reuses
 * the existing "warning" span category and trace UI, so it needed no new
 * UI surface to demonstrate: an anomalous Run just shows an extra span.
 *
 * Deliberately per-Agent, not platform-wide - a "normal" cost for one Agent
 * (a long-running build task) can be wildly abnormal for another (a quick
 * lookup), so the baseline has to be the Agent's own history.
 */
import type { RunSpan } from "./types.js";

export interface AnomalySample {
  costUsd: number | null;
  durationMs: number | null;
}

// Below this many prior data points, an "average" is too noisy to flag
// anything against - a second-ever Run costing more than the first isn't
// an anomaly, it's just not enough history yet.
const MIN_SAMPLE_SIZE = 3;
const ANOMALY_MULTIPLIER = 3;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function detectAnomalies(
  current: AnomalySample,
  priorSamples: AnomalySample[],
  timestamp: string,
): RunSpan[] {
  const spans: RunSpan[] = [];

  const priorCosts = priorSamples
    .map((sample) => sample.costUsd)
    .filter((value): value is number => value != null);
  if (current.costUsd != null && priorCosts.length >= MIN_SAMPLE_SIZE) {
    const avg = average(priorCosts)!;
    if (avg > 0 && current.costUsd > avg * ANOMALY_MULTIPLIER) {
      spans.push({
        id: "anomaly-cost",
        parentId: null,
        category: "warning",
        label: "Cost anomaly",
        startedAt: timestamp,
        endedAt: timestamp,
        status: "completed",
        detail:
          "This Run cost $" +
          current.costUsd.toFixed(6) +
          ", over " +
          ANOMALY_MULTIPLIER +
          "x this Agent's average of $" +
          avg.toFixed(6) +
          " across its last " +
          priorCosts.length +
          " completed Runs.",
      });
    }
  }

  const priorDurations = priorSamples
    .map((sample) => sample.durationMs)
    .filter((value): value is number => value != null);
  if (current.durationMs != null && priorDurations.length >= MIN_SAMPLE_SIZE) {
    const avg = average(priorDurations)!;
    if (avg > 0 && current.durationMs > avg * ANOMALY_MULTIPLIER) {
      spans.push({
        id: "anomaly-duration",
        parentId: null,
        category: "warning",
        label: "Duration anomaly",
        startedAt: timestamp,
        endedAt: timestamp,
        status: "completed",
        detail:
          "This Run took " +
          (current.durationMs / 1000).toFixed(1) +
          "s, over " +
          ANOMALY_MULTIPLIER +
          "x this Agent's average of " +
          (avg / 1000).toFixed(1) +
          "s across its last " +
          priorDurations.length +
          " completed Runs.",
      });
    }
  }

  return spans;
}
