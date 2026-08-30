export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  /** Bumped on every updateAgent call; 1 for a never-edited Agent. */
  version: number;
  /** Cumulative estimated cost (USD) of every completed Run this Agent has produced. */
  totalSpendUsd: number;
  /** Null means unlimited. sendMessage rejects new Runs once totalSpendUsd reaches this. */
  budgetLimitUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A point-in-time snapshot of an Agent's configuration, recorded whenever it
 * is created or edited — the "update configuration through a new version and
 * show what changed" lifecycle action from the brief. changedFields is empty
 * for the version created alongside the Agent itself.
 */
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
 * A minimal mock identity: who or what caused a Run to happen. The platform
 * is a single-user POC with no real authentication, so "human" actors are
 * self-reported (a name the browser sends), not verified. This is enough to
 * attribute a Run to a principal in the trace without building real auth.
 */
export interface Actor {
  type: "human" | "agent";
  id: string;
  name: string;
}

/**
 * A snapshot of the Runtime configuration active when a Run started —
 * captured on the Run itself rather than read live from current config, so
 * a trace still tells the truth about what actually executed after the
 * platform's config changes (a different model, a different sandbox mode).
 */
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
  usage: RunUsage | null;
  spans: RunSpan[];
  /** Null only for a Run persisted before this field existed. */
  environment: RunEnvironment | null;
  /** Null until usage is known (still running, or failed before usage was reported) or for a Run that predates cost tracking. */
  estimatedCostUsd: number | null;
  /** The Agent's version when this Run started. 1 for any Run that predates versioning — true, not a guess, since no Agent had more than one version before this field existed. */
  agentVersion: number;
  initiatedBy: Actor;
  /**
   * The Codex thread this Run participated in — Codex's own session
   * concept, which is what actually makes "the same conversation" continue
   * across Runs (see AgentService.sendMessage). Null until the Agent's
   * first successful Run establishes one.
   */
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export const DATABASE_VERSION = 7;

export interface Database {
  version: typeof DATABASE_VERSION;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  agentVersions: AgentVersion[];
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
  /** undefined leaves it unchanged; null clears it (unlimited). */
  budgetLimitUsd?: number | null | undefined;
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
