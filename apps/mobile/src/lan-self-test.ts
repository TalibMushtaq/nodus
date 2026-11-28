/**
 * On-device LAN self-test for the Pairing screen.
 *
 * Answers "can this phone actually reach my Storage Node over Wi-Fi?" without
 * requiring a real upload: run discovery, probe each candidate's
 * `/nodus/discovery`, and — for nodes this device already paired with — complete
 * the Ed25519 challenge-response that Path A uses. A pass here means the
 * cleartext policy, mDNS/sweep discovery, node binding, and local auth all work,
 * so a later transfer failure is not a LAN problem.
 *
 * All side effects are injected so the policy (binding check, unpaired skip,
 * per-step error capture) is unit-testable without a device.
 */

import { advertisementBindsNode } from "@repo/relay-client/local-discovery";

import type { DiscoveryOutcome } from "./discovery";

/** The two checks performed per discovered node. */
export type LanStepName = "advertise" | "auth";

export interface LanStep {
  name: LanStepName;
  ok: boolean;
  /**
   * True when the check could not run because this device has no local trust
   * with the node: pairing needs a Relay-issued token, so discovery is all a
   * scan can prove. Kept distinct from `ok` so the UI does not show a green
   * pass for a connection that never happened.
   */
  skipped?: boolean;
  detail: string;
}

export interface LanNodeResult {
  host: string;
  nodeId: string;
  /** Whether this device has a trusted-node entry for the discovered id. */
  paired: boolean;
  /** Every non-skipped step passed. */
  ok: boolean;
  steps: LanStep[];
}

export interface LanSelfTestReport {
  permitted: boolean;
  method: DiscoveryOutcome["method"];
  nodes: LanNodeResult[];
  /** At least one node found, permission granted, and no failed step. */
  ok: boolean;
}

export interface LanSelfTestDeps {
  /** mDNS-first discovery with the /24 sweep fallback (see `discovery.ts`). */
  discover: () => Promise<DiscoveryOutcome>;
  /** `GET /nodus/discovery` on the candidate host. */
  advertise: (host: string) => Promise<{ node_id: string; public_key: string; schema_version: string }>;
  /** Node ids this device trusts locally (SQLite `trusted_nodes`). */
  pairedNodeIds: () => Promise<string[]>;
  /** Full local challenge-response; must throw when the node rejects it. */
  authenticate: (host: string, nodeId: string) => Promise<void>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runLanSelfTest(deps: LanSelfTestDeps): Promise<LanSelfTestReport> {
  const discovery = await deps.discover();
  const paired = new Set((await deps.pairedNodeIds()).map((id) => id.toLowerCase()));

  const nodes: LanNodeResult[] = [];
  for (const candidate of discovery.candidates) {
    const nodeId = candidate.node_id;
    const isPaired = paired.has(nodeId.toLowerCase());
    const steps: LanStep[] = [];

    // Probe the HTTP advertisement: the mDNS record is an unverified network
    // location, so the node id it claims must match the one the node signs for.
    try {
      const adv = await deps.advertise(candidate.host);
      const bound = advertisementBindsNode(adv, nodeId);
      steps.push({
        name: "advertise",
        ok: bound,
        detail: bound
          ? `node ${nodeId.slice(0, 12)}… · v${adv.schema_version}`
          : "host advertises a different node id",
      });
    } catch (err) {
      steps.push({ name: "advertise", ok: false, detail: message(err) });
    }

    // Only attempt auth after the binding check passed; signing a challenge
    // from an unverified host would hand a device proof to a rogue responder.
    if (steps[0]?.ok) {
      if (!isPaired) {
        steps.push({ name: "auth", ok: true, skipped: true, detail: "not paired — discovery only" });
      } else {
        try {
          await deps.authenticate(candidate.host, nodeId);
          steps.push({ name: "auth", ok: true, detail: "challenge-response accepted" });
        } catch (err) {
          steps.push({ name: "auth", ok: false, detail: message(err) });
        }
      }
    }

    nodes.push({
      host: candidate.host,
      nodeId,
      paired: isPaired,
      ok: steps.every((step) => step.skipped || step.ok),
      steps,
    });
  }

  return {
    permitted: discovery.permitted,
    method: discovery.method,
    nodes,
    ok: discovery.permitted && nodes.length > 0 && nodes.every((node) => node.ok),
  };
}
