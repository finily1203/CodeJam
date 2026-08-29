import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATABASE_VERSION, type Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: DATABASE_VERSION,
  agents: [],
  messages: [],
  runs: [],
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
        parsed.version = DATABASE_VERSION;
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
