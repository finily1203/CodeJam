import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATABASE_VERSION, type Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: DATABASE_VERSION,
  agents: [],
  messages: [],
  runs: [],
  agentVersions: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.messages) ||
        !Array.isArray(parsed.runs)
      ) {
        throw new Error("Unsupported database format");
      }
      let migrated = false;
      if (parsed.version === 1) {
        for (const run of parsed.runs as Array<Record<string, unknown>>) {
          if (!Array.isArray(run.spans)) run.spans = [];
        }
        parsed.version = 2;
        migrated = true;
      }
      if (parsed.version === 2) {
        for (const run of parsed.runs as Array<Record<string, unknown>>) {
          if (!run.initiatedBy) {
            run.initiatedBy = {
              type: "human",
              id: "unknown",
              name: "Unknown (pre-identity run)",
            };
          }
        }
        parsed.version = 3;
        migrated = true;
      }
      if (parsed.version === 3) {
        // The Codex thread a pre-migration run participated in was never
        // recorded on the Run itself (only the Agent's *current* thread was
        // tracked), so there is no honest value to backfill beyond "unknown."
        for (const run of parsed.runs as Array<Record<string, unknown>>) {
          if (run.sessionId === undefined) {
            run.sessionId = null;
          }
        }
        parsed.version = 4;
        migrated = true;
      }
      if (parsed.version === 4) {
        // Which model/sandbox mode/runtime a pre-migration run actually used
        // was never recorded — only ever readable live from current config,
        // which may have since changed. No honest value to backfill beyond
        // null, same reasoning as sessionId above.
        for (const run of parsed.runs as Array<Record<string, unknown>>) {
          if (run.environment === undefined) {
            run.environment = null;
          }
        }
        parsed.version = 5;
        migrated = true;
      }
      if (parsed.version === 5) {
        // Versioning starts here, so every pre-migration Agent has genuinely
        // only ever had one configuration — 1 is the true version, not a
        // placeholder, and the same reasoning applies to every Run it
        // already produced.
        if (!Array.isArray(parsed.agentVersions)) parsed.agentVersions = [];
        for (const agent of parsed.agents as Array<Record<string, unknown>>) {
          if (agent.version === undefined) agent.version = 1;
        }
        for (const run of parsed.runs as Array<Record<string, unknown>>) {
          if (run.agentVersion === undefined) run.agentVersion = 1;
        }
        parsed.version = 6;
        migrated = true;
      }
      if (parsed.version !== DATABASE_VERSION) {
        throw new Error("Unsupported database format");
      }
      this.data = parsed as unknown as Database;
      if (migrated) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
