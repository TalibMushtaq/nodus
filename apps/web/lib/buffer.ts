// Client for the Relay's Path C shard buffer. The browser posts each encrypted
// shard to the Next proxy (`/api/buffer/upload`), which attaches the session
// cookie server-side; `baseUrl` is injectable so the Node e2e harness can call
// an absolute origin instead of a relative URL (Node fetch requires one).

export interface ShardUpload {
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  /** BLAKE3 hex of the ciphertext body (not plaintext). */
  hash: string;
  size: number;
  targetNode: string;
  transferId: string;
  sourceDevice?: string;
  data: Uint8Array;
}

export interface ShardUploadResult {
  buffer_id: string;
  status: string;
}

/**
 * POST one encrypted shard. A 201 means the Relay has it as RELAY_BUFFERED;
 * the node may not have fetched it yet, so callers must not treat this as
 * durable storage.
 */
export async function postShard(dto: ShardUpload, baseUrl = ""): Promise<ShardUploadResult> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-nodus-file-id": dto.fileId,
    "x-nodus-version-number": String(dto.versionNumber),
    "x-nodus-shard-index": String(dto.shardIndex),
    "x-nodus-hash": dto.hash,
    "x-nodus-size": String(dto.size),
    "x-nodus-target-node": dto.targetNode,
    "x-nodus-transfer-id": dto.transferId,
  };
  if (dto.sourceDevice) {
    headers["x-nodus-source-device"] = dto.sourceDevice;
  }

  const res = await fetch(`${baseUrl}/api/buffer/upload`, {
    method: "POST",
    headers,
    // BufferSource is valid at runtime; the cast bridges the ArrayBufferLike
    // variance gap between lib.es and lib.dom typed-array definitions.
    body: dto.data as unknown as BodyInit,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `shard upload failed: ${res.status}`);
  }
  return (await res.json()) as ShardUploadResult;
}
