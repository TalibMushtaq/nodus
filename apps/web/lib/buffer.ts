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
  /**
   * Byte-level progress for the request body. Only the Relay path can report
   * this; Path D (deferred queue) ignores it.
   */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
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

  // XHR rather than fetch: only XHR exposes `upload.onprogress` portably, which
  // is what gives byte-level progress. The Node e2e harness has no
  // XMLHttpRequest and uses the fetch path without progress.
  if (typeof XMLHttpRequest === "undefined") {
    return postShardFetch(baseUrl, headers, dto);
  }

  return new Promise<ShardUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseUrl}/api/buffer/upload`);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) dto.onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as ShardUploadResult);
      } else {
        const body = xhr.response as { error?: string } | null;
        reject(new Error(body?.error ?? `shard upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("shard upload failed: network error"));
    xhr.send(dto.data as unknown as ArrayBufferView<ArrayBuffer>);
  });
}

async function postShardFetch(
  baseUrl: string,
  headers: Record<string, string>,
  dto: ShardUpload,
): Promise<ShardUploadResult> {
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
