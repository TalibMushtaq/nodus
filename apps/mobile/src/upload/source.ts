// Platform byte source for the SDK uploader.
//
// expo-document-picker gives a file URI plus name/size; the SDK's `UploadSource`
// needs random-access reads, which expo-file-system's legacy base64 read with a
// byte position/length provides (the new File API exposes a stream/slice but no
// convenient byte-range read). One shard-sized read is held at a time.

import * as FileSystem from "expo-file-system/legacy";
import type { UploadSource } from "@repo/sdk";

function base64ToBytes(value: string): Uint8Array {
  // `atob` is provided by src/compat.ts on Hermes.
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build an UploadSource from a picked file's URI. */
export function fileUriSource(uri: string, name: string, size: number): UploadSource {
  return {
    name,
    size,
    read: async (offset, length) => {
      if (length <= 0) return new Uint8Array(0);
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: "base64",
        position: offset,
        length,
      });
      return base64ToBytes(b64);
    },
  };
}
