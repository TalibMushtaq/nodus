// Path C: post one encrypted shard to the Relay buffer.
//
// Native talks to the Relay origin directly (the SDK adapter attaches the
// bearer session); the shard bytes are the request body and the metadata rides
// X-Nodus-* headers, matching the Relay's buffer_upload handler. RN's fetch has
// no upload-progress event, so this path reports no byte progress.

import type { BufferedShardUpload } from "@repo/sdk";

import { createNativeRelayHttp } from "../adapters";

const http = createNativeRelayHttp();

export interface ShardUploadResult {
  buffer_id: string;
  status: string;
}

export async function postShard(dto: BufferedShardUpload): Promise<ShardUploadResult> {
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
  if (dto.sourceDevice) headers["x-nodus-source-device"] = dto.sourceDevice;

  const res = await http.request<ShardUploadResult>("/buffer/upload", {
    method: "POST",
    raw: dto.data,
    headers,
  });
  if (!res.ok) {
    throw new Error(res.error ?? `shard upload failed: ${res.status}`);
  }
  return res.json as ShardUploadResult;
}
