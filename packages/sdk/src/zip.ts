// Minimal dependency-free ZIP writer (STORE method, no compression).
//
// No platform here ships a standard "create a ZIP" API — `CompressionStream`
// only produces a raw gzip/deflate stream, not the ZIP container with its
// central directory — and the project carries no zip dependency. A STORE-only
// writer is small and correct, and the loss is minor: the dominant use is
// bundling a folder of already-encrypted Nodus files, whose bytes are
// high-entropy and would not compress meaningfully anyway.

/** Standard CRC-32 (IEEE 802.3) lookup table, built once at module load. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time/date (the ZIP legacy timestamp format). */
function dosTimestamp(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const packedDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, date: packedDate };
}

/** Accumulates little-endian fields and byte chunks, tracking total length. */
class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  u16(value: number): void {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    this.push(bytes);
  }

  u32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    this.push(bytes);
  }

  bytes(chunk: Uint8Array): void {
    this.push(chunk);
  }

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  concat(): Uint8Array {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

export interface ZipEntry {
  /** Archive-relative path, forward slashes (e.g. "photos/a.jpg"). */
  path: string;
  data: Uint8Array;
}

/**
 * Keep only safe path segments: drop empty, "." and ".." entries (so an entry
 * can never escape the archive root) and normalize separators to forward slash.
 */
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
}

/**
 * Build a valid ZIP archive from `entries`. Empty input yields an empty archive
 * (a valid central-directory-only zip), not an error.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosTimestamp(new Date());
  const writer = new ByteWriter();
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const entry of entries) {
    const name = encoder.encode(normalizePath(entry.path));
    const crc = crc32(entry.data);
    const offset = writer.length;
    // Local file header.
    writer.u32(0x04034b50);
    writer.u16(20); // version needed to extract
    writer.u16(0x0800); // general purpose flag: filename is UTF-8
    writer.u16(0); // compression: store
    writer.u16(time);
    writer.u16(date);
    writer.u32(crc);
    writer.u32(entry.data.length);
    writer.u32(entry.data.length);
    writer.u16(name.length);
    writer.u16(0); // extra field length
    writer.bytes(name);
    writer.bytes(entry.data);
    central.push({ name, crc, size: entry.data.length, offset });
  }

  const centralStart = writer.length;
  for (const entry of central) {
    // Central directory file header.
    writer.u32(0x02014b50);
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(time);
    writer.u16(date);
    writer.u32(entry.crc);
    writer.u32(entry.size);
    writer.u32(entry.size);
    writer.u16(entry.name.length);
    writer.u16(0); // extra field
    writer.u16(0); // comment
    writer.u16(0); // disk number
    writer.u16(0); // internal attributes
    writer.u32(0); // external attributes
    writer.u32(entry.offset);
    writer.bytes(entry.name);
  }

  const centralSize = writer.length - centralStart;
  // End of central directory record.
  writer.u32(0x06054b50);
  writer.u16(0); // this disk
  writer.u16(0); // disk with central directory
  writer.u16(central.length);
  writer.u16(central.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // comment length

  return writer.concat();
}
