/**
 * Reduce an arbitrary (decrypted, remote-controlled) filename to a safe leaf.
 *
 * Kept free of native imports so it can be unit-tested without the
 * expo-file-system/expo-sharing modules that `save.ts` pulls in.
 */
export function safeFileName(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? "";
  const cleaned = leaf
    // `..` segments and NUL/control bytes cannot form a safe leaf.
    .replace(/\.\./g, "_")
    .replace(/[\u0000-\u001f:*?"<>|]/g, "_")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : "download.bin";
}
