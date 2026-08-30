import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import type { Database } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("migrates a version-1 database on disk by backfilling spans and initiatedBy on existing runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const legacyDatabase = {
      version: 1,
      agents: [],
      messages: [],
      runs: [
        {
          id: "run-1",
          agentId: "agent-1",
          status: "completed",
          prompt: "hello",
          output: "hi",
          error: null,
          usage: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(legacyDatabase), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    const migrated = store.snapshot();
    expect(migrated.version).toBe(4);
    expect(migrated.runs[0]?.spans).toEqual([]);
    expect(migrated.runs[0]?.initiatedBy).toEqual({
      type: "human",
      id: "unknown",
      name: "Unknown (pre-identity run)",
    });
    expect(migrated.runs[0]?.sessionId).toBeNull();

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as Database;
    expect(onDisk.version).toBe(4);
    expect(onDisk.runs[0]?.spans).toEqual([]);
    expect(onDisk.runs[0]?.initiatedBy).toEqual({
      type: "human",
      id: "unknown",
      name: "Unknown (pre-identity run)",
    });
    expect(onDisk.runs[0]?.sessionId).toBeNull();
  });

  it("migrates a version-2 database on disk by backfilling initiatedBy on existing runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const legacyDatabase = {
      version: 2,
      agents: [],
      messages: [],
      runs: [
        {
          id: "run-1",
          agentId: "agent-1",
          status: "completed",
          prompt: "hello",
          output: "hi",
          error: null,
          usage: null,
          spans: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(legacyDatabase), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    const migrated = store.snapshot();
    expect(migrated.version).toBe(4);
    expect(migrated.runs[0]?.initiatedBy).toEqual({
      type: "human",
      id: "unknown",
      name: "Unknown (pre-identity run)",
    });
    expect(migrated.runs[0]?.sessionId).toBeNull();
  });

  it("migrates a version-3 database on disk by backfilling sessionId on existing runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const legacyDatabase = {
      version: 3,
      agents: [],
      messages: [],
      runs: [
        {
          id: "run-1",
          agentId: "agent-1",
          status: "completed",
          prompt: "hello",
          output: "hi",
          error: null,
          usage: null,
          spans: [],
          initiatedBy: { type: "human", id: "user-1", name: "Someone" },
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(legacyDatabase), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    const migrated = store.snapshot();
    expect(migrated.version).toBe(4);
    expect(migrated.runs[0]?.sessionId).toBeNull();
    expect(migrated.runs[0]?.initiatedBy).toEqual({
      type: "human",
      id: "user-1",
      name: "Someone",
    });
  });

  it("rejects a database file from an unsupported future version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 99, agents: [], messages: [], runs: [] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow("Unsupported database format");
  });
});
