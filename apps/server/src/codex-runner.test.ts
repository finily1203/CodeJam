import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  closeDanglingSpans,
  parseCodexEventLine,
  type ParsedEvents,
} from "./codex-runner.js";
import type { RunSpan } from "./types.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
      spans: [] as RunSpan[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

describe("Codex trace span capture", () => {
  const newParsed = (): ParsedEvents => ({
    messages: [],
    threadId: null,
    usage: null,
    errors: [],
    spans: [],
  });

  // Captured from a real `codex exec --json` run against a workspace-write
  // sandbox that rejected a write, to ground this test in the actual event
  // shapes Codex emits (item.started/item.completed pairs keyed by item.id,
  // reasoning items, and item-level "error" items) rather than assumptions.
  const REAL_EVENT_LOG = [
    { type: "thread.started", thread_id: "01a04de5-771e-72d1-9f9f-795293a44856" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: "Model metadata for `dola-seed-2-1-turbo-260628` not found.",
      },
    },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "item_1", type: "reasoning", text: "Planning the write." },
    },
    {
      type: "item.started",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "echo hello > hello.txt",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "echo hello > hello.txt",
        aggregated_output: "rejected: blocked by policy",
        exit_code: -1,
        status: "failed",
      },
    },
    {
      type: "item.completed",
      item: { id: "item_4", type: "agent_message", text: "I can't write files here." },
    },
    { type: "turn.completed", usage: { input_tokens: 14770, output_tokens: 287 } },
  ];

  it("turns the raw event log into an ordered span timeline", () => {
    const parsed = newParsed();
    for (const event of REAL_EVENT_LOG) {
      parseCodexEventLine(JSON.stringify(event), parsed);
    }

    const byCategory = (category: RunSpan["category"]) =>
      parsed.spans.filter((span) => span.category === category);

    expect(byCategory("model_call")).toHaveLength(1);
    expect(byCategory("tool_call")).toHaveLength(1);
    expect(byCategory("reasoning")).toHaveLength(1);
    expect(byCategory("error")).toHaveLength(1);

    const turn = byCategory("model_call")[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.endedAt).not.toBeNull();
    expect(turn.detail).toBe("I can't write files here.");

    const toolCall = byCategory("tool_call")[0]!;
    expect(toolCall.id).toBe("item_2");
    expect(toolCall.parentId).toBe(turn.id);
    expect(toolCall.status).toBe("failed");
    expect(toolCall.detail).toBe("rejected: blocked by policy");

    const errorSpan = byCategory("error")[0]!;
    expect(errorSpan.id).toBe("item_0");
    expect(errorSpan.detail).toContain("Model metadata");
    expect(parsed.errors).toContain(
      "Model metadata for `dola-seed-2-1-turbo-260628` not found.",
    );
  });

  it("closes spans left open by a run that never reports completion", () => {
    const parsed = newParsed();
    parseCodexEventLine(JSON.stringify({ type: "turn.started" }), parsed);
    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "item_1", type: "command_execution", command: "sleep 999" },
      }),
      parsed,
    );

    expect(parsed.spans.every((span) => span.status === "running")).toBe(true);

    closeDanglingSpans(parsed.spans, new Date().toISOString());

    expect(parsed.spans.every((span) => span.status === "failed")).toBe(true);
    expect(parsed.spans.every((span) => span.endedAt !== null)).toBe(true);
  });
});
