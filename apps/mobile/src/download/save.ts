// Persist decrypted bytes to the app cache and hand them to the OS share sheet.
//
// expo-file-system's legacy API writes a base64 string, so the bytes are
// encoded in bounded chunks (a single String.fromCharCode spread over a multi-MB
// array would overflow the call stack). Sharing lets the user save to Files,
// send to another app, etc. — the native equivalent of a browser download.

import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  // `btoa` is provided by src/compat.ts on Hermes.
  return btoa(bin);
}

/** Write `data` to the cache dir as `name` and open the share sheet. */
export async function saveAndShare(data: Uint8Array, name: string): Promise<string> {
  const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!dir) throw new Error("no writable directory available");
  const uri = `${dir}${name.replace(/[/\\]/g, "_")}`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(data), { encoding: "base64" });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
  return uri;
}
