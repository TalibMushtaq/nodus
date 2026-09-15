// Shard download / decrypt / reconstruct (shared by web and native).
//
// F2a made files *shareable* (FEK sealed to each device/node); this is the
// first consumer: a device opens its envelope, fetches each stored shard,
// verifies the ciphertext hash, decrypts, reassembles in shard order, and
// decrypts the display name. All I/O is injected through `DownloadDeps` so the
// browser and native clients supply their own transport/catalogue.

import {
  createPlaintextHasher,
  decryptName,
  decryptShard,
  hashShard,
  reconstructFromShards,
  unpackEncryptedShard,
} from "@repo/core";
import type { FileId, Shard, ShardIndex } from "@repo/core";

/** A physical location row as returned by the Relay (file_locations). */
export interface RelayFileLocation {
  version_number: number;
  shard_index: number;
  node_id: string;
  status: string;
  hash: string | null;
  size_bytes: number | null;
}

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
