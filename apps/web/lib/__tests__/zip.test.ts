import { describe, expect, it } from "vitest";

import { createZip } from "../zip";

/** Read a little-endian field out of the archive for structural assertions. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("createZip", () => {
  it("writes a local header, CRC, and end-of-central-directory record", () => {
    const data = new TextEncoder().encode("123456789");
    const zip = createZip([{ path: "dir/a.txt", data }]);
    const view = viewOf(zip);

    expect(view.getUint32(0, true)).toBe(0x04034b50); // local file header
    // CRC-32 of the ASCII string "123456789" is the standard 0xCBF43926.
    expect(view.getUint32(14, true)).toBe(0xcbf43926);
    // End of central directory, 22 bytes from the end (no comment).
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(1); // entry count
  });

  it("produces a valid empty archive for no entries", () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(viewOf(zip).getUint32(0, true)).toBe(0x06054b50);
    expect(viewOf(zip).getUint16(10, true)).toBe(0);
  });

  it("normalizes traversal and backslash path segments", () => {
    const zip = createZip([{ path: "..\\..\\secret.txt", data: new Uint8Array(1) }]);
    const view = viewOf(zip);
    const nameLength = view.getUint16(26, true);
    const name = new TextDecoder().decode(zip.subarray(30, 30 + nameLength));
    expect(name).toBe("secret.txt");
  });
});
