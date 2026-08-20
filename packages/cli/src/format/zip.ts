/**
 * A ZIP writer, STORE only.
 *
 * Why hand-rolled: the only thing multi-file export needs from a zip is a
 * container. PNG, JPG and PDF are already compressed, so DEFLATE would buy
 * single-digit percent on a design bundle and cost a runtime dependency in a
 * project that has none. STORE (method 0) is ~80 lines and every unzip
 * implementation on earth reads it.
 *
 * Reproducible on purpose: entries carry a fixed DOS timestamp, so the same
 * files always produce the same bytes. That is what lets the CLI and the
 * editor be diffed against each other.
 */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes; no leading slash, no `..`. */
  name: string;
  data: Uint8Array;
}

/** 1980-01-01 00:00:00, the earliest instant the DOS date field can express. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array): void { this.parts.push(b); this.length += b.length; }
  u16(n: number): void { this.bytes(new Uint8Array([n & 0xff, (n >>> 8) & 0xff])); }
  u32(n: number): void {
    this.bytes(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Build a STORE-only zip.
 *
 * Throws rather than silently truncating when an entry cannot be addressed by
 * the classic (non-Zip64) headers: a >4 GB member would write a wrong size
 * field and produce an archive that only fails when someone opens it.
 */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error('A zip needs at least one entry.');
  if (entries.length > 0xffff) throw new Error(`Too many files for one zip (${entries.length}).`);

  const body = new ByteWriter();
  const dir = new ByteWriter();

  for (const entry of entries) {
    const name = utf8(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    if (size > 0xffffffff) throw new Error(`"${entry.name}" is too large for a classic zip.`);
    const offset = body.length;
    if (offset > 0xffffffff) throw new Error('Archive is too large for a classic zip.');

    // Local file header, then the bytes. Flag bit 11 says the name is UTF-8;
    // version 20 is the floor for a stored entry with this header layout.
    body.u32(0x04034b50);
    body.u16(20);                 // version needed to extract
    body.u16(0x0800);             // general purpose flags
    body.u16(0);                  // method 0 = stored
    body.u16(DOS_TIME);
    body.u16(DOS_DATE);
    body.u32(crc);
    body.u32(size);               // compressed size == uncompressed size
    body.u32(size);
    body.u16(name.length);
    body.u16(0);                  // extra field length
    body.bytes(name);
    body.bytes(entry.data);

    // Central directory entry: the same record plus where the local one is.
    dir.u32(0x02014b50);
    dir.u16(20);                  // version made by
    dir.u16(20);                  // version needed to extract
    dir.u16(0x0800);
    dir.u16(0);
    dir.u16(DOS_TIME);
    dir.u16(DOS_DATE);
    dir.u32(crc);
    dir.u32(size);
    dir.u32(size);
    dir.u16(name.length);
    dir.u16(0);                   // extra field length
    dir.u16(0);                   // file comment length
    dir.u16(0);                   // disk number start
    dir.u16(0);                   // internal attributes
    dir.u32(0);                   // external attributes
    dir.u32(offset);
    dir.bytes(name);
  }

  const out = new ByteWriter();
  const central = dir.finish();
  out.bytes(body.finish());
  const centralOffset = out.length;
  out.bytes(central);

  out.u32(0x06054b50);      // end of central directory
  out.u16(0); out.u16(0);   // this disk / disk with the directory
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(central.length);
  out.u32(centralOffset);
  out.u16(0);               // comment length
  return out.finish();
}
