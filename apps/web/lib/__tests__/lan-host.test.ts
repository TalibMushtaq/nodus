import { describe, expect, it } from "vitest";

import { advertisementBindsNode, normalizeLanHost } from "../lan-host";

describe("normalizeLanHost", () => {
  it("accepts IPv4, IPv6 literals, and hostnames", () => {
    expect(normalizeLanHost("192.168.1.10")).toBe("192.168.1.10");
    expect(normalizeLanHost("  Node.Local  ")).toBe("node.local");
    expect(normalizeLanHost("[fe80::1]")).toBe("[fe80::1]");
  });

  it("tolerates a pasted scheme, path, and fixed port", () => {
    expect(normalizeLanHost("http://192.168.1.10/")).toBe("192.168.1.10");
    expect(normalizeLanHost("https://node.local:9378")).toBe("node.local");
  });

  it("rejects userinfo tricks and non-hosts", () => {
    expect(normalizeLanHost("127.0.0.1@evil.example")).toBeNull();
    expect(normalizeLanHost("has space")).toBeNull();
    expect(normalizeLanHost("")).toBeNull();
  });

  it("strips a pasted path rather than trusting it as part of the authority", () => {
    expect(normalizeLanHost("evil.example/path")).toBe("evil.example");
  });
});

describe("advertisementBindsNode", () => {
  const node = "ab".repeat(32);

  it("accepts a self-consistent advertisement", () => {
    expect(advertisementBindsNode({ node_id: node, public_key: node })).toBe(true);
  });

  it("matches the expected node id case-insensitively", () => {
    expect(
      advertisementBindsNode({ node_id: node, public_key: node }, node.toUpperCase()),
    ).toBe(true);
  });

  it("rejects a node_id that does not equal the public key", () => {
    expect(
      advertisementBindsNode({ node_id: "cd".repeat(32), public_key: node }),
    ).toBe(false);
  });

  it("rejects a mismatched expected node", () => {
    expect(
      advertisementBindsNode({ node_id: node, public_key: node }, "cd".repeat(32)),
    ).toBe(false);
  });
});
