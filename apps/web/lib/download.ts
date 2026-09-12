// Shard download / decrypt / reconstruct (Phase 14 F2b).
//
// F2a made files *shareable* (FEK sealed to each device/node); this is the
// first consumer: a second device opens its envelope, fetches each stored
// shard, verifies the ciphertext hash, decrypts, reassembles in shard order,
// and decrypts the display name.

import {
  createPlaintextHasher,
  decryptName,
  decryptShard,
  hashShard,
  reconstructFromShards,
  unpackEncryptedShard,
} from "@repo/core";
import type { FileId, Shard, ShardIndex } from "@repo/core";
import { NodeClient, identityPrivateKey, nodusBaseUrl } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { getCachedCatalog } from "./catalog";
import type { RelayFileLocation } from "./catalog";
import { fetchAndOpenFileKey } from "./envelopes";
import { getTrustedNodes } from "./trusted-nodes";

/** This device has no FEK envelope for the file (shared before it was added). */
export class MissingEnvelopeError extends Error {
  constructor(fileId: string) {
    super(`no key envelope for this device for file ${fileId}`);
    this.name = "MissingEnvelopeError";
  }
}

/** A required shard is not stored on a reachable node (buffered/absent). */
export class ShardUnavailableError extends Error {
  constructor(shardIndex: number, status: string) {
    super(`shard ${shardIndex} is not downloadable (status: ${status})`);
    this.name = "ShardUnavailableError";
  }
}

/** Fetched bytes did not match the recorded BLAKE3 hash. */
export class ShardIntegrityError extends Error {
  constructor(shardIndex: number) {
    super(`shard ${shardIndex} failed its BLAKE3 integrity check`);
    this.name = "ShardIntegrityError";
  }
}

export interface DownloadDeps {
  fetchFileKey(fileId: string): Promise<Uint8Array | null>;
  getShardLocations(fileId: string, versionNumber: number): Promise<RelayFileLocation[]>;
  /** Fetch the packed (nonce||ciphertext) shard bytes from its location. */
  fetchShard(fileId: string, location: RelayFileLocation): Promise<Uint8Array>;
}

export interface DownloadFileOptions {
  fileId: string;
  versionNumber: number;
  shardCount: number;
  encryptedName?: string | null;
  /** Optional plaintext BLAKE3 from the catalog, verified after reassembly. */
  expectedVersionHash?: string | null;
  deps: DownloadDeps;
}

export interface DownloadResult {
  data: Uint8Array;
  name: string | null;
}

/**
 * Download and decrypt one file version. Throws `MissingEnvelopeError`,
 * `ShardUnavailableError`, or `ShardIntegrityError` for the distinct failure
 * modes a caller should surface differently.
 */
export async function downloadFile(options: DownloadFileOptions): Promise<DownloadResult> {
  const { fileId, versionNumber, shardCount, encryptedName, expectedVersionHash, deps } = options;

  const fek = await deps.fetchFileKey(fileId);
  if (!fek) {
    throw new MissingEnvelopeError(fileId);
  }

  const locations = (await deps.getShardLocations(fileId, versionNumber)).filter(
    (l) => l.version_number === versionNumber,
  );
  const byIndex = new Map<number, RelayFileLocation>();
  for (const location of locations) {
    // Only a shard committed on a node is retrievable; buffered/in-transit
    // shards have no client-facing fetch path.
    if (location.status === "NODE_STORED") {
      byIndex.set(location.shard_index, location);
    }
  }

  const shards: Shard[] = [];
  for (let index = 0; index < shardCount; index += 1) {
    const location = byIndex.get(index);
    if (!location) {
      const anyStatus = locations.find((l) => l.shard_index === index)?.status ?? "missing";
      throw new ShardUnavailableError(index, anyStatus);
    }
    const packed = await deps.fetchShard(fileId, location);
    if (location.hash && hashShard(packed) !== location.hash) {
      throw new ShardIntegrityError(index);
    }
    const encrypted = unpackEncryptedShard(fileId as FileId, index as ShardIndex, packed);
    shards.push(decryptShard(encrypted, fek));
  }

  shards.sort((a, b) => a.index - b.index);
  const data = reconstructFromShards(shards);

  if (expectedVersionHash) {
    const hasher = createPlaintextHasher();
    hasher.update(data);
    if (hasher.digest() !== expectedVersionHash) {
      throw new ShardIntegrityError(-1);
    }
  }

  return {
    data,
    name: encryptedName ? decryptName(encryptedName, fek) : null,
  };
}

/**
 * Browser deps: FEK from the device's envelope, locations from the cached
 * catalog, shards from the trusted LAN node that stores them.
 */
export function browserDownloadDeps(device: StoredDeviceIdentity): DownloadDeps {
  return {
    async fetchFileKey(fileId) {
      return fetchAndOpenFileKey(fileId, device.device_id, identityPrivateKey(device));
    },
    async getShardLocations(fileId) {
      const catalog = await getCachedCatalog();
      const entry = catalog.find((c) => c.file_id === fileId);
      return entry?.locations ?? [];
    },
    async fetchShard(_fileId, location) {
      const nodes = await getTrustedNodes();
      const host = nodes.find((n) => n.node_id === location.node_id)?.host;
      if (!host || !location.hash) {
        throw new ShardUnavailableError(location.shard_index, "no_trusted_host");
      }
      const client = new NodeClient(nodusBaseUrl(host));
      return client.fetchShard(device.device_id, identityPrivateKey(device), location.hash);
    },
  };
}
