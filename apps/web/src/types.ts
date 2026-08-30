export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  version: number;
  totalSpendUsd: number;
  budgetLimitUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  changedFields: string[];
  createdAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** A minimal mock identity: who caused a Run to happen. Self-reported by the
 * browser (see actor.ts), not verified — there is no real auth on this POC. */
export interface Actor {
  type: "human" | "agent";
  id: string;
  name: string;
}

export interface RunEnvironment {
  arkModel: string;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  traceId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  environment: RunEnvironment | null;
  estimatedCostUsd: number | null;
  agentVersion: number;
  initiatedBy: Actor;
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type SpanCategory =
  | "model_call"
  | "tool_call"
  | "reasoning"
  | "error"
  | "policy_decision"
  | "warning";
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

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface RunTrace {
  runId: string;
  agentId: string;
  status: RunStatus;
  initiatedBy: Actor;
  sessionId: string | null;
  usage: RunUsage | null;
  environment: RunEnvironment | null;
  estimatedCostUsd: number | null;
  agentVersion: number;
  spans: RunSpan[];
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
