// Offline account recovery via a paired Storage Node (ADR-0002, plan §24).
//
// When the Relay is unreachable, prove the recovery phrase to a LAN node, get
// this device registered there, and unlock the account's recovery-sealed file
// and folder keys from the node's envelopes. No Internet and no Relay session
// are involved; Relay-backed features resume once the device is online.

import { recoveryIdentityFromPhrase } from "@repo/core";
import { openFekFromEnvelope } from "@repo/sdk";
import {
  NodeClient,
  identityPrivateKey,
  identityPublicKey,
  nodusBaseUrl,
  type StoredDeviceIdentity,
} from "@repo/relay-client";

import { getTrustedNodes, addTrustedNode } from "../store/trusted-nodes";
import { putFileKey } from "../store/keys";
import { mobileRecoveryClient } from "./client";

export interface OfflineRecoveryResult {
  accountId: string;
  nodeId: string;
  files: number;
  folders: number;
}

/** Base64-encode an Ed25519 public key for comparison with the challenge. */
function publicKeyBase64(phrase: string): string {
  return mobileRecoveryClient().publicKey(phrase);
}

/**
 * Recover against the first paired LAN node. Throws when no node is paired or
 * the phrase does not match the account's recovery key.
 */
export async function recoverFromNode(
  phrase: string,
  device: StoredDeviceIdentity,
): Promise<OfflineRecoveryResult> {
  const trusted = await getTrustedNodes();
  const host = trusted[0]?.host;
  if (!host) {
    throw new Error(
      "Offline recovery needs a Storage Node paired with this device on the same network.",
    );
  }

  const client = new NodeClient(nodusBaseUrl(host));
  const challenge = await client.recoveryChallenge();

  // Check the phrase locally before spending the nonce, mirroring the online flow.
  if (publicKeyBase64(phrase) !== challenge.recovery_public_key) {
    throw new Error("That recovery phrase does not match this account");
  }

  const seed = recoveryIdentityFromPhrase(phrase).privateKey;
  const result = await client.recover({
    deviceId: device.device_id,
    devicePublicKey: identityPublicKey(device),
    nonce: challenge.nonce,
    recoveryPrivateSeed: seed,
  });
  if (result.status !== "ok") {
    throw new Error(result.message ?? "the node rejected recovery");
  }

  // The node registered this device during recovery, so the signed fetch works.
  const envelopes = await client.recoveryEnvelopes(device.device_id, identityPrivateKey(device));
  let files = 0;
  let folders = 0;
  for (const envelope of envelopes.file_envelopes) {
    await putFileKey(envelope.file_id, openFekFromEnvelope(envelope.encrypted_key, seed));
    files += 1;
  }
  for (const envelope of envelopes.folder_envelopes) {
    // Folder keys share the file-key table (an opaque id → key map).
    await putFileKey(envelope.folder_id, openFekFromEnvelope(envelope.encrypted_key, seed));
    folders += 1;
  }

  // Record the node as trusted so later LAN transfers work (recovery does not
  // require the device to have paired over the LAN before).
  const advertisement = await client.discovery();
  await addTrustedNode({
    node_id: advertisement.node_id,
    host,
    account_id: result.account_id ?? challenge.account_id,
    device_id: device.device_id,
    paired_at: new Date().toISOString(),
  });

  return {
    accountId: result.account_id ?? challenge.account_id,
    nodeId: advertisement.node_id,
    files,
    folders,
  };
}
