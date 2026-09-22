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

import type { DownloadLimiter } from "./adaptive/pool.js";

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
 * instead of showing an opaque bar. `connecting` spans the first shard's route
 * negotiation, before any byte has been reported.
 */
export type DownloadPhase =
  | "unlocking"
  | "connecting"
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
  /**
   * In-flight shard allowance when an adaptive {@link DownloadFileOptions.limiter}
   * is in use; absent on the serial path. Display only.
   */
  concurrency?: number;
  /** Smoothed goodput in bytes/second, when a limiter is in use. Display only. */
  throughputBps?: number;
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
   * Shared adaptive download pool. When present (and the version has more than
   * two shards) shards are fetched concurrently and the pool's limit is tuned
   * from measured goodput; when omitted the download stays serial. One limiter
   * must be shared by all of a client's downloads so their combined in-flight
   * shards respect a single budget.
   */
  limiter?: DownloadLimiter;
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
  const {
    fileId,
    versionNumber,
    shardCount,
    encryptedName,
    expectedVersionHash,
    deps,
    limiter,
    onProgress,
    signal,
  } = options;

  // Progress is advisory: a throwing subscriber must not abort a download.
  const emit = (
    phase: DownloadPhase,
    completedShards: number,
    completedBytes: number,
    totalBytes: number,
  ) => {
    try {
      onProgress?.({
        phase,
        completedShards,
        totalShards: shardCount,
        completedBytes,
        totalBytes,
        ...(limiter
          ? { concurrency: limiter.limit, throughputBps: limiter.bytesPerSecond }
          : {}),
      });
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
  // Network bytes fully fetched. Shared by the serial and adaptive paths so the
  // later "assembling" event reports the same total either way.
  let fetchedBytes = 0;

  if (limiter && shardCount > 2) {
    // Adaptive path. Workers claim shard indices and hold a global permit only
    // while bytes cross the wire — released before verify/decrypt, which are
    // CPU-bound and must not occupy a network slot. The limiter resizes the
    // allowance from measured goodput, so a fast LAN ramps while a Relay
    // pull-through plateaus. Shard order is restored by the sort below.
    const pending: number[] = [];
    for (let index = 0; index < shardCount; index += 1) pending.push(index);
    let cursor = 0;
    let firstFetch = true;
    let completedShards = 0;
    let abortError: unknown = null;
    // Per-shard bytes received so far, so mid-shard progress stays monotonic
    // even though several shards are in flight (mirrors the uploader's report).
    const inflight = new Map<number, number>();
    const completedBytes = () =>
      fetchedBytes + [...inflight.values()].reduce((sum, n) => sum + n, 0);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (abortError !== null) return;
        if (signal?.aborted) {
          abortError = new DownloadCancelledError();
          return;
        }
        const index = pending[cursor];
        if (index === undefined) return;
        cursor += 1;

        const location = byIndex.get(index);
        if (!location) {
          const anyStatus = locations.find((l) => l.shard_index === index)?.status ?? "missing";
          if (abortError === null) abortError = new ShardUnavailableError(index, anyStatus);
          return;
        }

        let release: () => void;
        try {
          release = await limiter.acquire(signal);
        } catch (err) {
          // Abort while queued, or a limiter failure: surface as cancellation
          // when the caller aborted, otherwise the first real error.
          if (signal?.aborted) abortError = new DownloadCancelledError();
          else if (abortError === null) abortError = err;
          return;
        }
        // A sibling worker may have failed while this one waited for a slot.
        if (abortError !== null) {
          release();
          return;
        }

        inflight.set(index, 0);
        emit(firstFetch ? "connecting" : "fetching", completedShards, completedBytes(), totalBytes);
        firstFetch = false;

        let packed: Uint8Array;
        try {
          packed = await deps.fetchShard(
            fileId,
            location,
            (received) => {
              inflight.set(index, received);
              emit("fetching", completedShards, completedBytes(), totalBytes);
            },
            signal,
          );
        } catch (err) {
          inflight.delete(index);
          release();
          limiter.recordError();
          if (signal?.aborted) {
            if (abortError === null) abortError = new DownloadCancelledError();
          } else if (abortError === null) {
            abortError = err;
          }
          return;
        }
        // The permit covers only the network fetch; verify/decrypt proceed
        // without holding a slot, so CPU work never starves the link.
        release();
        inflight.delete(index);
        fetchedBytes += packed.length;
        limiter.recordBytes(packed.length);
        limiter.recordShardComplete();

        // Integrity stage: BLAKE3 compare before the AEAD open.
        emit("verifying", completedShards, completedBytes(), totalBytes);
        if (location.hash && hashShard(packed) !== location.hash) {
          limiter.recordError();
          if (abortError === null) abortError = new ShardIntegrityError(index);
          return;
        }
        // Decryption stage: AEAD open of this shard under the file key.
        emit("decrypting", completedShards, completedBytes(), totalBytes);
        const encrypted = unpackEncryptedShard(fileId as FileId, index as ShardIndex, packed);
        shards.push(decryptShard(encrypted, fek));
        completedShards += 1;
        emit("fetching", completedShards, completedBytes(), totalBytes);
      }
    };

    // Spawn the pool's ceiling of worker loops and let `acquire` gate how many
    // run at once; the controller can then raise concurrency mid-download
    // without more loops being created.
    const workerCount = Math.max(1, Math.min(limiter.max, pending.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (abortError !== null) {
      if (signal?.aborted) throw new DownloadCancelledError();
      throw abortError;
    }
  } else {
    for (let index = 0; index < shardCount; index += 1) {
      throwIfCancelled();
      const location = byIndex.get(index);
      if (!location) {
        const anyStatus = locations.find((l) => l.shard_index === index)?.status ?? "missing";
        throw new ShardUnavailableError(index, anyStatus);
      }
      // Network stage: bytes cross the wire here (LAN node, then Relay fallback).
      // The first shard also covers path selection: the transport may negotiate
      // WebRTC (offer/ICE/DTLS) or wait for a Relay pull-through before any byte
      // arrives. Label that wait "connecting" so the UI does not sit on a frozen
      // "Downloading 0 B"; the first streamed chunk flips it to "fetching" via the
      // onProgress callback below, and a non-streaming transport flips it when the
      // shard resolves.
      emit(index === 0 ? "connecting" : "fetching", index, fetchedBytes, totalBytes);
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
