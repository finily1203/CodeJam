import type { AppConfig } from "./config.js";
import type { ExplainTraceInput, RunUsage, TraceExplainer } from "./types.js";

function formatUsage(usage: RunUsage | null): string {
  if (!usage) return "unknown";
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return input + " input / " + output + " output tokens";
}

// Trims each span's detail to keep the prompt small - a full model turn can
// carry thousands of characters of output, none of which the summary needs
// verbatim to describe what happened.
const MAX_DETAIL_CHARS = 240;

function buildPrompt(input: ExplainTraceInput): string {
  const lines: string[] = [
    "Agent: " + input.agentName,
    "Status: " + input.status,
    "User prompt: " + input.prompt,
  ];
  if (input.durationMs != null) {
    lines.push("Duration: " + (input.durationMs / 1000).toFixed(1) + "s");
  }
  lines.push("Token usage: " + formatUsage(input.usage));
  if (input.estimatedCostUsd != null) {
    lines.push("Estimated cost: $" + input.estimatedCostUsd.toFixed(6));
  }
  if (input.error) {
    lines.push("Error: " + input.error);
  }
  lines.push("Trace spans:");
  for (const span of input.spans) {
    const detail = span.detail ? span.detail.slice(0, MAX_DETAIL_CHARS) : "";
    lines.push("- [" + span.category + "/" + span.status + "] " + span.label + (detail ? ": " + detail : ""));
  }
  return lines.join("\n");
}

function extractOutputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (chunk && typeof chunk === "object" && typeof (chunk as Record<string, unknown>).text === "string") {
        parts.push((chunk as Record<string, unknown>).text as string);
      }
    }
  }
  return parts.join(" ").trim();
}

/**
 * Calls Volcengine Ark's OpenAI-compatible Responses API directly - a
 * single lightweight completion, not a Codex Agent run - to turn a Run's
 * trace into a 1-2 sentence plain-English summary.
 */
export class ArkTraceExplainer implements TraceExplainer {
  constructor(private readonly config: AppConfig) {}

  async explain(input: ExplainTraceInput): Promise<string> {
    const response = await fetch(this.config.arkBaseUrl + "/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.config.arkApiKey,
      },
      body: JSON.stringify({
        model: this.config.arkModel,
        instructions:
          "You are a terse observability assistant reading an AI Agent's execution trace. " +
          "Write exactly 1-2 plain-English sentences: what happened, why it cost what it " +
          "cost, and why it failed if it failed. No preamble, no markdown, no bullet points.",
        input: buildPrompt(input),
        // Generous headroom: this is a reasoning model that spends a few
        // hundred tokens on chain-of-thought before ever emitting the
        // actual 1-2 sentence answer, so a tight budget here truncates the
        // response before the real output_text ever appears.
        max_output_tokens: 1000,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error("Ark explain request failed: " + response.status + " " + body);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const text = extractOutputText(data);
    if (!text) {
      throw new Error(
        "Ark explain request returned no text (status: " + String(data.status) + ")",
      );
    }
    return text;
  }
}
