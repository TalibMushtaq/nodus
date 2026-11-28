import { describe, expect, it, vi } from "vitest";

import type { DiscoveryOutcome, LanCandidate } from "./discovery";
import { runLanSelfTest, type LanSelfTestDeps } from "./lan-self-test";

const NODE_A = "aa".repeat(32);
const NODE_B = "bb".repeat(32);

function candidate(host: string, nodeId: string): LanCandidate {
  return { host, node_id: nodeId, schema_version: "1" };
}

function outcome(
  candidates: LanCandidate[],
  method: DiscoveryOutcome["method"] = "mdns",
  permitted = true,
): DiscoveryOutcome {
  return { candidates, method, permitted };
}

/** Deps with every side effect stubbed; overrides apply per test. */
function deps(overrides: Partial<LanSelfTestDeps> = {}): LanSelfTestDeps {
  return {
    discover: vi.fn(async () => outcome([candidate("192.168.1.50", NODE_A)])),
    advertise: vi.fn(async () => ({ node_id: NODE_A, public_key: NODE_A, schema_version: "1" })),
    pairedNodeIds: vi.fn(async () => [NODE_A]),
    authenticate: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("runLanSelfTest", () => {
  it("passes when a paired node answers discovery and auth", async () => {
    const report = await runLanSelfTest(deps());

    expect(report.ok).toBe(true);
    expect(report.method).toBe("mdns");
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0]?.steps.map((s) => [s.name, s.ok, s.skipped ?? false])).toEqual([
      ["advertise", true, false],
      ["auth", true, false],
    ]);
  });

  it("skips auth for a node this device has not paired with", async () => {
    const authenticate = vi.fn(async () => undefined);
    const report = await runLanSelfTest(
      deps({ pairedNodeIds: async () => [], authenticate }),
    );

    expect(authenticate).not.toHaveBeenCalled();
    // Discovery alone is a pass; the auth step is reported as skipped, not green.
    expect(report.nodes[0]?.paired).toBe(false);
    expect(report.nodes[0]?.steps[1]).toMatchObject({ name: "auth", skipped: true });
    expect(report.ok).toBe(true);
  });

  it("fails when the host advertises a different node id", async () => {
    const authenticate = vi.fn(async () => undefined);
    const report = await runLanSelfTest(
      deps({
        advertise: async () => ({ node_id: NODE_B, public_key: NODE_B, schema_version: "1" }),
        authenticate,
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.nodes[0]?.steps[0]).toMatchObject({ name: "advertise", ok: false });
    // A mismatched host must never receive a device signature.
    expect(authenticate).not.toHaveBeenCalled();
    expect(report.nodes[0]?.steps).toHaveLength(1);
  });

  it("reports an unreachable host without throwing the whole run", async () => {
    const report = await runLanSelfTest(
      deps({
        discover: async () =>
          outcome([candidate("192.168.1.50", NODE_A), candidate("192.168.1.51", NODE_B)]),
        advertise: async (host) => {
          if (host === "192.168.1.51") throw new Error("cleartext HTTP not permitted");
          return { node_id: NODE_A, public_key: NODE_A, schema_version: "1" };
        },
      }),
    );

    expect(report.nodes).toHaveLength(2);
    expect(report.nodes[1]?.steps[0]?.detail).toContain("cleartext");
    expect(report.ok).toBe(false);
  });

  it("fails when the node rejects the challenge-response", async () => {
    const report = await runLanSelfTest(
      deps({
        authenticate: async () => {
          throw new Error("auth failed: HTTP 401");
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.nodes[0]?.steps[1]).toMatchObject({ name: "auth", ok: false });
  });

  it("is not ok when permission was denied even if a sweep found nodes", async () => {
    const report = await runLanSelfTest(
      deps({ discover: async () => outcome([candidate("192.168.1.50", NODE_A)], "lan_sweep", false) }),
    );

    expect(report.permitted).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("is not ok when nothing answered on the network", async () => {
    const report = await runLanSelfTest(deps({ discover: async () => outcome([], "lan_sweep") }));

    expect(report.nodes).toEqual([]);
    expect(report.ok).toBe(false);
  });
});
