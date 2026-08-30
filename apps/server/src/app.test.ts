import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AgentService } from "./agent-service.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentRunner, ExplainTraceInput, RunnerRequest, RunnerResult, TraceExplainer } from "./types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

class FakeTracingRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: "fake-thread",
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
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FakeExplainer implements TraceExplainer {
  async explain(input: ExplainTraceInput): Promise<{ text: string; usage: null }> {
    return { text: "Fake explanation for " + input.agentName, usage: null };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("serves a Run's trace through the real service and store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-trace-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const realService = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeTracingRunner(),
      new FakeExplainer(),
    );
    await realService.initialize();
    const app = await createApp(config, realService);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Tracer" },
    });
    const { agent } = created.json() as { agent: { id: string } };

    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/messages",
      payload: { content: "trace this" },
    });
    const { run } = sent.json() as { run: { id: string } };

    await expect
      .poll(async () => {
        const response = await app.inject({ method: "GET", url: "/api/runs/" + run.id });
        return (response.json() as { run: { status: string } }).run.status;
      })
      .toBe("completed");

    const traceResponse = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/trace",
    });
    expect(traceResponse.statusCode).toBe(200);
    const trace = traceResponse.json();
    expect(trace).toMatchObject({ runId: run.id, agentId: agent.id, status: "completed" });
    expect(trace.environment).toMatchObject({ arkModel: "ep-test" });
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]).toMatchObject({ category: "model_call", status: "completed" });

    const missing = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-0000-0000-000000000000/trace",
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it("attributes a Run to the actor identified via request headers, falling back to anonymous when absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-actor-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const realService = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeTracingRunner(),
      new FakeExplainer(),
    );
    await realService.initialize();
    const app = await createApp(config, realService);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Attributed" },
    });
    const { agent } = created.json() as { agent: { id: string } };

    const named = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/messages",
      headers: { "x-actor-id": "user-42", "x-actor-name": "Jing Rui" },
      payload: { content: "hi" },
    });
    const { run: namedRun } = named.json() as { run: { id: string } };
    expect(namedRun).toMatchObject({
      initiatedBy: { type: "human", id: "user-42", name: "Jing Rui" },
    });

    const traceResponse = await app.inject({
      method: "GET",
      url: "/api/runs/" + namedRun.id + "/trace",
    });
    expect(traceResponse.json()).toMatchObject({
      initiatedBy: { type: "human", id: "user-42", name: "Jing Rui" },
    });

    await expect
      .poll(async () => {
        const response = await app.inject({ method: "GET", url: "/api/runs/" + namedRun.id });
        return (response.json() as { run: { status: string } }).run.status;
      })
      .toBe("completed");

    const anonymous = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/messages",
      payload: { content: "hi again" },
    });
    const { run: anonymousRun } = anonymous.json() as { run: { id: string } };
    expect(anonymousRun).toMatchObject({
      initiatedBy: { type: "human", id: "anonymous", name: "Anonymous operator" },
    });

    await expect
      .poll(async () => {
        const response = await app.inject({ method: "GET", url: "/api/runs/" + anonymousRun.id });
        return (response.json() as { run: { status: string } }).run.status;
      })
      .toBe("completed");

    await app.close();
  });
});
