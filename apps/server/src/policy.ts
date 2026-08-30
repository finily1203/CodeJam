/**
 * Coarse, pattern-based command policy for the Agent Runtime. This is a
 * detection boundary, not a prevention boundary: Codex CLI executes tool
 * calls inside its own sandboxed subprocess, so the platform only observes
 * `command_execution` items after Codex has already decided to run them.
 * A match here causes the Runtime to terminate the Codex process immediately
 * (see codex-runner.ts / container-codex-runner.ts) rather than letting the
 * Run continue — real containment for a slow/long-running command, honest
 * after-the-fact detection for one that completes before the event is
 * parsed. Three threats from the brief's threat-modeling table motivate the
 * rules below: "Credential theft or exposure," "Cross-user access or data
 * exfiltration," and "Sandbox escape or untrusted code."
 */

export interface PolicyDecision {
  id: string;
  reason: string;
}

const POLICY_RULES: ReadonlyArray<{ id: string; pattern: RegExp; reason: string }> = [
  {
    id: "network-egress",
    // Negative lookbehind excludes "ssh" appearing inside a path like
    // "~/.ssh/id_rsa" (that's credential access, caught by the rule below),
    // while still matching it as a standalone command token.
    pattern: /(?<!\.)\b(curl|wget|nc|ncat|telnet|ssh|scp)\b/i,
    reason: "Outbound network access is not permitted for this Agent.",
  },
  {
    id: "secret-file-access",
    pattern: /\.env\b|ARK_API_KEY|id_rsa|\.ssh\//i,
    reason: "Access to credential material is not permitted for this Agent.",
  },
  {
    id: "destructive-filesystem",
    // Recursive+force rm (either flag order, e.g. -rf or -fr), mkfs, and dd
    // writing to a raw device. Plain "rm file.txt" or "rm -f onefile" stays
    // allowed — only the destructive combination trips this rule.
    pattern:
      /\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b|\bmkfs\b|\bdd\b[^\n]*\bof=\/dev\//i,
    reason: "Destructive filesystem operations are not permitted for this Agent.",
  },
];

/** Returns the first matching rule for a command, or null when none apply. */
export function evaluateCommandPolicy(command: string): PolicyDecision | null {
  for (const rule of POLICY_RULES) {
    if (rule.pattern.test(command)) {
      return { id: rule.id, reason: rule.reason };
    }
  }
  return null;
}
