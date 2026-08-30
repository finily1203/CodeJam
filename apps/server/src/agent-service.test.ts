import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { PolicyViolationError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
      spans: [
        {
          id: "turn-0",
          parentId: null,
          category: "model_call",
          label: "Model turn",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          status: "completed",
          detail: "Completed: " + request.prompt,
        },
      ],
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("starts an Agent at version 1 with one initial version record", async () => {
    const service = await makeService();
    const agent = await service.createAgent({
      name: "Builder",
      description: "v1",
      instructions: "Build things",
    });
    expect(agent.version).toBe(1);

    const versions = service.getAgentVersions(agent.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      name: "Builder",
      description: "v1",
      instructions: "Build things",
      changedFields: [],
    });
  });

  it("bumps the version and records changed fields only when an edit actually changes something", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder", description: "v1" });

    const resent = await service.updateAgent(agent.id, { description: "v1" });
    expect(resent.version).toBe(1);
    expect(service.getAgentVersions(agent.id)).toHaveLength(1);

    const edited = await service.updateAgent(agent.id, {
      description: "v2",
      instructions: "Be terse",
    });
    expect(edited.version).toBe(2);
    const versions = service.getAgentVersions(agent.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      version: 2,
      description: "v2",
      instructions: "Be terse",
      changedFields: ["description", "instructions"],
    });
    expect(versions[1]).toMatchObject({ version: 1, changedFields: [] });
  });

  it("stamps each Run with the Agent's version at send time, unaffected by later edits", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getRun(first.run.id).agentVersion).toBe(1);

    await service.updateAgent(agent.id, { description: "changed" });
    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(service.getRun(second.run.id).agentVersion).toBe(2);
    // The first Run's own record must not retroactively change.
    expect(service.getRun(first.run.id).agentVersion).toBe(1);
    expect(service.getRunTrace(second.run.id).agentVersion).toBe(2);
  });

  it("rejects a version-history lookup once the Agent is deleted", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    await service.updateAgent(agent.id, { description: "changed" });
    expect(service.getAgentVersions(agent.id)).toHaveLength(2);

    await service.deleteAgent(agent.id);
    expect(() => service.getAgentVersions(agent.id)).toThrow();
  });

  it("starts an Agent with no budget limit and zero spend, accumulating cost as Runs complete", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Spender" });
    expect(agent.budgetLimitUsd).toBeNull();
    expect(agent.totalSpendUsd).toBe(0);

    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getRun(first.run.id).estimatedCostUsd).toBe(0.000014);
    expect(service.getAgent(agent.id).totalSpendUsd).toBe(0.000014);

    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).totalSpendUsd).toBe(0.000028);
  });

  it("rejects a new Run once the Agent's budget limit is reached, and lifts the block when the limit is raised", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Capped" });
    await service.updateAgent(agent.id, { budgetLimitUsd: 0 });
    expect(service.getAgent(agent.id).budgetLimitUsd).toBe(0);

    await expect(service.sendMessage(agent.id, "should be blocked")).rejects.toMatchObject({
      statusCode: 402,
    });

    await service.updateAgent(agent.id, { budgetLimitUsd: 1 });
    const { run } = await service.sendMessage(agent.id, "should be allowed now");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await service.updateAgent(agent.id, { budgetLimitUsd: null });
    expect(service.getAgent(agent.id).budgetLimitUsd).toBeNull();
  });

  it("flags a Run as a cost anomaly against the Agent's own history, but not before there is enough history", async () => {
    let call = 0;
    const runner: AgentRunner = {
      run: async () => {
        call += 1;
        const usage =
          call <= 3
            ? { inputTokens: 100, outputTokens: 20 }
            : { inputTokens: 100_000, outputTokens: 20_000 };
        return { output: "done " + call, threadId: "thread", usage, spans: [] };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Watched" });

    for (let i = 0; i < 3; i++) {
      const { run } = await service.sendMessage(agent.id, "normal " + i);
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
      // Not enough history yet for the first three Runs to be judged.
      expect(service.getRunTrace(run.id).spans.some((span) => span.id.startsWith("anomaly-")))
        .toBe(false);
    }

    const { run: outlier } = await service.sendMessage(agent.id, "the big one");
    await expect.poll(() => service.getRun(outlier.id).status).toBe("completed");
    const trace = service.getRunTrace(outlier.id);
    const anomaly = trace.spans.find((span) => span.id === "anomaly-cost");
    expect(anomaly).toMatchObject({ category: "warning", status: "completed" });
    expect(anomaly?.detail).toContain("over 3x");
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");

    const completedRun = service.getRun(run.id);
    expect(completedRun.spans).toHaveLength(1);
    expect(completedRun.spans[0]).toMatchObject({
      category: "model_call",
      status: "completed",
    });
  });

  it("exposes a Run's trace as a focused runId/agentId/status/spans view", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "trace me");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const trace = service.getRunTrace(run.id);
    expect(trace).toEqual({
      runId: run.id,
      agentId: agent.id,
      status: "completed",
      initiatedBy: service.getRun(run.id).initiatedBy,
      sessionId: service.getRun(run.id).sessionId,
      usage: service.getRun(run.id).usage,
      environment: service.getRun(run.id).environment,
      estimatedCostUsd: service.getRun(run.id).estimatedCostUsd,
      agentVersion: service.getRun(run.id).agentVersion,
      spans: service.getRun(run.id).spans,
    });
    expect(trace.spans).toHaveLength(1);
    expect(trace.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(trace.estimatedCostUsd).toBe(0.000014);
    expect(trace.agentVersion).toBe(1);
    expect(trace.environment).toEqual({
      arkModel: "ep-test",
      codexSandboxMode: "workspace-write",
      runtimeProvider: "local-process",
      containerEngine: null,
    });
  });

  it("establishes a session on the first successful Run and reuses it on the next one", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Sessioned" });
    expect(agent.codexThreadId).toBeNull();

    const first = await service.sendMessage(agent.id, "hello");
    expect(first.run.sessionId).toBeNull(); // not known yet when the Run was created
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const firstCompleted = service.getRun(first.run.id);
    expect(firstCompleted.sessionId).toBe("fake-thread"); // backfilled from the result

    const second = await service.sendMessage(agent.id, "again");
    expect(second.run.sessionId).toBe("fake-thread"); // reused from the Agent's thread up front
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(service.getRunTrace(second.run.id).sessionId).toBe("fake-thread");
  });

  it("attributes a Run to the actor it was given, defaulting to an anonymous operator", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Attributed" });

    const named = await service.sendMessage(agent.id, "hi", {
      type: "human",
      id: "user-42",
      name: "Jing Rui",
    });
    expect(named.run.initiatedBy).toEqual({ type: "human", id: "user-42", name: "Jing Rui" });
    expect(service.getRunTrace(named.run.id).initiatedBy).toEqual(named.run.initiatedBy);
    await expect.poll(() => service.getRun(named.run.id).status).toBe("completed");

    const anonymous = await service.sendMessage(agent.id, "hi again");
    expect(anonymous.run.initiatedBy).toEqual({
      type: "human",
      id: "anonymous",
      name: "Anonymous operator",
    });
    await expect.poll(() => service.getRun(anonymous.run.id).status).toBe("completed");
  });

  it("rejects a trace lookup for a Run that does not exist", async () => {
    const service = await makeService();
    expect(() => service.getRunTrace("00000000-0000-0000-0000-000000000000")).toThrow();
  });

  it("retries once on a generic Runtime error, then fails with a span recording the first attempt", async () => {
    const service = await makeService({
      run: async () => {
        throw new Error("Codex exploded");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Flaky" });
    const { run } = await service.sendMessage(agent.id, "do something");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const failed = service.getRun(run.id);
    expect(failed.error).toBe("Codex exploded");
    expect(failed.spans).toHaveLength(1);
    expect(failed.spans[0]).toMatchObject({
      category: "error",
      status: "failed",
      label: "Attempt 1 failed — retrying",
      detail: "Codex exploded",
    });
  });

  it("recovers when the retry succeeds, keeping the failed attempt visible in the trace", async () => {
    let calls = 0;
    const service = await makeService({
      run: async (request) => {
        calls += 1;
        if (calls === 1) throw new Error("transient hiccup");
        return {
          output: "Completed: " + request.prompt,
          threadId: "recovered-thread",
          usage: null,
          spans: [
            {
              id: "turn-0",
              parentId: null,
              category: "model_call",
              label: "Model turn",
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: "2026-01-01T00:00:01.000Z",
              status: "completed",
              detail: "Completed: " + request.prompt,
            },
          ],
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Resilient" });
    const { run } = await service.sendMessage(agent.id, "do something");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(calls).toBe(2);
    const completed = service.getRun(run.id);
    expect(completed.spans.map((span) => span.category)).toEqual(["error", "model_call"]);
    expect(completed.spans[0]).toMatchObject({ label: "Attempt 1 failed — retrying" });
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("does not retry a Run cancelled by the user or one denied by policy", async () => {
    let cancelledCalls = 0;
    const cancelledService = await makeService({
      run: async () => {
        cancelledCalls += 1;
        throw new RunCancelledError();
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const cancelledAgent = await cancelledService.createAgent({ name: "Stopped" });
    const { run: cancelledRun } = await cancelledService.sendMessage(cancelledAgent.id, "go");
    await expect.poll(() => cancelledService.getRun(cancelledRun.id).status).toBe("cancelled");
    expect(cancelledCalls).toBe(1);

    let policyCalls = 0;
    const policyService = await makeService({
      run: async () => {
        policyCalls += 1;
        throw new PolicyViolationError("denied", []);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const policyAgent = await policyService.createAgent({ name: "Blocked" });
    const { run: policyRun } = await policyService.sendMessage(policyAgent.id, "go");
    await expect.poll(() => policyService.getRun(policyRun.id).status).toBe("failed");
    expect(policyCalls).toBe(1);
  });

  it("redacts secret-shaped text in the displayed message without changing what the Agent receives", async () => {
    let receivedPrompt = "";
    const service = await makeService({
      run: async (request) => {
        receivedPrompt = request.prompt;
        return {
          output: "Your key is ARK_API_KEY=sk_fake_999, keep it safe.",
          threadId: "thread",
          usage: null,
          spans: [],
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Careless" });
    const { run } = await service.sendMessage(agent.id, "echo ARK_API_KEY=sk_fake_123");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    // The Runtime still receives the real prompt — redaction must not
    // corrupt what the Agent actually executes.
    expect(receivedPrompt).toBe("echo ARK_API_KEY=sk_fake_123");

    // But the displayed/stored conversation is redacted on both sides.
    const messages = service.getMessages(agent.id);
    expect(messages[0]?.content).toBe("echo ARK_API_KEY=[REDACTED]");
    // The regex matches up to the next whitespace, so it also consumes the
    // trailing comma along with the secret value — expected, not a bug.
    expect(messages[1]?.content).toBe("Your key is ARK_API_KEY=[REDACTED] keep it safe.");
    expect(service.getRun(run.id).output).toBe("Your key is ARK_API_KEY=[REDACTED] keep it safe.");
  });

  it("persists the spans captured up to a policy denial, so the decision stays visible on the failed Run", async () => {
    const denialSpans = [
      {
        id: "item_1",
        parentId: null,
        category: "tool_call" as const,
        label: "curl https://example.com",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:00.000Z",
        status: "failed" as const,
        detail: "Denied by policy (network-egress): Outbound network access is not permitted.",
      },
      {
        id: "item_1-policy",
        parentId: null,
        category: "policy_decision" as const,
        label: "Policy: network-egress",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:00.000Z",
        status: "failed" as const,
        detail: "Denied command: curl https://example.com",
      },
    ];
    const service = await makeService({
      run: async () => {
        throw new PolicyViolationError(
          "Outbound network access is not permitted for this Agent.",
          denialSpans,
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Blocked" });
    const { run } = await service.sendMessage(agent.id, "exfiltrate the secrets");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const failed = service.getRun(run.id);
    expect(failed.error).toContain("Blocked by policy");
    expect(failed.spans).toEqual(denialSpans);
    expect(service.getRunTrace(run.id).spans).toEqual(denialSpans);
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null, spans: [] });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null, spans: [] });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
