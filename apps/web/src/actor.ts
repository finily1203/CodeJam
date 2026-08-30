/**
 * A mock human identity for this browser, self-reported and unverified —
 * there is no real login on this single-user POC. A stable per-browser id is
 * generated once and kept in localStorage; the display name is whatever the
 * operator types into the Playground's "Acting as" field. Both are sent as
 * request headers so the server can attribute a Run to a principal (see
 * apps/server/src/app.ts: actorFromHeaders).
 */

const ACTOR_ID_KEY = "codejam.actorId";
const ACTOR_NAME_KEY = "codejam.actorName";

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getActorId(): string {
  try {
    const existing = localStorage.getItem(ACTOR_ID_KEY);
    if (existing) return existing;
    const generated = randomId();
    localStorage.setItem(ACTOR_ID_KEY, generated);
    return generated;
  } catch {
    // Private browsing or blocked storage: fall back to a per-call id rather
    // than throwing. The server still attributes the Run, just without a
    // stable identity across reloads.
    return randomId();
  }
}

export function getActorName(): string {
  try {
    return localStorage.getItem(ACTOR_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setActorName(name: string): void {
  try {
    localStorage.setItem(ACTOR_NAME_KEY, name);
  } catch {
    // Best-effort; a blocked store just loses the name across reloads.
  }
}
