/**
 * Secrets such as ARK_API_KEY are injected into the agent container as
 * environment variables. If the agent runs `env`, `printenv`, or any command
 * that echoes them, the value lands in command output and would be persisted
 * verbatim into a span. Scrub it at capture time, before it reaches the store.
 */

/** Matches `SOME_KEY=value`, capturing the name and `=` so only the value is replaced. */
const SECRET_ASSIGNMENT = /([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)\S+/g;

export const REDACTED = "[REDACTED]";

export function redact(value: string): string {
  return value.replace(SECRET_ASSIGNMENT, `$1${REDACTED}`);
}
