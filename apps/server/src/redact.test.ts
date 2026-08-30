import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("replaces the value of a secret assignment", () => {
    expect(redact("ARK_API_KEY=sk_fake_123")).toBe("ARK_API_KEY=[REDACTED]");
  });
    it("leaves ordinary environment variables alone", () => {
    expect(redact("PATH=/usr/bin")).toBe("PATH=/usr/bin");
  });
    it("redacts every secret on a line, not just the first", () => {
    const out = redact("A_TOKEN=aaa111 B_SECRET=bbb222");
    expect(out).not.toContain("aaa111");
    expect(out).not.toContain("bbb222");
  });

  it("leaves text without secrets untouched", () => {
    expect(redact("hello world")).toBe("hello world");
  });
});