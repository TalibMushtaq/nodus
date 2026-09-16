import { beforeEach, describe, expect, it, vi } from "vitest";

import { discoverNodes, myLanV4, scanLan } from "./discovery";

// Native modules and the SDK fetch are mocked so the discovery *policy*
// (mDNS-first, sweep fallback, permission propagation) is tested without a
// device or a LAN.
const { mockBrowseNodes, mockGetIp, mockFetchAdvertisement } = vi.hoisted(() => ({
  mockBrowseNodes: vi.fn(),
  mockGetIp: vi.fn(),
  mockFetchAdvertisement: vi.fn(),
}));

vi.mock("./mdns", () => ({ browseNodes: mockBrowseNodes }));
vi.mock("expo-network", () => ({ getIpAddressAsync: mockGetIp }));
vi.mock("@repo/relay-client/local-discovery", () => ({
  fetchAdvertisement: mockFetchAdvertisement,
  nodusBaseUrl: (host: string) => `http://${host}:9378`,
}));

/** Exact host from the mocked base URL, so `.10` never matches `.100`. */
function hostOf(base: string): string {
  return base.replace(/^https?:\/\//, "").split(":")[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("myLanV4", () => {
  it("rejects non-IPv4 and unassigned addresses", async () => {
    mockGetIp.mockResolvedValue("not-an-ip");
    expect(await myLanV4()).toBeNull();
    mockGetIp.mockResolvedValue("0.0.0.0");
    expect(await myLanV4()).toBeNull();
    mockGetIp.mockResolvedValue("192.168.1.42");
    expect(await myLanV4()).toBe("192.168.1.42");
  });
});

describe("scanLan", () => {
  it("keeps only hosts that answer the advertisement probe and skips self", async () => {
    mockFetchAdvertisement.mockImplementation(async (base: string) => {
      const host = hostOf(base);
      if (host === "192.168.1.10") {
        return { node_id: "node-10", schema_version: "1.8" };
      }
      if (host === "192.168.1.50") {
        // This device's own address must never be reported as a peer.
        return { node_id: "node-self", schema_version: "1.8" };
      }
      throw new Error("no listener");
    });

    const found = await scanLan("192.168.1.50");
    expect(found).toEqual([{ host: "192.168.1.10", node_id: "node-10", schema_version: "1.8" }]);
  });
});

describe("discoverNodes", () => {
  it("prefers mDNS when permitted and it found nodes", async () => {
    mockBrowseNodes.mockResolvedValue({
      permitted: true,
      candidates: [{ host: "192.168.1.10", node_id: "node-mdns", schema_version: "1.8" }],
    });

    const outcome = await discoverNodes();
    expect(outcome.method).toBe("mdns");
    expect(outcome.candidates[0]!.node_id).toBe("node-mdns");
    expect(mockGetIp).not.toHaveBeenCalled();
  });

  it("falls back to the sweep when mDNS finds nothing", async () => {
    mockBrowseNodes.mockResolvedValue({ permitted: true, candidates: [] });
    mockGetIp.mockResolvedValue("192.168.1.50");
    mockFetchAdvertisement.mockImplementation(async (base: string) => {
      const host = hostOf(base);
      if (host === "192.168.1.20") {
        return { node_id: "node-sweep", schema_version: "1.8" };
      }
      throw new Error("no listener");
    });

    const outcome = await discoverNodes();
    expect(outcome.method).toBe("lan_sweep");
    expect(outcome.permitted).toBe(true);
    expect(outcome.candidates).toEqual([
      { host: "192.168.1.20", node_id: "node-sweep", schema_version: "1.8" },
    ]);
  });

  it("propagates a denied permission and reports none without an IP", async () => {
    mockBrowseNodes.mockResolvedValue({ permitted: false, candidates: [] });
    mockGetIp.mockResolvedValue("0.0.0.0");

    const outcome = await discoverNodes();
    expect(outcome.method).toBe("none");
    expect(outcome.permitted).toBe(false);
  });
});
