import { describe, expect, it } from "vitest";

import { isLocalRelayHost, normalizeRelayUrl, validateRelayUrl } from "./relay-url";

describe("normalizeRelayUrl", () => {
  it("defaults a bare remote host to https", () => {
    expect(normalizeRelayUrl("relay.example.com")).toBe("https://relay.example.com");
  });

  it("defaults a bare local host to http", () => {
    expect(normalizeRelayUrl("10.0.2.2:8080")).toBe("http://10.0.2.2:8080");
    expect(normalizeRelayUrl("localhost:8080")).toBe("http://localhost:8080");
  });

  it("strips trailing slashes", () => {
    expect(normalizeRelayUrl("https://relay.example.com///")).toBe("https://relay.example.com");
    expect(normalizeRelayUrl("https://relay.example.com/api/")).toBe("https://relay.example.com/api");
  });

  it("maps WebSocket schemes to HTTP schemes", () => {
    expect(normalizeRelayUrl("wss://relay.example.com")).toBe("https://relay.example.com");
    expect(normalizeRelayUrl("ws://10.0.2.2:8080")).toBe("http://10.0.2.2:8080");
  });

  it("drops query strings and fragments from the base", () => {
    expect(normalizeRelayUrl("https://relay.example.com/?a=1#b")).toBe("https://relay.example.com");
  });

  it("rejects empty input and non-http schemes", () => {
    expect(() => normalizeRelayUrl("   ")).toThrow(/Enter the Relay/);
    expect(() => normalizeRelayUrl("ftp://relay.example.com")).toThrow(/http/);
  });

  it("rejects cleartext for remote hosts", () => {
    expect(() => normalizeRelayUrl("http://relay.example.com")).toThrow(/https/);
  });

  it("allows cleartext for IPv6 loopback", () => {
    expect(normalizeRelayUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
  });
});

describe("validateRelayUrl", () => {
  it("accepts canonical URLs unchanged", () => {
    expect(validateRelayUrl("https://relay.example.com")).toBe("https://relay.example.com");
    expect(validateRelayUrl("http://10.0.2.2:8080")).toBe("http://10.0.2.2:8080");
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => validateRelayUrl("https://user:pass@relay.example.com")).toThrow(/username/);
  });
});

describe("isLocalRelayHost", () => {
  it("recognizes loopback and the emulator alias", () => {
    expect(isLocalRelayHost("localhost")).toBe(true);
    expect(isLocalRelayHost("127.0.0.1")).toBe(true);
    expect(isLocalRelayHost("::1")).toBe(true);
    expect(isLocalRelayHost("[::1]")).toBe(true);
    expect(isLocalRelayHost("10.0.2.2")).toBe(true);
    expect(isLocalRelayHost("relay.example.com")).toBe(false);
  });
});
