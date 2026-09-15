// Browser binding for the shared @repo/sdk uploader.
//
// The sharding/encryption/resume logic lives in the SDK; this file only adapts
// a browser `File` to the SDK's random-access `UploadSource`. Existing callers
// (use-uploader, files-client, tests) keep the `file`-based API.

import {
  measurePlaintext as sdkMeasurePlaintext,
  uploadFile as sdkUploadFile,
} from "@repo/sdk";
import type {
  FileMeasurement,
  UploadProgressEvent,
  UploadResult,
  UploadSource,
} from "@repo/sdk";
import type { UploadFileOptions as SdkUploadFileOptions } from "@repo/sdk";

export type {
  UploadDeps,
  FileMeasurement,
  UploadProgressEvent,
  UploadPhase,
  UploadResult,
} from "@repo/sdk";
export { DEFAULT_SHARD_CONCURRENCY } from "@repo/sdk";

/** Adapt a browser File to the SDK's platform-neutral random-access source. */
function fileSource(file: File): UploadSource {
  return {
    name: file.name,
    size: file.size,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

export interface UploadFileOptions extends Omit<SdkUploadFileOptions, "source"> {
  file: File;
}

/** Hash the plaintext and count shards in one sequential read over a File. */
export function measurePlaintext(
  file: File,
  onProgress?: (event: UploadProgressEvent) => void,
  shardSize?: number,
): Promise<FileMeasurement> {
  return sdkMeasurePlaintext(fileSource(file), onProgress, shardSize);
}

/** Upload one file (Path C), resuming from persisted progress when possible. */
export function uploadFile(options: UploadFileOptions): Promise<UploadResult> {
  const { file, ...rest } = options;
  return sdkUploadFile({ ...rest, source: fileSource(file) });
}
