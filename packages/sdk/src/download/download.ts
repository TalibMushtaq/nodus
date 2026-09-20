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

/**
 * Whether a location's bytes can be fetched by a client.
 *
 * `NODE_STORED` is a durable copy the Relay pulls from a node. The buffer
 * statuses mean the Relay still holds the ciphertext (`buffer_id` set) and
 * serves it directly over `GET /shards/{hash}`, so a file that reached the
 * Relay but has not been picked up by a node is still downloadable.
 */
export function isFetchableLocation(location: RelayFileLocation): boolean {
  return (
    location.status === "NODE_STORED" ||
    location.status === "RELAY_BUFFERED" ||
    location.status === "NODE_RECEIVING" ||
    location.status === "NODE_VERIFIED"
  );
}

/**
 * How a shard's bytes actually crossed the wire. Reported by the platform deps
 * (only they know which transport served a given fetch) so the UI can label a
 * download honestly instead of assuming one path for the whole file. A single
 * file can mix transports if a node goes unreachable mid-download.
 */
export type DownloadTransport = "lan" | "relay" | "webrtc";

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

/** The caller aborted the download via its AbortSignal. */
export class DownloadCancelledError extends Error {
  constructor() {
    super("download cancelled");
    this.name = "DownloadCancelledError";
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
  /**
   * Fetch the packed (nonce||ciphertext) shard bytes from its location.
   *
   * `onProgress` is optional and advisory: transports that can stream (WebRTC
   * data channel, HTTP with a readable body) report cumulative bytes for the
   * current shard as they arrive, so the UI's byte counter and speed update
   * mid-shard instead of jumping once per shard. A transport that cannot stream
   * simply never calls it, and the caller still gets the final shard event.
   */
  fetchShard(
    fileId: string,
    location: RelayFileLocation,
    onProgress?: (receivedBytes: number, totalBytes: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /**
   * Best-effort notification of which transport served the fetch, so the UI can
   * show "Local P2P" vs "Relay buffer" vs "WebRTC" per download. Optional and
   * never awaited: a throwing subscriber must not abort the transfer.
   */
  onTransport?(transport: DownloadTransport): void;
}

/**
 * What the download loop is doing right now. Fetched shards are handled
 * serially (fetch → verify → decrypt), so a UI can label the current stage
 * instead of showing an opaque bar.
 */
export type DownloadPhase =
  | "unlocking"
  | "fetching"
  | "verifying"
  | "decrypting"
  | "assembling"
  | "done";

export interface DownloadProgressEvent {
  phase: DownloadPhase;
  /** Shards fully fetched + verified + decrypted. */
  completedShards: number;
  totalShards: number;
  /** Ciphertext bytes fetched so far (network progress). */
  completedBytes: number;
  /** Sum of the version's declared ciphertext sizes, or 0 when unknown. */
  totalBytes: number;
}

export interface DownloadFileOptions {
  fileId: string;
  versionNumber: number;
  shardCount: number;
  encryptedName?: string | null;
  /** Optional plaintext BLAKE3 from the catalog, verified after reassembly. */
  expectedVersionHash?: string | null;
  deps: DownloadDeps;
  /**
   * Stage/byte progress. Optional and best-effort: the download never awaits
   * it, so a slow or throwing callback cannot stall or fail the transfer.
   */
  onProgress?: (event: DownloadProgressEvent) => void;
  /**
   * Cancellation. Aborting rejects with `DownloadCancelledError` and, where the
   * transport supports it, aborts the in-flight fetch so no more bytes move.
   */
  signal?: AbortSignal;
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
  const { fileId, versionNumber, shardCount, encryptedName, expectedVersionHash, deps, onProgress, signal } =
    options;

  // Progress is advisory: a throwing subscriber must not abort a download.
  const emit = (phase: DownloadPhase, completedShards: number, completedBytes: number, totalBytes: number) => {
    try {
      onProgress?.({ phase, completedShards, totalShards: shardCount, completedBytes, totalBytes });
    } catch {
      // Ignore callback errors.
    }
  };

  // Normalize cancellation: a transport may reject with its own abort error, so
  // this throws the SDK's typed error whenever the caller's signal is aborted.
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new DownloadCancelledError();
  };

  throwIfCancelled();
  emit("unlocking", 0, 0, 0);

  const fek = await deps.fetchFileKey(fileId);
  throwIfCancelled();
  if (!fek) {
    throw new MissingEnvelopeError(fileId);
  }

  const locations = (await deps.getShardLocations(fileId, versionNumber)).filter(
    (l) => l.version_number === versionNumber,
  );
  const byIndex = new Map<number, RelayFileLocation>();
  let totalBytes = 0;
  for (const location of locations) {
    if (location.size_bytes != null) totalBytes += location.size_bytes;
    // A shard is retrievable when it is on a node OR still in the Relay buffer;
    // the fetch layer falls back to the Relay for the buffered case.
    if (isFetchableLocation(location)) {
      byIndex.set(location.shard_index, location);
    }
  }

  const shards: Shard[] = [];
  let fetchedBytes = 0;
  for (let index = 0; index < shardCount; index += 1) {
    throwIfCancelled();
    const location = byIndex.get(index);
    if (!location) {
      const anyStatus = locations.find((l) => l.shard_index === index)?.status ?? "missing";
      throw new ShardUnavailableError(index, anyStatus);
    }
    // Network stage: bytes cross the wire here (LAN node, then Relay fallback).
    emit("fetching", index, fetchedBytes, totalBytes);
    // Mid-shard progress is reported relative to this shard's start, so the
    // running total stays monotonic as chunks arrive. `emit` swallows callback
    // errors, so a misbehaving transport cannot abort the download.
    let packed: Uint8Array;
    try {
      packed = await deps.fetchShard(
        fileId,
        location,
        (received) => {
          emit("fetching", index, fetchedBytes + received, totalBytes);
        },
        signal,
      );
    } catch (err) {
      // A transport that aborted with its own error should still surface as a
      // cancellation, not as a transport failure.
      if (signal?.aborted) throw new DownloadCancelledError();
      throw err;
    }
    fetchedBytes += packed.length;
    // Integrity stage: BLAKE3 compare before the AEAD open.
    emit("verifying", index, fetchedBytes, totalBytes);
    if (location.hash && hashShard(packed) !== location.hash) {
      throw new ShardIntegrityError(index);
    }
    // Decryption stage: AEAD open of this shard under the file key.
    emit("decrypting", index, fetchedBytes, totalBytes);
    const encrypted = unpackEncryptedShard(fileId as FileId, index as ShardIndex, packed);
    shards.push(decryptShard(encrypted, fek));
    emit("fetching", index + 1, fetchedBytes, totalBytes);
  }

  throwIfCancelled();
  emit("assembling", shardCount, fetchedBytes, totalBytes);
  shards.sort((a, b) => a.index - b.index);
  const data = reconstructFromShards(shards);

  if (expectedVersionHash) {
    const hasher = createPlaintextHasher();
    hasher.update(data);
    if (hasher.digest() !== expectedVersionHash) {
      throw new ShardIntegrityError(-1);
    }
  }

  const name = encryptedName ? decryptName(encryptedName, fek) : null;
  emit("done", shardCount, fetchedBytes, totalBytes);

  return { data, name };
}
