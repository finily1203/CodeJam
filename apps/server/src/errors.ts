import type { RunSpan } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class PolicyViolationError extends Error {
  /**
   * Carries the spans captured before termination — including the
   * policy_decision span itself — so AgentService can persist them on the
   * failed Run instead of discarding them. Without this, the one span that
   * proves the denial happened would be lost on the generic error path.
   */
  constructor(
    reason: string,
    public readonly spans: RunSpan[] = [],
  ) {
    super("Blocked by policy: " + reason);
    this.name = "PolicyViolationError";
  }
}
