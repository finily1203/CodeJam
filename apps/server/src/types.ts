export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/**
 * Trace middleware. A Run is one trace; every step inside it is a Span.
 * Categories map onto the Codex `exec --json` event stream. The baseline
 * parser keeps only `agent_message`, so every other category below is
 * information the platform already receives and currently discards.
 */
export type SpanCategory =
  | "orchestration"
  | "reasoning"
  | "model_call"
  | "command_execution"
  | "file_change"
  | "tool_call"
  | "web_search"
  | "error";

export type SpanStatus = "running" | "ok" | "error" | "cancelled";

export type SpanActor = "human" | "agent" | "system";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/**
 * One step inside a Run. Spans of a Run share a `traceId` and nest through
 * `parentSpanId`, which is what turns a flat log into a navigable tree.
 *
 * `inputSummary` and `outputSummary` are redacted and truncated before they
 * reach the store; raw payloads are never persisted.
 */
export interface Span {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  runId: string;
  agentId: string;
  actor: SpanActor;
  category: SpanCategory;
  name: string;
  status: SpanStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  usage: RunUsage | null;
  metadata: Record<string, string> | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  traceId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  spans: RunSpan[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export const DATABASE_VERSION = 2;

export interface Database {
  version: typeof DATABASE_VERSION;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  spans: Span[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export type SpanCategory = "model_call" | "tool_call" | "reasoning" | "error";
export type SpanStatus = "running" | "completed" | "failed";

export interface RunSpan {
  id: string;
  parentId: string | null;
  category: SpanCategory;
  label: string;
  startedAt: string;
  endedAt: string | null;
  status: SpanStatus;
  detail: string | null;
}

export interface RunTrace {
  runId: string;
  agentId: string;
  status: RunStatus;
  spans: RunSpan[];
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  spans: RunSpan[];
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
