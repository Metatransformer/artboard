/**
 * A vector PDF writer for Artboard scenes.
 *
 * It consumes the SAME `SceneNode` tree the SVG renderer emits, so a PDF page
 * and an SVG page are the same drawing, not two drawings that have to be kept
 * in step. Nothing here is browser- or Node-specific: the only platform calls
 * are `CompressionStream`/`DecompressionStream`, which both hosts ship, so the
 * editor and the CLI produce identical bytes for identical input.
 *
 * WHAT IT DRAWS
 *   rects (incl. rounded), ellipses, circles, lines, arbitrary paths, images
 *   (JPEG passthrough / PNG decode), text (incl. text on a path), linear and
 *   radial gradients, clip paths, per-element and group opacity, blend modes,
 *   dashes, and drop shadows.
 *
 * WHAT IT APPROXIMATES, and why
 *   - Glyphs come from the PDF base-14 faces (Helvetica / Times / Courier).
 *     Artboard ships font *metrics*, not font *binaries*, so there is nothing
 *     to embed. Each word is placed at the x the design's own metrics give it
 *     and then fitted to that width, so lines break and align exactly where the
 *     SVG puts them; only the letter shapes are substitutes. See `drawLine`.
 *     Text stays real, selectable text.
 *   - SVG filters other than a drop shadow (blur, glow, neon, colour matrices)
 *     have no PDF equivalent and are dropped; the element is drawn unfiltered.
 *     `notes` says so, loudly, when it happens.
 *   - Group opacity is applied per-element rather than to the flattened group.
 */

import type { SceneNode } from '@artboard/render-svg';
import { FONT_METRICS, resolveFont } from '@artboard/engine';

/** CSS pixels are 1/96", PDF units are 1/72". A 1000 px artboard is 10.42" wide. */
export const PT_PER_PX = 72 / 96;

export interface PdfPage {
  scene: SceneNode;
  /** Artboard size in px. The page is this, converted to points and scaled. */
  width: number;
  height: number;
  title?: string;
}

export interface PdfOptions {
  /** Multiplies the physical page size. 1 = the artboard at 96 dpi. */
  scale?: number;
  title?: string;
}

export interface PdfResult {
  bytes: Uint8Array;
  /** Human-readable fidelity warnings, de-duplicated, in the order they arose. */
  notes: string[];
}

/* ── bytes ──────────────────────────────────────────────────────────────── */

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function through(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

/** zlib-wrapped deflate — what PDF's /FlateDecode expects. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // The cast is the TS 5.7 generic-TypedArray tax: a Uint8Array over a plain
  // ArrayBuffer is a BufferSource, but the unparameterised type is not.
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  return through(cs.readable);
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  return through(ds.readable);
}

/* ── numbers, strings ───────────────────────────────────────────────────── */

/** Fixed notation, 4 dp, never exponential — PDF has no `1e-7`. */
function f(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

const pdfString = (s: string): string =>
  '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]/g, ' ') + ')';

/* ── colour ─────────────────────────────────────────────────────────────── */

export interface Rgba { r: number; g: number; b: number; a: number }

const NAMED: Record<string, string> = { black: '#000000', white: '#ffffff', none: '' };

export function parseColor(input: string | number | undefined): Rgba | null {
  if (input === undefined) return null;
  const s = String(input).trim();
  if (s === '' || s === 'none' || s === 'transparent') return null;
  const hex = s.startsWith('#') ? s.slice(1) : (NAMED[s.toLowerCase()] ?? '').slice(1);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const wide = hex.length === 3 || hex.length === 4 ? hex.split('').map(c => c + c).join('') : hex;
  if (wide.length !== 6 && wide.length !== 8) return null;
  const byte = (i: number): number => parseInt(wide.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: wide.length === 8 ? byte(6) : 1 };
}

const fillOp = (c: Rgba): string => `${f(c.r)} ${f(c.g)} ${f(c.b)} rg`;
const strokeOp = (c: Rgba): string => `${f(c.r)} ${f(c.g)} ${f(c.b)} RG`;

/* ── matrices ───────────────────────────────────────────────────────────── */

export type Mat = readonly [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `a` applied first, then `b`. Row-vector convention, as PDF and SVG both use. */
function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const matOp = (m: Mat): string => `${f(m[0])} ${f(m[1])} ${f(m[2])} ${f(m[3])} ${f(m[4])} ${f(m[5])} cm`;

/** SVG `transform` list → one matrix. Unknown functions are skipped, not guessed. */
export function parseTransform(input: string | number | undefined): Mat {
  if (input === undefined) return IDENTITY;
  let m = IDENTITY;
  for (const [, name, argText] of String(input).matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const a = (argText ?? '').trim().split(/[\s,]+/).filter(s => s !== '').map(Number);
    const at = (i: number, fallback = 0): number => (Number.isFinite(a[i]) ? (a[i] as number) : fallback);
    switch (name) {
      case 'translate': m = mul([1, 0, 0, 1, at(0), at(1)], m); break;
      case 'scale': m = mul([at(0, 1), 0, 0, a.length > 1 ? at(1, 1) : at(0, 1), 0, 0], m); break;
      case 'matrix': m = mul([at(0, 1), at(1), at(2), at(3, 1), at(4), at(5)], m); break;
      case 'rotate': {
        const rad = (at(0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rot: Mat = [cos, sin, -sin, cos, 0, 0];
        if (a.length >= 3) {
          const cx = at(1), cy = at(2);
          m = mul(mul(mul([1, 0, 0, 1, -cx, -cy], rot), [1, 0, 0, 1, cx, cy]), m);
        } else m = mul(rot, m);
        break;
      }
      default: break;
    }
  }
  return m;
}

/* ── path geometry ──────────────────────────────────────────────────────── */

type Seg =
  | { op: 'm'; x: number; y: number }
  | { op: 'l'; x: number; y: number }
  | { op: 'c'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'h' };

const KAPPA = 0.5522847498307936;

/** Full SVG 1.1 path grammar. Arcs and quadratics are converted to cubics. */
export function parsePath(d: string): Seg[] {
  const out: Seg[] = [];
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return out;

  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  let prevCubic: [number, number] | null = null;
  let prevQuad: [number, number] | null = null;
  let cmd = '';

  const num = (): number => Number(tokens[i++] ?? 0);
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    out.push({ op: 'c', x1, y1, x2, y2, x, y });
    prevCubic = [x2, y2]; prevQuad = null; cx = x; cy = y;
  };
  const quad = (qx: number, qy: number, x: number, y: number): void => {
    const x1 = cx + (2 / 3) * (qx - cx), y1 = cy + (2 / 3) * (qy - cy);
    const x2 = x + (2 / 3) * (qx - x), y2 = y + (2 / 3) * (qy - y);
    out.push({ op: 'c', x1, y1, x2, y2, x, y });
    prevQuad = [qx, qy]; prevCubic = null; cx = x; cy = y;
  };

  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/^[A-Za-z]$/.test(token)) { cmd = token; i++; }
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    if (cmd === '') break;

    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case 'M': { const x = num() + ox, y = num() + oy; out.push({ op: 'm', x, y }); cx = x; cy = y; sx = x; sy = y; prevCubic = prevQuad = null; break; }
      case 'L': { const x = num() + ox, y = num() + oy; out.push({ op: 'l', x, y }); cx = x; cy = y; prevCubic = prevQuad = null; break; }
      case 'H': { const x = num() + ox; out.push({ op: 'l', x, y: cy }); cx = x; prevCubic = prevQuad = null; break; }
      case 'V': { const y = num() + oy; out.push({ op: 'l', x: cx, y }); cy = y; prevCubic = prevQuad = null; break; }
      case 'C': { const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy; cubic(x1, y1, x2, y2, x, y); break; }
      case 'S': {
        const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
        const x1 = prevCubic ? 2 * cx - prevCubic[0] : cx, y1 = prevCubic ? 2 * cy - prevCubic[1] : cy;
        cubic(x1, y1, x2, y2, x, y); break;
      }
      case 'Q': { const qx = num() + ox, qy = num() + oy, x = num() + ox, y = num() + oy; quad(qx, qy, x, y); break; }
      case 'T': {
        const x = num() + ox, y = num() + oy;
        const qx = prevQuad ? 2 * cx - prevQuad[0] : cx, qy = prevQuad ? 2 * cy - prevQuad[1] : cy;
        quad(qx, qy, x, y); break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), x = num() + ox, y = num() + oy;
        arcToCubics(cx, cy, rx, ry, rot, large !== 0, sweep !== 0, x, y, out);
        cx = x; cy = y; prevCubic = prevQuad = null; break;
      }
      case 'Z': { out.push({ op: 'h' }); cx = sx; cy = sy; prevCubic = prevQuad = null; break; }
      default: i++; break;
    }
  }
  return out;
}

/** Endpoint-parameterised arc → up to four cubic segments (F.6.5 in the spec). */
function arcToCubics(
  x0: number, y0: number, rx: number, ry: number, rotDeg: number,
  large: boolean, sweep: boolean, x1: number, y1: number, out: Seg[],
): void {
  if (rx === 0 || ry === 0) { out.push({ op: 'l', x: x1, y: y1 }); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = Math.sqrt(Math.max(0, (rx * rx * ry * ry - denom) / denom)) * (large === sweep ? -1 : 1);
  const cxp = (factor * rx * y1p) / ry, cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / steps;
  const alpha = (4 / 3) * Math.tan(step / 4);

  let t = theta;
  let px = x0, py = y0;
  for (let k = 0; k < steps; k++) {
    const t2 = t + step;
    const cosT = Math.cos(t), sinT = Math.sin(t), cosT2 = Math.cos(t2), sinT2 = Math.sin(t2);
    const ex = cx + rx * cos * cosT2 - ry * sin * sinT2;
    const ey = cy + rx * sin * cosT2 + ry * cos * sinT2;
    const d1x = -rx * cos * sinT - ry * sin * cosT, d1y = -rx * sin * sinT + ry * cos * cosT;
    const d2x = -rx * cos * sinT2 - ry * sin * cosT2, d2y = -rx * sin * sinT2 + ry * cos * cosT2;
    out.push({ op: 'c', x1: px + alpha * d1x, y1: py + alpha * d1y, x2: ex - alpha * d2x, y2: ey - alpha * d2y, x: ex, y: ey });
    px = ex; py = ey; t = t2;
  }
}

function segsToOps(segs: readonly Seg[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s.op === 'm') out.push(`${f(s.x)} ${f(s.y)} m`);
    else if (s.op === 'l') out.push(`${f(s.x)} ${f(s.y)} l`);
    else if (s.op === 'c') out.push(`${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)} c`);
    else out.push('h');
  }
  return out.join('\n');
}

export interface Box { x: number; y: number; width: number; height: number }

function segsBox(segs: readonly Seg[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number): void => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const s of segs) {
    if (s.op === 'h') continue;
    see(s.x, s.y);
    if (s.op === 'c') { see(s.x1, s.y1); see(s.x2, s.y2); }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Polyline approximation, used to walk text along a path. */
function flatten(segs: readonly Seg[], per = 24): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let cx = 0, cy = 0;
  for (const s of segs) {
    if (s.op === 'm') { pts.push([s.x, s.y]); cx = s.x; cy = s.y; }
    else if (s.op === 'l') { pts.push([s.x, s.y]); cx = s.x; cy = s.y; }
    else if (s.op === 'c') {
      for (let k = 1; k <= per; k++) {
        const t = k / per, u = 1 - t;
        pts.push([
          u * u * u * cx + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
          u * u * u * cy + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
        ]);
      }
      cx = s.x; cy = s.y;
    }
  }
  return pts;
}

/* ── fonts ──────────────────────────────────────────────────────────────── */

const SERIF = /playfair|dm serif|georgia|garamond|times|serif/i;
const MONO = /mono|courier|consolas|menlo/i;

/** Family + weight + slant → one of the 14 faces every PDF reader already has. */
export function base14(family: string, weight: number, italic: boolean): string {
  const first = (family.split(',')[0] ?? '').replace(/["']/g, '').trim();
  const bold = weight >= 600;
  if (MONO.test(first)) return `Courier${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
  if (SERIF.test(first)) return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  return `Helvetica${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
}

/**
 * Per-glyph advances in px, from the same tables `layoutText` measured with.
 * Positioning every glyph from these is what keeps a PDF line the same length
 * as its SVG twin even though the glyph shapes are substitutes.
 */
function advances(text: string, family: string, weight: number, size: number, tracking: number): number[] {
  const match = resolveFont(family, weight);
  const table = FONT_METRICS[match.family]?.weights[match.weight];
  const chars = [...text];
  return chars.map((ch, i) => {
    const em = table ? (table.advances[ch] ?? table.fallbackWidth) : 0.5;
    return em * size + (i < chars.length - 1 ? tracking : 0);
  });
}

/**
 * Adobe base-14 advance widths, in 1/1000 em, indexed by WinAnsi code - 32.
 *
 * The writer needs both halves of the substitution: where the design's font puts
 * a word (that is `advances()` above) and how wide the substitute face will
 * actually set it. Without the second half, placing whole words by absolute x
 * collides whenever the substitute runs wider than the design face by about a
 * space width, and the space between two words disappears.
 *
 * Fourteen faces need six tables: the oblique and italic cuts carry their roman
 * widths, and every Courier is a flat 600. The values were read out of the
 * system faces and checked against the published AFM metrics, which is what a
 * reader uses for a base-14 font it is not handed a /Widths array for. The gaps
 * are the unassigned WinAnsi codes, which `winAnsi()` cannot produce.
 *
 * These numbers only hold as far as the reader agrees with them. A reader that
 * substitutes something metrically different for a base-14 face will drift, and
 * nothing here can prevent it - that is the price of shipping metrics instead of
 * font binaries. If text is ever right in Preview and wrong somewhere else, this
 * is the first place to look.
 */
const W_HELVETICA: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  744, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 549, 333, 333, 333, 576, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 549, 611, 556, 556, 556, 556, 500, 556, 500,
];

const W_HELVETICA_BOLD: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
  744, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 549, 333, 333, 333, 576, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 549, 611, 611, 611, 611, 611, 556, 611, 556,
];

const W_TIMES: readonly number[] = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541, 0,
  744, 0, 333, 500, 444, 1000, 500, 500, 333, 1000, 556, 333, 889, 0, 611, 0,
  0, 333, 333, 444, 444, 350, 500, 1000, 333, 980, 389, 333, 722, 0, 444, 722,
  250, 333, 500, 500, 500, 500, 200, 500, 333, 760, 276, 500, 564, 333, 760, 333,
  400, 549, 300, 300, 333, 576, 453, 250, 333, 300, 310, 500, 750, 750, 750, 444,
  722, 722, 722, 722, 722, 722, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
  722, 722, 722, 722, 722, 722, 722, 564, 722, 722, 722, 722, 722, 722, 556, 500,
  444, 444, 444, 444, 444, 444, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  500, 500, 500, 500, 500, 500, 500, 549, 500, 500, 500, 500, 500, 500, 500, 500,
];

const W_TIMES_BOLD: readonly number[] = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520, 0,
  744, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333, 1000, 0, 667, 0,
  0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 0, 444, 722,
  250, 333, 500, 500, 500, 500, 220, 500, 333, 747, 300, 500, 570, 333, 747, 333,
  400, 549, 300, 300, 333, 576, 540, 250, 333, 300, 330, 500, 750, 750, 750, 500,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 389, 389, 389, 389,
  722, 722, 778, 778, 778, 778, 778, 570, 778, 722, 722, 722, 722, 722, 611, 556,
  500, 500, 500, 500, 500, 500, 722, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  500, 556, 500, 500, 500, 500, 500, 549, 500, 556, 556, 556, 556, 500, 556, 500,
];

const W_TIMES_ITALIC: readonly number[] = [
  250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500,
  920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722,
  611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500,
  333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500,
  500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541, 0,
  744, 0, 333, 500, 556, 889, 500, 500, 333, 1000, 500, 333, 944, 0, 556, 0,
  0, 333, 333, 556, 556, 350, 500, 889, 333, 980, 389, 333, 667, 0, 389, 556,
  250, 389, 500, 500, 500, 500, 275, 500, 333, 760, 276, 500, 675, 333, 760, 333,
  400, 549, 300, 300, 333, 576, 523, 250, 333, 300, 310, 500, 750, 750, 750, 500,
  611, 611, 611, 611, 611, 611, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
  722, 667, 722, 722, 722, 722, 722, 675, 722, 722, 722, 722, 722, 556, 611, 500,
  500, 500, 500, 500, 500, 500, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  500, 500, 500, 500, 500, 500, 500, 549, 500, 500, 500, 500, 500, 444, 500, 444,
];

const W_TIMES_BOLD_ITALIC: readonly number[] = [
  250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  832, 667, 667, 667, 722, 667, 667, 722, 778, 389, 500, 667, 611, 889, 722, 722,
  611, 722, 667, 556, 611, 722, 667, 889, 667, 611, 611, 333, 278, 333, 570, 500,
  333, 500, 500, 444, 500, 444, 333, 500, 556, 278, 278, 500, 278, 778, 556, 500,
  500, 500, 389, 389, 278, 556, 444, 667, 500, 444, 389, 348, 220, 348, 570, 0,
  744, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333, 944, 0, 611, 0,
  0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 0, 389, 611,
  250, 389, 500, 500, 500, 500, 220, 500, 333, 747, 266, 500, 606, 333, 747, 333,
  400, 549, 300, 300, 333, 576, 500, 250, 333, 300, 300, 500, 750, 750, 750, 500,
  667, 667, 667, 667, 667, 667, 944, 667, 667, 667, 667, 667, 389, 389, 389, 389,
  722, 722, 722, 722, 722, 722, 722, 570, 722, 722, 722, 722, 722, 611, 611, 500,
  500, 500, 500, 500, 500, 500, 722, 444, 444, 444, 444, 485, 278, 278, 278, 395,
  500, 556, 500, 500, 500, 500, 500, 549, 500, 556, 556, 556, 556, 444, 500, 444,
];

const COURIER_WIDTH = 600;

const BASE14_WIDTHS: Record<string, readonly number[]> = {
  'Helvetica': W_HELVETICA, 'Helvetica-Oblique': W_HELVETICA,
  'Helvetica-Bold': W_HELVETICA_BOLD, 'Helvetica-BoldOblique': W_HELVETICA_BOLD,
  'Times-Roman': W_TIMES, 'Times-Italic': W_TIMES_ITALIC,
  'Times-Bold': W_TIMES_BOLD, 'Times-BoldItalic': W_TIMES_BOLD_ITALIC,
};

/** How wide the substitute face sets one WinAnsi code, in px at `size`. */
function base14Width(face: string, code: number, size: number): number {
  const table = BASE14_WIDTHS[face];
  const w = table === undefined ? COURIER_WIDTH : (table[code - 32] ?? 500);
  return (w * size) / 1000;
}

/* WinAnsi codes for the punctuation Artboard can produce above ASCII. */
const WINANSI: Record<string, number> = {
  '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85,
  '\u2020': 0x86, '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89, '\u0160': 0x8a,
  '\u2039': 0x8b, '\u0152': 0x8c, '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92,
  '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b, '\u0153': 0x9c,
  '\u017e': 0x9e, '\u0178': 0x9f,
};

function winAnsi(ch: string): number | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (WINANSI[ch] !== undefined) return WINANSI[ch] as number;
  if (code >= 0xa0 && code <= 0xff) return code;
  return null;
}

/* ── images ─────────────────────────────────────────────────────────────── */

export interface PdfImage {
  width: number;
  height: number;
  /** 1 = DeviceGray, 3 = DeviceRGB. */
  components: 1 | 3;
  filter: 'DCTDecode' | 'FlateDecode';
  data: Uint8Array;
  /** 8-bit soft mask, one byte per pixel, when the source had transparency. */
  alpha?: Uint8Array;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0, bits = 0, at = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, at);
}

export function dataUriBytes(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = (m[1] ?? '').toLowerCase();
  const body = m[3] ?? '';
  return { mime, bytes: m[2] ? fromBase64(body) : latin1(decodeURIComponent(body)) };
}

/** Width, height and component count from a JPEG's frame header. */
function jpegInfo(bytes: Uint8Array): { width: number; height: number; components: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    // SOF0..SOF15, minus the DHT/JPG/DAC slots that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number),
        width: ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number),
        components: bytes[i + 9] as number,
      };
    }
    i += 2 + len;
  }
  return null;
}

/** Non-interlaced PNG, bit depths 1/2/4/8/16, all five colour types. */
async function decodePng(bytes: Uint8Array): Promise<PdfImage | null> {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;

  let width = 0, height = 0, depth = 8, colorType = 6, interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let at = 8;
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12);
      depth = bytes[at + 16] as number; colorType = bytes[at + 17] as number;
      interlace = bytes[at + 20] as number;
    } else if (type === 'PLTE') palette = body.slice();
    else if (type === 'tRNS') transparency = body.slice();
    else if (type === 'IDAT') idat.push(body.slice());
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height || interlace !== 0) return null;

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const raw = await inflate(concat(idat));
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < height * (rowBytes + 1)) return null;

  // Undo the per-scanline filters in place: each row is predicted from the row
  // above and the pixel to the left, so this has to run top to bottom.
  const flat = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)] as number;
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const up = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[src + x] as number;
      const a = x >= bpp ? (flat[dst + x - bpp] as number) : 0;
      const b = y > 0 ? (flat[up + x] as number) : 0;
      const c = y > 0 && x >= bpp ? (flat[up + x - bpp] as number) : 0;
      let out = value;
      if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      flat[dst + x] = out & 0xff;
    }
  }

  const max = (1 << depth) - 1;
  const sample = (row: number, index: number): number => {
    if (depth === 8) return flat[row * rowBytes + index] as number;
    if (depth === 16) return flat[row * rowBytes + index * 2] as number;
    const bitAt = index * depth;
    const byte = flat[row * rowBytes + (bitAt >> 3)] as number;
    return (byte >> (8 - depth - (bitAt & 7))) & max;
  };
  const to8 = (v: number): number => (depth === 8 || depth === 16 ? v : Math.round((v * 255) / max));

  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let hasAlpha = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let r = 0, g = 0, b = 0, a = 255;
      if (colorType === 0) { r = g = b = to8(sample(y, x)); }
      else if (colorType === 2) { r = to8(sample(y, x * 3)); g = to8(sample(y, x * 3 + 1)); b = to8(sample(y, x * 3 + 2)); }
      else if (colorType === 3) {
        const idx = sample(y, x);
        r = palette?.[idx * 3] ?? 0; g = palette?.[idx * 3 + 1] ?? 0; b = palette?.[idx * 3 + 2] ?? 0;
        a = transparency?.[idx] ?? 255;
      } else if (colorType === 4) { r = g = b = to8(sample(y, x * 2)); a = to8(sample(y, x * 2 + 1)); }
      else { r = to8(sample(y, x * 4)); g = to8(sample(y, x * 4 + 1)); b = to8(sample(y, x * 4 + 2)); a = to8(sample(y, x * 4 + 3)); }
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      alpha[i] = a;
      if (a !== 255) hasAlpha = true;
    }
  }

  const image: PdfImage = { width, height, components: 3, filter: 'FlateDecode', data: await deflate(rgb) };
  if (hasAlpha) image.alpha = await deflate(alpha);
  return image;
}

/** A `data:` image URI as something PDF can embed, or null if we can't read it. */
export async function decodeImage(uri: string): Promise<PdfImage | null> {
  const parsed = dataUriBytes(uri);
  if (!parsed) return null;
  if (parsed.mime === 'image/jpeg' || parsed.mime === 'image/jpg') {
    const info = jpegInfo(parsed.bytes);
    if (!info) return null;
    // A JPEG is already a DCT stream: hand it to the PDF untouched, no re-encode.
    return { width: info.width, height: info.height, components: info.components === 1 ? 1 : 3, filter: 'DCTDecode', data: parsed.bytes };
  }
  if (parsed.mime === 'image/png') return decodePng(parsed.bytes);
  return null;
}

/* ── the object file ────────────────────────────────────────────────────── */

class PdfFile {
  private bodies: Array<Uint8Array | null> = [];

  alloc(): number { this.bodies.push(null); return this.bodies.length; }

  set(ref: number, body: Uint8Array | string): void {
    this.bodies[ref - 1] = typeof body === 'string' ? latin1(body) : body;
  }

  add(body: Uint8Array | string): number { const ref = this.alloc(); this.set(ref, body); return ref; }

  addStream(dict: string, data: Uint8Array): number {
    return this.add(concat([
      latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`),
      data,
      latin1('\nendstream'),
    ]));
  }

  build(root: number, info: number): Uint8Array {
    // The binary comment on line 2 is what makes FTP clients treat this as binary.
    const parts: Uint8Array[] = [latin1('%PDF-1.7\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
    let at = parts[0]!.length + parts[1]!.length;
    const offsets: number[] = [];

    this.bodies.forEach((body, index) => {
      offsets.push(at);
      const head = latin1(`${index + 1} 0 obj\n`);
      const tail = latin1('\nendobj\n');
      const payload = body ?? latin1('null');
      parts.push(head, payload, tail);
      at += head.length + payload.length + tail.length;
    });

    const count = this.bodies.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${count} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`;
    parts.push(latin1(xref));
    return concat(parts);
  }
}

/* ── the page painter ───────────────────────────────────────────────────── */

interface Resources {
  fonts: Map<string, string>;                 // base-14 name -> /F1
  xobjects: Map<string, { name: string; ref: number }>;
  shadings: Array<{ name: string; ref: number }>;
  gstates: Map<string, string>;
  gstateDicts: Map<string, string>;
}

interface Painter {
  file: PdfFile;
  defs: Map<string, SceneNode>;
  images: Map<string, PdfImage | null>;
  res: Resources;
  ops: string[];
  notes: Set<string>;
}

const isNone = (v: string | number | undefined): boolean => v === undefined || String(v) === 'none';

function collectDefs(node: SceneNode, into: Map<string, SceneNode>): void {
  const id = node.attrs['id'];
  if (typeof id === 'string') into.set(id, node);
  for (const child of node.children ?? []) collectDefs(child, into);
}

const refId = (value: string | number | undefined): string | null => {
  const m = /^url\(#([^)]+)\)$/.exec(String(value ?? ''));
  return m ? (m[1] as string) : null;
};

function gstate(p: Painter, entries: string): string {
  const existing = p.res.gstates.get(entries);
  if (existing) return existing;
  const name = `GS${p.res.gstates.size + 1}`;
  p.res.gstates.set(entries, name);
  p.res.gstateDicts.set(name, entries);
  return name;
}

/** `"55%"`, `"0.55"` and `0.55` are the same number to SVG. */
function ratio(value: string | number | undefined, fallback: number): number {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  const n = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(n) ? n : fallback;
}

/** An axial or radial shading, defined on the unit square and mapped to `box`. */
function shading(p: Painter, def: SceneNode, box: Box): { name: string; smask: string | null } | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const raw = (def.children ?? [])
    .filter(c => c.tag === 'stop')
    .map(c => {
      const color = parseColor(c.attrs['stop-color']);
      if (!color) return null;
      const opacity = c.attrs['stop-opacity'];
      return {
        offset: Math.min(1, Math.max(0, ratio(c.attrs['offset'], 0))),
        color: opacity === undefined ? color : { ...color, a: color.a * Number(opacity) },
      };
    })
    .filter((s): s is { offset: number; color: Rgba } => s !== null);
  if (raw.length < 2) return null;

  // PDF stitching functions run over the whole [0 1] domain, so a ramp that
  // starts at 55% needs an explicit flat segment in front of it. Without the
  // clamp stops the gradient starts in the wrong place.
  const stops = [...raw];
  if ((stops[0] as { offset: number }).offset > 0) stops.unshift({ ...stops[0]!, offset: 0 });
  const last = stops[stops.length - 1]!;
  if (last.offset < 1) stops.push({ ...last, offset: 1 });

  /** One stitched ramp over the stops, in whatever colour space `channel` picks. */
  const ramp = (channel: (c: Rgba) => number[]): string => {
    const pieces: string[] = [];
    const bounds: number[] = [];
    const encode: string[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = channel(stops[i]!.color).map(f).join(' ');
      const b = channel(stops[i + 1]!.color).map(f).join(' ');
      pieces.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${a}] /C1 [${b}] /N 1 >>`);
      encode.push('0 1');
      if (i > 0) bounds.push(stops[i]!.offset);
    }
    if (pieces.length === 0) return `<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [0] /N 1 >>`;
    return pieces.length === 1
      ? pieces[0] as string
      : `<< /FunctionType 3 /Domain [0 1] /Functions [${pieces.join(' ')}] /Bounds [${bounds.map(f).join(' ')}] /Encode [${encode.join(' ')}] >>`;
  };
  const fn = ramp(c => [c.r, c.g, c.b]);

  const coords = def.tag === 'radialGradient'
    ? `/ShadingType 3 /Coords [${f(ratio(def.attrs['cx'], 0.5))} ${f(ratio(def.attrs['cy'], 0.5))} 0 ${f(ratio(def.attrs['cx'], 0.5))} ${f(ratio(def.attrs['cy'], 0.5))} ${f(ratio(def.attrs['r'], 0.5))}]`
    : `/ShadingType 2 /Coords [${f(ratio(def.attrs['x1'], 0))} ${f(ratio(def.attrs['y1'], 0))} ${f(ratio(def.attrs['x2'], 1))} ${f(ratio(def.attrs['y2'], 0))}]`;

  const ref = p.file.add(`<< ${coords} /ColorSpace /DeviceRGB /Function ${fn} /Extend [true true] >>`);
  const name = `Sh${p.res.shadings.length + 1}`;
  p.res.shadings.push({ name, ref });

  // Transparent stops (a vignette, a fade) are a luminosity soft mask: the same
  // ramp painted in greyscale, where white keeps the pixel and black drops it.
  // Without this a fade-to-nothing gradient paints as fade-to-solid.
  let smask: string | null = null;
  if (stops.some(st => st.color.a < 1)) {
    const maskShading = p.file.add(`<< ${coords} /ColorSpace /DeviceGray /Function ${ramp(c => [c.a])} /Extend [true true] >>`);
    const form = p.file.addStream(
      `/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency /CS /DeviceGray >>` +
      ` /Resources << /Shading << /ShM ${maskShading} 0 R >> >>`,
      latin1('/ShM sh'),
    );
    smask = gstate(p, `/SMask << /S /Luminosity /G ${form} 0 R >>`);
  }
  return { name, smask };
}

/** Turn one drawable element into path segments in the current user space. */
function elementPath(node: SceneNode): Seg[] | null {
  const n = (k: string, d = 0): number => {
    const v = Number(node.attrs[k]);
    return Number.isFinite(v) ? v : d;
  };
  switch (node.tag) {
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      const r = Math.min(n('rx', n('ry')), w / 2, h / 2);
      if (w <= 0 || h <= 0) return null;
      if (!(r > 0)) return [{ op: 'm', x, y }, { op: 'l', x: x + w, y }, { op: 'l', x: x + w, y: y + h }, { op: 'l', x, y: y + h }, { op: 'h' }];
      const k = r * KAPPA;
      return [
        { op: 'm', x: x + r, y },
        { op: 'l', x: x + w - r, y },
        { op: 'c', x1: x + w - r + k, y1: y, x2: x + w, y2: y + r - k, x: x + w, y: y + r },
        { op: 'l', x: x + w, y: y + h - r },
        { op: 'c', x1: x + w, y1: y + h - r + k, x2: x + w - r + k, y2: y + h, x: x + w - r, y: y + h },
        { op: 'l', x: x + r, y: y + h },
        { op: 'c', x1: x + r - k, y1: y + h, x2: x, y2: y + h - r + k, x, y: y + h - r },
        { op: 'l', x, y: y + r },
        { op: 'c', x1: x, y1: y + r - k, x2: x + r - k, y2: y, x: x + r, y },
        { op: 'h' },
      ];
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = node.tag === 'circle' ? n('r') : n('rx');
      const ry = node.tag === 'circle' ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return null;
      const kx = rx * KAPPA, ky = ry * KAPPA;
      return [
        { op: 'm', x: cx + rx, y: cy },
        { op: 'c', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
        { op: 'c', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
        { op: 'c', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
        { op: 'c', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
        { op: 'h' },
      ];
    }
    case 'line':
      return [{ op: 'm', x: n('x1'), y: n('y1') }, { op: 'l', x: n('x2'), y: n('y2') }];
    case 'polygon':
    case 'polyline': {
      const nums = String(node.attrs['points'] ?? '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (nums.length < 4) return null;
      const segs: Seg[] = [{ op: 'm', x: nums[0] as number, y: nums[1] as number }];
      for (let i = 2; i + 1 < nums.length; i += 2) segs.push({ op: 'l', x: nums[i] as number, y: nums[i + 1] as number });
      if (node.tag === 'polygon') segs.push({ op: 'h' });
      return segs;
    }
    case 'path':
      return parsePath(String(node.attrs['d'] ?? ''));
    default:
      return null;
  }
}

/** Paint one filled/stroked shape, honouring gradients, dashes and alpha. */
function paintShape(p: Painter, node: SceneNode, segs: Seg[]): void {
  const fill = node.attrs['fill'];
  const stroke = node.attrs['stroke'];
  const strokeWidth = Number(node.attrs['stroke-width'] ?? 1);
  const fillColor = isNone(fill) ? null : parseColor(fill);
  const gradId = refId(fill);
  const strokeColor = isNone(stroke) ? null : parseColor(stroke) ?? parseColor(String(p.defs.get(refId(stroke) ?? '')?.children?.[0]?.attrs['stop-color'] ?? ''));
  const hasStroke = strokeColor !== null && strokeWidth > 0;
  if (!fillColor && !gradId && !hasStroke) return;

  if (node.attrs['marker-start'] !== undefined || node.attrs['marker-end'] !== undefined) {
    p.notes.add('Arrowheads are not drawn in PDF; the line itself is.');
  }

  const ops = segsToOps(segs);
  const alphaEntries: string[] = [];
  if (fillColor && fillColor.a < 1) alphaEntries.push(`/ca ${f(fillColor.a)}`);
  if (strokeColor && strokeColor.a < 1) alphaEntries.push(`/CA ${f(strokeColor.a)}`);

  p.ops.push('q');
  if (alphaEntries.length) p.ops.push(`/${gstate(p, alphaEntries.join(' '))} gs`);

  if (gradId) {
    const def = p.defs.get(gradId);
    const box = segsBox(segs);
    const sh = def ? shading(p, def, box) : null;
    if (sh) {
      p.ops.push(ops, 'W n', matOp([box.width, 0, 0, box.height, box.x, box.y]));
      if (sh.smask) p.ops.push(`/${sh.smask} gs`);
      p.ops.push(`/${sh.name} sh`);
    } else if (def) {
      const first = parseColor(def.children?.[0]?.attrs['stop-color']);
      if (first) p.ops.push(fillOp(first), ops, 'f');
    }
    // A gradient fill is painted through a clip, so a stroke needs its own pass.
    if (hasStroke) { p.ops.push('Q', 'q'); }
  }

  if (!gradId && fillColor) p.ops.push(fillOp(fillColor));
  if (hasStroke) {
    p.ops.push(strokeOp(strokeColor), `${f(strokeWidth)} w`);
    const dash = String(node.attrs['stroke-dasharray'] ?? '').trim();
    if (dash) p.ops.push(`[${dash.split(/[\s,]+/).map(Number).filter(Number.isFinite).map(f).join(' ')}] 0 d`);
    if (node.attrs['stroke-linecap'] === 'round') p.ops.push('1 J');
    else if (node.attrs['stroke-linecap'] === 'square') p.ops.push('2 J');
    if (node.attrs['stroke-linejoin'] === 'round') p.ops.push('1 j');
  }

  if (!gradId && (fillColor || hasStroke)) {
    p.ops.push(ops, fillColor && hasStroke ? 'B' : fillColor ? 'f' : 'S');
  } else if (gradId && hasStroke) {
    p.ops.push(ops, 'S');
  }
  p.ops.push('Q');
}

/* ── text ───────────────────────────────────────────────────────────────── */

interface TextStyle {
  family: string; size: number; weight: number; italic: boolean;
  tracking: number; anchor: string; color: Rgba;
}

function textStyle(p: Painter, node: SceneNode): TextStyle {
  const fill = node.attrs['fill'];
  const gradId = refId(fill);
  let color = parseColor(fill);
  if (gradId) {
    color = parseColor(p.defs.get(gradId)?.children?.[0]?.attrs['stop-color']);
    p.notes.add('Gradient-filled text is drawn in its first gradient colour in PDF.');
  }
  return {
    family: String(node.attrs['font-family'] ?? 'Inter'),
    size: Number(node.attrs['font-size'] ?? 16),
    weight: Number(node.attrs['font-weight'] ?? 400),
    italic: String(node.attrs['font-style'] ?? '') === 'italic',
    tracking: Number(node.attrs['letter-spacing'] ?? 0) || 0,
    anchor: String(node.attrs['text-anchor'] ?? 'start'),
    color: color ?? { r: 0, g: 0, b: 0, a: 1 },
  };
}

function fontName(p: Painter, style: TextStyle): string {
  const base = base14(style.family, style.weight, style.italic);
  const existing = p.res.fonts.get(base);
  if (existing) return existing;
  const name = `F${p.res.fonts.size + 1}`;
  p.res.fonts.set(base, name);
  return name;
}

/**
 * One line of text.
 *
 * Words are placed, not glyphs: each word starts at exactly the x the engine's
 * metrics put it at, and the substitute face sets its own letters inside the
 * word. That keeps the line's boxes and breaks identical to the SVG while the
 * typography still reads as typography — forcing every individual glyph into
 * place instead leaves visible gaps inside words wherever Helvetica and the
 * design face disagree.
 *
 * Each word is then fitted to the exact width the engine gave it, because a
 * substitute face that runs wider would otherwise swallow the space after the
 * word - Helvetica-Bold sets "PRODUCT" 0.3pt short of the box Space Grotesk
 * gives it, and the space that should follow disappears. The correction is
 * split: up to 5% of horizontal scaling (`Tz`), the rest as even letter-spacing
 * (`Tc`). Doing all of it either way is what looks wrong.
 *
 * Only one case still needs per-glyph placement, and takes it: text riding a
 * path, where every glyph has its own rotation.
 */
function drawLine(p: Painter, style: TextStyle, text: string, x: number, y: number, place?: (offset: number) => [number, number, number]): void {
  if (text === '') return;
  const chars = [...text];
  const widths = advances(text, style.family, style.weight, style.size, style.tracking);
  const total = widths.reduce((a, b) => a + b, 0);
  const start = style.anchor === 'middle' ? x - total / 2 : style.anchor === 'end' ? x - total : x;

  p.ops.push('q', fillOp(style.color));
  if (style.color.a < 1) p.ops.push(`/${gstate(p, `/ca ${f(style.color.a)}`)} gs`);
  p.ops.push('BT', `/${fontName(p, style)} ${f(style.size)} Tf`);

  // Only text on a path needs glyph-by-glyph placement.
  const perGlyph = place !== undefined;
  const face = base14(style.family, style.weight, style.italic);
  if (perGlyph && style.tracking !== 0) p.ops.push(`${f(style.tracking)} Tc`);
  const encoded: Array<string | null> = chars.map(ch => {
    const code = winAnsi(ch);
    if (code === null && ch.trim() !== '') p.notes.add('Some characters are outside the PDF base-14 encoding and were dropped.');
    return code === null ? null : String.fromCharCode(code);
  });

  let scale = 100, spacing = 0;
  const emit = (from: number, to: number): void => {
    const run = encoded.slice(from, to).filter((c): c is string => c !== null).join('');
    if (run === '') return;
    let cursor = 0;
    for (let i = 0; i < from; i++) cursor += widths[i] as number;

    // Fit the word to the box the engine measured, or the substitute face runs
    // wide and eats the space after it. `advances` leaves the gap off the last
    // glyph of the line, so the last word gets it back here.
    let target = to === chars.length ? style.tracking : 0;
    for (let i = from; i < to; i++) target += widths[i] as number;
    let glyphs = 0;
    for (const glyph of run) glyphs += base14Width(face, glyph.charCodeAt(0), style.size);

    // Split the correction. Up to 5% goes to horizontal scaling, which is
    // invisible; the rest is spread evenly between the glyphs as spacing, which
    // is what a typesetter would do and never distorts a letterform. Doing all
    // of it either way is what looks wrong - all-scaling fattens a two-letter
    // word by a fifth, all-spacing puts the whole error into one or two gaps.
    // A one-glyph word has no gaps to spread anything into, so there scaling is
    // the only channel and it gets the whole correction rather than overflowing
    // into the next word.
    const natural = glyphs + run.length * style.tracking;
    const floor = run.length === 1 ? 25 : 95;
    const fit = natural > 0 ? Math.min(Math.max((100 * target) / natural, floor), 105) : 100;
    const space = ((target * 100) / fit - glyphs) / run.length;

    if (f(fit) !== f(scale)) { p.ops.push(`${f(fit)} Tz`); scale = fit; }
    if (f(space) !== f(spacing)) { p.ops.push(`${f(space)} Tc`); spacing = space; }
    p.ops.push(`1 0 0 -1 ${f(start + cursor)} ${f(y)} Tm`, `${pdfString(run)} Tj`);
  };

  if (perGlyph) {
    let cursor = 0;
    chars.forEach((ch, i) => {
      const advance = widths[i] as number;
      const glyph = encoded[i];
      if (glyph !== null && glyph !== undefined) {
        const [gx, gy, angle] = place(cursor + advance / 2);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const ox = -advance / 2;   // place() reports the glyph centre; draw from its left edge
        p.ops.push(`${f(cos)} ${f(sin)} ${f(sin)} ${f(-cos)} ${f(gx + ox * cos)} ${f(gy + ox * sin)} Tm`);
        p.ops.push(`${pdfString(glyph)} Tj`);
      }
      cursor += advance;
    });
  } else {
    let wordStart = -1;
    chars.forEach((ch, i) => {
      const isSpace = ch === ' ' || ch === '\t';
      if (!isSpace && wordStart < 0) wordStart = i;
      if (isSpace && wordStart >= 0) { emit(wordStart, i); wordStart = -1; }
    });
    if (wordStart >= 0) emit(wordStart, chars.length);
  }

  p.ops.push('ET', 'Q');
}

function drawText(p: Painter, node: SceneNode): void {
  const style = textStyle(p, node);
  const children = node.children ?? [];

  const onPath = children.find(c => c.tag === 'textPath');
  if (onPath) {
    const def = p.defs.get(String(onPath.attrs['href'] ?? '').replace(/^#/, ''));
    const pts = def ? flatten(parsePath(String(def.attrs['d'] ?? ''))) : [];
    const text = onPath.text ?? '';
    if (pts.length < 2 || text === '') return;

    const cumulative = [0];
    for (let i = 1; i < pts.length; i++) {
      cumulative.push((cumulative[i - 1] as number) + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    }
    const length = cumulative[cumulative.length - 1] as number;
    const total = advances(text, style.family, style.weight, style.size, style.tracking).reduce((a, b) => a + b, 0);
    const offsetText = String(onPath.attrs['startOffset'] ?? '0%');
    const base = offsetText === '50%' ? (length - total) / 2 : offsetText === '100%' ? length - total : 0;

    const at = (s: number): [number, number, number] => {
      const d = Math.min(Math.max(base + s, 0), length);
      let i = 1;
      while (i < cumulative.length - 1 && (cumulative[i] as number) < d) i++;
      const t0 = cumulative[i - 1] as number, t1 = cumulative[i] as number;
      const k = t1 === t0 ? 0 : (d - t0) / (t1 - t0);
      const a = pts[i - 1] as [number, number], b = pts[i] as [number, number];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[1] - a[1], b[0] - a[0])];
    };
    // The anchor is already baked into startOffset; draw from the path start.
    drawLine(p, { ...style, anchor: 'start' }, text, 0, 0, at);
    return;
  }

  const spans = children.filter(c => c.tag === 'tspan');
  if (spans.length === 0) {
    if (node.text) drawLine(p, style, node.text, Number(node.attrs['x'] ?? 0), Number(node.attrs['y'] ?? 0));
    return;
  }
  for (const span of spans) {
    drawLine(p, style, span.text ?? '', Number(span.attrs['x'] ?? node.attrs['x'] ?? 0), Number(span.attrs['y'] ?? node.attrs['y'] ?? 0));
  }
}

/* ── images on the page ─────────────────────────────────────────────────── */

function drawImage(p: Painter, node: SceneNode): void {
  const href = String(node.attrs['href'] ?? node.attrs['xlink:href'] ?? '');
  const image = p.images.get(href) ?? null;
  const x = Number(node.attrs['x'] ?? 0), y = Number(node.attrs['y'] ?? 0);
  const w = Number(node.attrs['width'] ?? 0), h = Number(node.attrs['height'] ?? 0);
  if (w <= 0 || h <= 0) return;

  if (!image) {
    p.notes.add('An image could not be embedded in the PDF and is shown as a placeholder box.');
    p.ops.push('q', '0.95 0.95 0.95 rg', `${f(x)} ${f(y)} ${f(w)} ${f(h)} re`, 'f', 'Q');
    return;
  }

  let entry = p.res.xobjects.get(href);
  if (!entry) {
    let smask = '';
    if (image.alpha) {
      const maskRef = p.file.addStream(
        `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
        image.alpha,
      );
      smask = ` /SMask ${maskRef} 0 R`;
    }
    const ref = p.file.addStream(
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}` +
      ` /ColorSpace /Device${image.components === 1 ? 'Gray' : 'RGB'} /BitsPerComponent 8 /Filter /${image.filter}${smask}`,
      image.data,
    );
    entry = { name: `Im${p.res.xobjects.size + 1}`, ref };
    p.res.xobjects.set(href, entry);
  }

  // The image space's first row sits at the TOP of the unit square, and our
  // page CTM already points y downwards, so the height term is negated.
  p.ops.push('q', matOp([w, 0, 0, -h, x, y + h]), `/${entry.name} Do`, 'Q');
}

/* ── drop shadows ───────────────────────────────────────────────────────── */

/**
 * Drop the attributes the caller has already applied to the graphics state.
 * The shadow copy is drawn inside the element's own `q`, so re-reading its
 * transform, clip or opacity would apply each of them twice.
 */
function stripApplied(node: SceneNode): SceneNode {
  const attrs: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === 'transform' || k === 'clip-path' || k === 'filter' || k === 'opacity' || k === 'style') continue;
    attrs[k] = v;
  }
  const out: SceneNode = { tag: node.tag, attrs };
  if (node.text !== undefined) out.text = node.text;
  if (node.children) out.children = node.children;
  return out;
}

/** Recolour a subtree so every painted edge becomes the shadow colour. */
function silhouette(node: SceneNode, color: string): SceneNode {
  const attrs: Record<string, string | number> = { ...node.attrs };
  if (attrs['fill'] !== undefined && !isNone(attrs['fill'])) attrs['fill'] = color;
  if (attrs['stroke'] !== undefined && !isNone(attrs['stroke'])) attrs['stroke'] = color;
  const out: SceneNode = { tag: node.tag, attrs };
  if (node.text !== undefined) out.text = node.text;
  if (node.children) out.children = node.children.map(c => silhouette(c, color));
  return out;
}

/**
 * PDF has no blur. A `feDropShadow` becomes an offset silhouette in the shadow
 * colour — a hard shadow where the SVG has a soft one, which reads as the same
 * design decision rather than as a missing one.
 */
function dropShadow(p: Painter, filter: SceneNode, node: SceneNode): boolean {
  const primitives = filter.children ?? [];
  const shadow = primitives.length === 1 && primitives[0]!.tag === 'feDropShadow' ? primitives[0]! : null;
  if (!shadow) {
    p.notes.add('Blur, glow and colour-matrix effects have no PDF equivalent; those elements are drawn unfiltered.');
    return false;
  }
  const color = String(shadow.attrs['flood-color'] ?? '#00000040');
  const opacity = shadow.attrs['flood-opacity'];
  const rgba = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 0.25 };
  const alpha = opacity === undefined ? rgba.a : Number(opacity);
  if (Number(shadow.attrs['stdDeviation'] ?? 0) > 0) {
    p.notes.add('Soft shadows are drawn as hard offset shadows in PDF.');
  }

  p.ops.push('q', `/${gstate(p, `/ca ${f(alpha)} /CA ${f(alpha)}`)} gs`);
  p.ops.push(matOp([1, 0, 0, 1, Number(shadow.attrs['dx'] ?? 0), Number(shadow.attrs['dy'] ?? 0)]));
  const flat = `#${[rgba.r, rgba.g, rgba.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
  drawNode(p, silhouette(node, flat), true);
  p.ops.push('Q');
  return true;
}

/* ── the walk ───────────────────────────────────────────────────────────── */

function drawNode(p: Painter, node: SceneNode, insideShadow = false): void {
  if (node.tag === 'defs' || node.tag === 'title' || node.tag === 'desc' || node.tag === 'metadata') return;

  const transform = node.attrs['transform'];
  const clip = refId(node.attrs['clip-path']);
  const filterId = insideShadow ? null : refId(node.attrs['filter']);
  const opacity = node.attrs['opacity'] === undefined ? 1 : Number(node.attrs['opacity']);
  const blend = /mix-blend-mode:\s*([a-z-]+)/.exec(String(node.attrs['style'] ?? ''))?.[1];

  const wraps = transform !== undefined || clip !== null || opacity < 1 || blend !== undefined;
  if (wraps) p.ops.push('q');
  if (transform !== undefined) p.ops.push(matOp(parseTransform(transform)));
  if (clip !== null) {
    const def = p.defs.get(clip);
    const shape = def?.children?.[0];
    const segs = shape ? elementPath(shape) : null;
    if (segs && shape) {
      const inner = shape.attrs['transform'];
      if (inner !== undefined) {
        // A transformed clip shape has to be built in its own space, so the
        // clip is set inside a q/Q that the drawing itself must not inherit.
        p.ops.push('q', matOp(parseTransform(inner)), segsToOps(segs), 'W n', 'Q');
      } else p.ops.push(segsToOps(segs), 'W n');
    }
  }
  const entries: string[] = [];
  if (opacity < 1) entries.push(`/ca ${f(opacity)} /CA ${f(opacity)}`);
  if (blend) entries.push(`/BM /${blend.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase())}`);
  if (entries.length) p.ops.push(`/${gstate(p, entries.join(' '))} gs`);

  if (filterId) {
    const filter = p.defs.get(filterId);
    if (filter) dropShadow(p, filter, stripApplied(node));
  }

  switch (node.tag) {
    case 'text': drawText(p, node); break;
    case 'image': drawImage(p, node); break;
    case 'svg':
    case 'g':
    case 'a':
      for (const child of node.children ?? []) drawNode(p, child, insideShadow);
      break;
    default: {
      const segs = elementPath(node);
      if (segs && segs.length) paintShape(p, node, segs);
      else if (node.children) for (const child of node.children) drawNode(p, child, insideShadow);
      break;
    }
  }

  if (wraps) p.ops.push('Q');
}

/* ── entry point ────────────────────────────────────────────────────────── */

function imageHrefs(node: SceneNode, into: Set<string>): void {
  if (node.tag === 'image') {
    const href = String(node.attrs['href'] ?? node.attrs['xlink:href'] ?? '');
    if (href.startsWith('data:')) into.add(href);
  }
  for (const child of node.children ?? []) imageHrefs(child, into);
}

/** One PDF page per scene, each at its artboard's own size. */
export async function renderPdf(pages: readonly PdfPage[], opts: PdfOptions = {}): Promise<PdfResult> {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;

  const hrefs = new Set<string>();
  for (const page of pages) imageHrefs(page.scene, hrefs);
  const images = new Map<string, PdfImage | null>();
  for (const href of hrefs) images.set(href, await decodeImage(href).catch(() => null));

  const file = new PdfFile();
  const catalog = file.alloc();
  const pagesRef = file.alloc();
  const notes = new Set<string>();
  const pageRefs: number[] = [];

  for (const page of pages) {
    const defs = new Map<string, SceneNode>();
    collectDefs(page.scene, defs);
    const res: Resources = { fonts: new Map(), xobjects: new Map(), shadings: [], gstates: new Map(), gstateDicts: new Map() };
    const painter: Painter = { file, defs, images, res, ops: [], notes };

    const wPt = page.width * PT_PER_PX * scale;
    const hPt = page.height * PT_PER_PX * scale;
    const k = PT_PER_PX * scale;
    // Flip to SVG's y-down space once, at the top of the page, so every
    // coordinate below is the artboard coordinate the renderer emitted.
    painter.ops.push(matOp([k, 0, 0, -k, 0, hPt]));
    drawNode(painter, page.scene);

    const content = file.addStream('/Filter /FlateDecode', await deflate(latin1(painter.ops.join('\n'))));

    const fontRefs = [...res.fonts].map(([base, name]) =>
      `${name} ${file.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`)} 0 R`);
    const dict = [
      fontRefs.length ? `/Font << ${fontRefs.map(s => `/${s}`).join(' ')} >>` : '',
      res.xobjects.size ? `/XObject << ${[...res.xobjects.values()].map(x => `/${x.name} ${x.ref} 0 R`).join(' ')} >>` : '',
      res.shadings.length ? `/Shading << ${res.shadings.map(s => `/${s.name} ${s.ref} 0 R`).join(' ')} >>` : '',
      res.gstateDicts.size ? `/ExtGState << ${[...res.gstateDicts].map(([name, body]) => `/${name} << /Type /ExtGState ${body} >>`).join(' ')} >>` : '',
    ].filter(Boolean).join(' ');

    const ref = file.alloc();
    file.set(ref, `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${f(wPt)} ${f(hPt)}] /Resources << ${dict} >> /Contents ${content} 0 R >>`);
    pageRefs.push(ref);
  }

  file.set(pagesRef, `<< /Type /Pages /Kids [${pageRefs.map(r => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  file.set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
  const info = file.add(`<< /Title ${pdfString(opts.title ?? 'Untitled')} /Producer (Artboard) /Creator (Artboard) >>`);

  return { bytes: file.build(catalog, info), notes: [...notes] };
}
