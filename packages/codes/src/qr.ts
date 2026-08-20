/**
 * @artboard/codes — QR encoder.
 *
 * A from-scratch, dependency-free byte-mode QR Code encoder covering versions
 * 1-10 at all four error-correction levels. Implemented from the ISO/IEC 18004
 * specification; no library source is vendored here.
 *
 * Everything in this file is pure: same input, same matrix, every time. No
 * Math.random, no Date, no DOM. That determinism is what lets a QR live inside
 * a golden-tested document.
 */

export class CodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeError';
  }
}

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

/* ── tables ─────────────────────────────────────────────────────────────────
 * Per version (1-10) and EC level: the number of EC codewords per block, and
 * the two block groups (count x data-codewords-per-block). Group 2 blocks
 * always hold exactly one more data codeword than group 1 blocks.
 * -------------------------------------------------------------------------- */

interface BlockSpec {
  /** Error-correction codewords per block. */
  ec: number;
  /** Group 1: [block count, data codewords per block]. */
  g1: [number, number];
  /** Group 2: [block count, data codewords per block]. `[0, 0]` when absent. */
  g2: [number, number];
}

const B = (ec: number, c1: number, d1: number, c2 = 0, d2 = 0): BlockSpec => ({
  ec, g1: [c1, d1], g2: [c2, d2],
});

/** Indexed [version - 1][ecLevel]. */
const BLOCKS: ReadonlyArray<Readonly<Record<EcLevel, BlockSpec>>> = [
  /* v1  */ { L: B(7, 1, 19), M: B(10, 1, 16), Q: B(13, 1, 13), H: B(17, 1, 9) },
  /* v2  */ { L: B(10, 1, 34), M: B(16, 1, 28), Q: B(22, 1, 22), H: B(28, 1, 16) },
  /* v3  */ { L: B(15, 1, 55), M: B(26, 1, 44), Q: B(18, 2, 17), H: B(22, 2, 13) },
  /* v4  */ { L: B(20, 1, 80), M: B(18, 2, 32), Q: B(26, 2, 24), H: B(16, 4, 9) },
  /* v5  */ { L: B(26, 1, 108), M: B(24, 2, 43), Q: B(18, 2, 15, 2, 16), H: B(22, 2, 11, 2, 12) },
  /* v6  */ { L: B(18, 2, 68), M: B(16, 4, 27), Q: B(24, 4, 19), H: B(28, 4, 15) },
  /* v7  */ { L: B(20, 2, 78), M: B(18, 4, 31), Q: B(18, 2, 14, 4, 15), H: B(26, 4, 13, 1, 14) },
  /* v8  */ { L: B(24, 2, 97), M: B(22, 2, 38, 2, 39), Q: B(22, 4, 18, 2, 19), H: B(26, 4, 14, 2, 15) },
  /* v9  */ { L: B(30, 2, 116), M: B(22, 3, 36, 2, 37), Q: B(20, 4, 16, 4, 17), H: B(24, 4, 12, 4, 13) },
  /* v10 */ { L: B(18, 2, 68, 2, 69), M: B(26, 4, 43, 1, 44), Q: B(24, 6, 19, 2, 20), H: B(28, 6, 15, 2, 16) },
];

export const MAX_VERSION = BLOCKS.length;

/** Alignment-pattern centre coordinates per version (1-10). v1 has none. */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** Two-bit EC indicator used by the format information. */
const EC_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const spec = (version: number, ec: EcLevel): BlockSpec => {
  const row = BLOCKS[version - 1];
  if (!row) throw new CodeError(`QR version ${version} is out of range (1-${MAX_VERSION}).`);
  return row[ec];
};

/** Total data codewords available at this version + EC level. */
const dataCodewords = (version: number, ec: EcLevel): number => {
  const s = spec(version, ec);
  return s.g1[0] * s.g1[1] + s.g2[0] * s.g2[1];
};

const sizeOf = (version: number): number => version * 4 + 17;

/** Byte-mode character-count indicator width. 8 bits up to v9, 16 from v10. */
const countBits = (version: number): number => (version <= 9 ? 8 : 16);

/* ── GF(256) ────────────────────────────────────────────────────────────────
 * The QR field: primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D),
 * generator alpha = 2. Built once at module load, then only read.
 * -------------------------------------------------------------------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Mirror the table so exponents up to 509 need no modulo at lookup time.
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;

/** Generator polynomial for `degree` EC codewords: product of (x - alpha^i). */
const generatorPoly = (degree: number): Uint8Array => {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    // Multiply by (x + alpha^i).
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
};

/** Reed-Solomon remainder of `data` against the degree-`ecLen` generator. */
const rsEncode = (data: Uint8Array, ecLen: number): Uint8Array => {
  const gen = generatorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
    }
  }
  return rem;
};

/* ── bit buffer ─────────────────────────────────────────────────────────── */

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Zero-pads the tail to a whole number of bytes. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i] === 1) out[i >>> 3]! |= 0x80 >>> (i & 7);
    }
    return out;
  }
}

/* ── text -> codewords ──────────────────────────────────────────────────── */

/**
 * Byte-mode payload, always UTF-8.
 *
 * ISO/IEC 18004 nominates ISO-8859-1 as byte mode's default character set, but
 * every reader in the field treats un-flagged byte mode as UTF-8, and the two
 * agree exactly over ASCII. Emitting Latin-1 for U+0080-U+00FF would encode
 * "Café" in a way most scanners render as mojibake, so UTF-8 it is.
 */
const toBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Smallest version 1-10 whose data capacity holds this payload. */
const chooseVersion = (byteLen: number, ec: EcLevel): number => {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacity = dataCodewords(v, ec) * 8;
    if (4 + countBits(v) + byteLen * 8 <= capacity) return v;
  }
  const limit = Math.floor((dataCodewords(MAX_VERSION, ec) * 8 - 4 - countBits(MAX_VERSION)) / 8);
  throw new CodeError(
    `Text is ${byteLen} bytes, which does not fit a version-${MAX_VERSION} QR at EC level ${ec} ` +
    `(limit ${limit} bytes). Use a shorter text or a lower EC level.`,
  );
};

/** Mode indicator, count, payload, terminator, byte padding, pad codewords. */
const buildDataCodewords = (bytes: Uint8Array, version: number, ec: EcLevel): Uint8Array => {
  const total = dataCodewords(version, ec);
  const capacity = total * 8;
  const buf = new BitBuffer();
  buf.push(0b0100, 4);                       // byte mode
  buf.push(bytes.length, countBits(version));
  for (const b of bytes) buf.push(b, 8);
  buf.push(0, Math.min(4, capacity - buf.length));       // terminator
  buf.push(0, (8 - (buf.length % 8)) % 8);               // to a byte boundary

  const filled = buf.toBytes();
  const out = new Uint8Array(total);
  out.set(filled);
  // Alternating pad codewords fill whatever the payload left over.
  for (let i = filled.length; i < total; i++) out[i] = (i - filled.length) % 2 === 0 ? 0xec : 0x11;
  return out;
};

/** Splits into blocks, adds EC, then interleaves data then EC codewords. */
const interleave = (data: Uint8Array, version: number, ec: EcLevel): Uint8Array => {
  const s = spec(version, ec);
  const groups: Array<{ data: Uint8Array; ec: Uint8Array }> = [];
  let offset = 0;
  for (const [count, size] of [s.g1, s.g2]) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      groups.push({ data: chunk, ec: rsEncode(chunk, s.ec) });
    }
  }

  const out: number[] = [];
  const maxData = Math.max(...groups.map((g) => g.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const g of groups) if (i < g.data.length) out.push(g.data[i]!);
  }
  for (let i = 0; i < s.ec; i++) {
    for (const g of groups) out.push(g.ec[i]!);
  }
  return Uint8Array.from(out);
};

/* ── BCH codes ──────────────────────────────────────────────────────────── */

/**
 * Remainder of `value * x^degree` modulo `poly`, in GF(2). `poly` must be the
 * full generator, i.e. its top set bit sits at position `degree`.
 */
const bchRemainder = (value: number, poly: number, degree: number): number => {
  let rem = value;
  for (let i = 0; i < degree; i++) rem = (rem << 1) ^ ((rem >>> (degree - 1)) * poly);
  return rem;
};

/** 15-bit format information: 5 data bits, BCH(15,5), XOR 0x5412. */
const formatBits = (ec: EcLevel, mask: number): number => {
  const data = (EC_BITS[ec] << 3) | mask;
  return ((data << 10) | bchRemainder(data, 0b101_0011_0111, 10)) ^ 0x5412;
};

/** 18-bit version information: 6 data bits, BCH(18,6). Versions 7+ only. */
const versionBits = (version: number): number =>
  (version << 12) | bchRemainder(version, 0b1_1111_0010_0101, 12);

/* ── matrix construction ────────────────────────────────────────────────── */

type Grid = Uint8Array[];

const makeGrid = (size: number): Grid =>
  Array.from({ length: size }, () => new Uint8Array(size));

const setFinder = (m: Grid, fn: Grid, row: number, col: number): void => {
  // 7x7 finder plus its one-module separator: paint the whole 9x9 footprint.
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const y = row + dy;
      const x = col + dx;
      if (y < 0 || x < 0 || y >= m.length || x >= m.length) continue;
      const ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
      m[y]![x] = ring === 2 || ring > 3 ? 0 : 1;
      fn[y]![x] = 1;
    }
  }
};

const drawFunctionPatterns = (m: Grid, fn: Grid, version: number, ec: EcLevel): void => {
  const size = m.length;

  // Timing patterns run the full width/height; finders overwrite their ends.
  for (let i = 0; i < size; i++) {
    m[6]![i] = i % 2 === 0 ? 1 : 0;
    m[i]![6] = i % 2 === 0 ? 1 : 0;
    fn[6]![i] = 1;
    fn[i]![6] = 1;
  }

  setFinder(m, fn, 0, 0);
  setFinder(m, fn, 0, size - 7);
  setFinder(m, fn, size - 7, 0);

  // Alignment patterns sit at every centre pair except the three that would
  // collide with a finder.
  const centres = ALIGNMENT[version - 1]!;
  for (const cy of centres) {
    for (const cx of centres) {
      const nearFinder =
        (cy === 6 && cx === 6) ||
        (cy === 6 && cx === size - 7) ||
        (cy === size - 7 && cx === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dy), Math.abs(dx));
          m[cy + dy]![cx + dx] = ring === 1 ? 0 : 1;
          fn[cy + dy]![cx + dx] = 1;
        }
      }
    }
  }

  // Reserve the format areas so the codeword walk skips them. Mask 0 is a
  // placeholder; drawFormat rewrites both copies once the mask is chosen.
  drawFormat(m, fn, ec, 0);

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m[b]![a] = bit;
      m[a]![b] = bit;
      fn[b]![a] = 1;
      fn[a]![b] = 1;
    }
  }
};

const drawFormat = (m: Grid, fn: Grid, ec: EcLevel, mask: number): void => {
  const size = m.length;
  const bits = formatBits(ec, mask);
  const bit = (i: number): number => (bits >>> i) & 1;
  const put = (row: number, col: number, v: number): void => {
    m[row]![col] = v;
    fn[row]![col] = 1;
  };

  // Copy 1 — wrapped around the top-left finder.
  for (let i = 0; i <= 5; i++) put(i, 8, bit(i));
  put(7, 8, bit(6));
  put(8, 8, bit(7));
  put(8, 7, bit(8));
  for (let i = 9; i < 15; i++) put(8, 14 - i, bit(i));

  // Copy 2 — split between the bottom-left and top-right finders.
  for (let i = 0; i < 8; i++) put(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) put(size - 15 + i, 8, bit(i));
  put(size - 8, 8, 1); // the dark module, always set
};

/** Two-column zigzag from the bottom-right, skipping the vertical timing column. */
const drawCodewords = (m: Grid, fn: Grid, codewords: Uint8Array): void => {
  const size = m.length;
  let bit = 0;
  const totalBits = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y]![x] || bit >= totalBits) continue;
        m[y]![x] = (codewords[bit >>> 3]! >>> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
  }
};

const MASKS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const applyMask = (m: Grid, fn: Grid, mask: number): void => {
  const rule = MASKS[mask]!;
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (!fn[r]![c] && rule(r, c)) m[r]![c] = m[r]![c]! ^ 1;
    }
  }
};

/** The finder-like sequences that penalty rule 3 hunts for, in both polarities. */
const RULE3_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const RULE3_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

const penalty = (m: Grid): number => {
  const size = m.length;
  let score = 0;

  // Rules 1 and 3, scanned along both axes.
  for (let axis = 0; axis < 2; axis++) {
    const at = (a: number, b: number): number => (axis === 0 ? m[a]![b]! : m[b]![a]!);
    for (let a = 0; a < size; a++) {
      let runColor = at(a, 0);
      let runLength = 1;
      for (let b = 1; b < size; b++) {
        const v = at(a, b);
        if (v === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) score += 3 + (runLength - 5);
          runColor = v;
          runLength = 1;
        }
      }
      if (runLength >= 5) score += 3 + (runLength - 5);

      for (let b = 0; b + 11 <= size; b++) {
        let matchA = true;
        let matchB = true;
        for (let k = 0; k < 11; k++) {
          const v = at(a, b + k);
          if (v !== RULE3_A[k]) matchA = false;
          if (v !== RULE3_B[k]) matchB = false;
        }
        if (matchA) score += 40;
        if (matchB) score += 40;
      }
    }
  }

  // Rule 2 — every 2x2 block of one colour.
  for (let r = 0; r + 1 < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      const v = m[r]![c]!;
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }

  // Rule 4 — deviation of the dark-module share from 50%.
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
};

/* ── public API ─────────────────────────────────────────────────────────── */

/**
 * Encodes `text` as a byte-mode QR Code and returns the finished module
 * matrix, row-major, `true` for a dark module. The smallest version 1-10 that
 * fits is chosen automatically, and the lowest-penalty of the eight data masks
 * is applied.
 *
 * @throws {CodeError} when the payload does not fit version 10 at this level.
 */
export function qrMatrix(text: string, ec: EcLevel = 'M'): boolean[][] {
  if (!EC_BITS.hasOwnProperty(ec)) {
    throw new CodeError(`Unknown QR error-correction level "${ec}". Use L, M, Q or H.`);
  }
  const bytes = toBytes(text);
  const version = chooseVersion(bytes.length, ec);
  const codewords = interleave(buildDataCodewords(bytes, version, ec), version, ec);

  const size = sizeOf(version);
  const base = makeGrid(size);
  const fn = makeGrid(size);
  drawFunctionPatterns(base, fn, version, ec);
  drawCodewords(base, fn, codewords);

  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row) => Uint8Array.from(row));
    applyMask(candidate, fn, mask);
    drawFormat(candidate, fn, ec, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best!.map((row) => Array.from(row, (v) => v === 1));
}
