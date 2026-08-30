import { randomUUID } from "node:crypto";
import { detectAnomalies } from "./anomaly.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { estimateCostUsd, type CostRates } from "./cost.js";
import { HttpError, PolicyViolationError, RunCancelledError } from "./errors.js";
import { redact } from "./redact.js";
import { JsonStore } from "./store.js";
import type {
  Actor,
  Agent,
  AgentRun,
  AgentRunner,
  AgentVersion,
  CreateAgentInput,
  Message,
  RunEnvironment,
  RunSpan,
  RunTrace,
  RunVersionDiff,
  RunVersionSnapshot,
  TraceExplainer,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

// No real auth exists on this single-user POC, so a Run that arrives without
// an actor header (a raw API/curl call, or an older client) is attributed to
// this mock principal rather than left unattributed.
const ANONYMOUS_ACTOR: Actor = { type: "human", id: "anonymous", name: "Anonymous operator" };

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly explainer: TraceExplainer,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      version: 1,
      totalSpendUsd: 0,
      budgetLimitUsd: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const initialVersion: AgentVersion = {
      id: randomUUID(),
      agentId: id,
      version: 1,
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      changedFields: [],
      createdAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => {
      database.agents.push(agent);
      database.agentVersions.push(initialVersion);
    });
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      const changedFields: string[] = [];
      const nextName = input.name !== undefined ? input.name.trim() : agent.name;
      const nextDescription =
        input.description !== undefined ? input.description.trim() : agent.description;
      const nextInstructions =
        input.instructions !== undefined ? input.instructions.trim() : agent.instructions;
      if (nextName !== agent.name) changedFields.push("name");
      if (nextDescription !== agent.description) changedFields.push("description");
      if (nextInstructions !== agent.instructions) changedFields.push("instructions");
      agent.name = nextName;
      agent.description = nextDescription;
      agent.instructions = nextInstructions;
      // A budget change is a resource-control knob, not part of the Agent's
      // behavior/instructions, so it does not bump version or appear in
      // changedFields - that history is for "what the Agent does," not
      // "what it's allowed to spend."
      if (input.budgetLimitUsd !== undefined) {
        agent.budgetLimitUsd = input.budgetLimitUsd;
      }
      agent.lastError = null;
      agent.updatedAt = now();
      if (changedFields.length > 0) {
        agent.version += 1;
        database.agentVersions.push({
          id: randomUUID(),
          agentId: agent.id,
          version: agent.version,
          name: agent.name,
          description: agent.description,
          instructions: agent.instructions,
          changedFields,
          createdAt: agent.updatedAt,
        });
      }
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  getAgentVersions(agentId: string): AgentVersion[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .agentVersions.filter((item) => item.agentId === agentId)
      .sort((left, right) => right.version - left.version);
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.agentVersions = database.agentVersions.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRunTrace(runId: string): RunTrace {
    const run = this.getRun(runId);
    return {
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      initiatedBy: run.initiatedBy,
      sessionId: run.sessionId,
      usage: run.usage,
      environment: run.environment,
      estimatedCostUsd: run.estimatedCostUsd,
      agentVersion: run.agentVersion,
      versionDiff: this.buildVersionDiff(run.agentId, run.agentVersion),
      explanation: run.explanation,
      spans: run.spans,
    };
  }

  async explainRun(runId: string): Promise<AgentRun> {
    const run = this.getRun(runId);
    if (run.explanation) return run;
    if (run.status === "queued" || run.status === "running") {
      throw new HttpError(409, "Run is still in progress");
    }
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const agent = this.store.snapshot().agents.find((item) => item.id === run.agentId);
    const durationMs =
      run.startedAt && run.completedAt
        ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
        : null;
    const explanation = await this.explainer.explain({
      agentName: agent?.name ?? "Unknown Agent",
      status: run.status,
      prompt: run.prompt,
      output: run.output,
      error: run.error,
      usage: run.usage,
      estimatedCostUsd: run.estimatedCostUsd,
      durationMs,
      spans: run.spans,
    });
    return this.store.mutate((database) => {
      const stored = database.runs.find((item) => item.id === runId);
      if (!stored) {
        throw new HttpError(404, "Run not found");
      }
      // Another request may have generated (and cached) an explanation
      // while this Ark call was in flight - keep whichever landed first
      // rather than overwriting it.
      stored.explanation ??= explanation;
      return structuredClone(stored);
    });
  }

  private buildVersionDiff(agentId: string, runVersion: number): RunVersionDiff | null {
    const database = this.store.snapshot();
    const agent = database.agents.find((item) => item.id === agentId);
    if (!agent) return null;
    const versions = database.agentVersions.filter((item) => item.agentId === agentId);
    const current = versions.find((item) => item.version === runVersion) ?? null;
    const previous = versions.find((item) => item.version === runVersion - 1) ?? null;
    const toSnapshot = (version: AgentVersion): RunVersionSnapshot => ({
      name: version.name,
      description: version.description,
      instructions: version.instructions,
    });
    return {
      version: runVersion,
      changedFields: current?.changedFields ?? [],
      snapshot: current ? toSnapshot(current) : null,
      previousVersion: previous ? previous.version : null,
      previousSnapshot: previous ? toSnapshot(previous) : null,
      currentAgentVersion: agent.version,
    };
  }

  private currentRunEnvironment(): RunEnvironment {
    return {
      arkModel: this.config.arkModel,
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container" ? this.config.containerEngine : null,
    };
  }

  private currentCostRates(): CostRates {
    return {
      inputPerMillionUsd: this.config.costPerMillionInputTokensUsd,
      outputPerMillionUsd: this.config.costPerMillionOutputTokensUsd,
    };
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    initiatedBy: Actor = ANONYMOUS_ACTOR,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    // One Run is one trace. Every Span emitted while this Run executes carries
    // this id, which is what lets the timeline be reassembled from flat rows.
    const traceId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      traceId,
      status: "queued",
      // Kept unredacted: this is what actually gets sent to the Agent
      // Runtime below (redacting it would silently feed Codex "[REDACTED]"
      // instead of what the user typed). Codex resumes sessions by
      // threadId, not by reading this field back, so it is never re-read
      // operationally after this Run starts.
      prompt,
      output: null,
      error: null,
      usage: null,
      spans: [],
      environment: this.currentRunEnvironment(),
      // Only known once usage is reported at completion.
      estimatedCostUsd: null,
      // Placeholder, overwritten below inside the mutate callback with the
      // Agent's actual current version — the two must be read atomically
      // together with the status checks, so there is no real value to put
      // here yet.
      agentVersion: 1,
      explanation: null,
      initiatedBy,
      // Filled in below, inside the mutate callback, from the Agent's
      // current Codex thread — null here means "resolved below or, if this
      // Run never reaches a successful completion, stays unresolved."
      sessionId: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      // Redacted: this is the display/storage copy shown in the
      // conversation and saved to disk — it never feeds back into the
      // Agent's execution, so redacting it is purely a display/storage
      // safeguard with no functional side effect.
      content: redact(prompt),
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      if (
        storedAgent.budgetLimitUsd !== null &&
        storedAgent.totalSpendUsd >= storedAgent.budgetLimitUsd
      ) {
        throw new HttpError(
          402,
          "This Agent has reached its budget limit ($" +
            storedAgent.budgetLimitUsd.toFixed(2) +
            "). Raise or clear the limit to continue.",
        );
      }
      // Reuse the Agent's existing Codex thread as this Run's session, if
      // one already exists; a brand-new Agent has none yet, and this Run's
      // own result will establish it (see executeRun's success path).
      run.sessionId = storedAgent.codexThreadId;
      run.agentVersion = storedAgent.version;
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    // One automatic retry for a transient Runtime failure — this is the
    // platform's "recover from a failed step" case. A denial and an
    // explicit user cancellation are both decisions, not glitches, so
    // neither is retried; anything else (a timeout, a crash, a non-zero
    // exit) gets one more attempt before the Run is given up as failed.
    const maxAttempts = 2;
    const recoverySpans: RunSpan[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.cancellationRequests.has(agentAtStart.id)) {
          throw new RunCancelledError();
        }
        const result = await this.runner.run({
          agentId: agentAtStart.id,
          workspacePath: this.workspaces.workspacePath(agentAtStart.id),
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
        });
        const completedAt = now();
        // Redacted here, not just in span detail — the Agent could echo a
        // secret back in its own answer (e.g. after reading an env var),
        // and this is the last point before it becomes persisted, displayed
        // conversation history.
        const output = redact(result.output);
        const estimatedCostUsd = estimateCostUsd(result.usage, this.currentCostRates());
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (!storedRun || !agent) return;
          const durationMs = storedRun.startedAt
            ? new Date(completedAt).getTime() - new Date(storedRun.startedAt).getTime()
            : null;
          // The Agent's own prior completed Runs are the anomaly baseline -
          // read here, inside the same mutate transaction, so it reflects
          // exactly what's persisted rather than a snapshot from before
          // this Run started.
          const priorSamples = database.runs
            .filter(
              (item) =>
                item.agentId === agent.id && item.status === "completed" && item.id !== run.id,
            )
            .map((item) => ({
              costUsd: item.estimatedCostUsd,
              durationMs:
                item.startedAt && item.completedAt
                  ? new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()
                  : null,
            }));
          const anomalySpans = detectAnomalies(
            { costUsd: estimatedCostUsd, durationMs },
            priorSamples,
            completedAt,
          );
          storedRun.status = "completed";
          storedRun.output = output;
          storedRun.usage = result.usage;
          storedRun.estimatedCostUsd = estimatedCostUsd;
          storedRun.spans = [...recoverySpans, ...result.spans, ...anomalySpans];
          storedRun.sessionId ??= result.threadId;
          storedRun.completedAt = completedAt;
          if (estimatedCostUsd !== null) {
            agent.totalSpendUsd += estimatedCostUsd;
          }
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: output,
            createdAt: completedAt,
          });
          agent.status = "ready";
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = completedAt;
        });
        return;
      } catch (error) {
        const cancelled = error instanceof RunCancelledError;
        const policyViolation = error instanceof PolicyViolationError;
        const message = error instanceof Error ? error.message : String(error);
        const retryable = !cancelled && !policyViolation && attempt < maxAttempts;

        if (retryable) {
          recoverySpans.push({
            id: "retry-" + attempt,
            parentId: null,
            category: "error",
            label: "Attempt " + attempt + " failed — retrying",
            startedAt: now(),
            endedAt: now(),
            status: "failed",
            detail: message,
          });
          continue;
        }

        const completedAt = now();
        // A PolicyViolationError carries the spans captured up to the moment
        // of denial — including the policy_decision span itself — so that
        // evidence survives on the failed Run instead of being discarded
        // like a generic failure's spans currently are.
        const spans = policyViolation
          ? [...recoverySpans, ...(error as PolicyViolationError).spans]
          : recoverySpans;
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (storedRun) {
            storedRun.status = cancelled ? "cancelled" : "failed";
            storedRun.error = message;
            storedRun.spans = spans;
            storedRun.completedAt = completedAt;
          }
          if (agent) {
            if (agent.status !== "stopped") {
              agent.status = cancelled ? "ready" : "error";
            }
            agent.lastError = cancelled ? null : message;
            agent.updatedAt = completedAt;
          }
        });
        return;
      }
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
