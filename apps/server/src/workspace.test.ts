import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace.js";
import type { Agent } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  const timestamp = new Date().toISOString();
  return {
    name: "Test Agent",
    description: "",
    instructions: "",
    status: "ready",
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspacePath: "unused-placeholder",
    ...overrides,
  };
}

describe("WorkspaceManager", () => {
  it("creates, writes instructions to, and archives a workspace using the current root, ignoring a stale agent.workspacePath", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-workspace-test-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(root);
    await manager.initialize();

    const agent = makeAgent({
      id: "agent-1",
      // Simulates a record persisted under an old AGENT_WORKSPACE_ROOT
      // config value (e.g. a stale Docker-container path from before a
      // config fix) that no longer matches where files actually live.
      workspacePath: "/app/workspaces/agent-1",
    });

    await manager.create(agent);
    const realPath = path.join(root, "agent-1");
    expect(await readFile(path.join(realPath, "AGENTS.md"), "utf8")).toContain(
      "Test Agent",
    );

    const updated = { ...agent, instructions: "Be concise." };
    await manager.writeInstructions(updated);
    expect(await readFile(path.join(realPath, "AGENTS.md"), "utf8")).toContain(
      "Be concise.",
    );

    const destination = await manager.archive(updated);
    expect(destination.startsWith(path.join(root, ".deleted", "agent-1"))).toBe(true);
    await expect(readFile(path.join(realPath, "AGENTS.md"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(destination, "AGENTS.md"), "utf8")).toContain(
      "Be concise.",
    );
  });
});
