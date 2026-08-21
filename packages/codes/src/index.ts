/**
 * @artboard/codes — QR codes and barcodes as Artboard nodes.
 *
 * Zero dependencies, zero I/O, zero randomness. Every exported builder is a
 * pure function of its options: the same call produces byte-identical nodes,
 * which is what lets a code sit inside a golden-tested document.
 *
 * A code is emitted as ONE `path` node. Every dark module of a QR, and every
 * bar of a barcode, is a subpath of a single `d` string, so the whole symbol
 * is a single cheap object the user can drag, scale and rotate as a unit.
 */

import { CodeError, qrMatrix, MAX_VERSION, type EcLevel } from './qr.js';
import { code128, ean13, ean13Digits, ean13CheckDigit, EAN13_GUARDS } from './barcode.js';

export { CodeError, qrMatrix, MAX_VERSION, code128, ean13, ean13Digits, ean13CheckDigit };
export type { EcLevel };

/* ── local structural node types ────────────────────────────────────────────
 * Mirrors @artboard/schema so this package stays dependency-free, exactly as
 * @artboard/templates does.
 * -------------------------------------------------------------------------- */

export type CodeFill =
  | { kind: 'solid'; color: string }
  | { kind: 'none' };

export interface CodeStroke {
  color: string; width: number; dash: number[];
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  markerStart: 'none'; markerEnd: 'none';
}

interface NodeBase {
  id: string;
  name: string;
  x: number; y: number;
  width: number; height: number;
  rotation: 0;
  opacity: 1;
  visible: true;
  locked: false;
  shadow: null;
  effects: never[];
  blend: 'normal';
  flipX: false;
  flipY: false;
  alt: string;
}

export interface CodePathNode extends NodeBase {
  kind: 'path';
  d: string;
  viewBox: [number, number];
  fill: CodeFill;
  stroke: CodeStroke;
}

export interface CodeRectNode extends NodeBase {
  kind: 'rect';
  fill: CodeFill;
  stroke: CodeStroke;
  radius: number;
}

export interface CodeTextNode extends NodeBase {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: false;
  lineHeight: number;
  letterSpacing: number;
  align: 'center';
  valign: 'middle';
  color: string;
  uppercase: false;
}

export type Node = CodePathNode | CodeRectNode | CodeTextNode;

const NO_STROKE: CodeStroke = {
  color: '#000000', width: 0, dash: [],
  cap: 'butt', join: 'miter', markerStart: 'none', markerEnd: 'none',
};

/** Golden tests diff SVG strings, so every coordinate lands on 3 decimals. */
const round = (n: number): number => Math.round(n * 1000) / 1000;

const base = (id: string, name: string, x: number, y: number, width: number, height: number): NodeBase => ({
  id,
  name,
  x: round(x), y: round(y),
  width: round(width), height: round(height),
  rotation: 0, opacity: 1, visible: true, locked: false,
  shadow: null, effects: [], blend: 'normal',
  flipX: false, flipY: false, alt: '',
});

/** Hands out `${prefix}-0`, `${prefix}-1`, ... in emission order. */
const ids = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${n++}`;
};

/**
 * One axis-aligned rectangle as an `M h v h z` subpath. Relative h/v keeps the
 * `d` string short, which matters when a dense QR has hundreds of runs.
 */
const rectPath = (x: number, y: number, w: number, h: number): string =>
  `M${round(x)} ${round(y)}h${round(w)}v${round(h)}h${round(-w)}z`;

/* ── QR ─────────────────────────────────────────────────────────────────── */

export interface QrNodeOptions {
  /** The payload. Encoded in byte mode: ISO-8859-1, or UTF-8 when it must be. */
  text: string;
  x: number;
  y: number;
  /** Edge length of the finished square, quiet zone included. */
  size: number;
  /** Error-correction level. Defaults to `M`. */
  ec?: EcLevel;
  /** Dark-module colour. Defaults to `#111111`. */
  dark?: string;
  /** When given, a background rect of this colour is emitted behind the code. */
  light?: string;
  /** Quiet-zone width in modules. Defaults to 4, the specified minimum. */
  quiet?: number;
  /** Id prefix. Nodes are `${id}-0`, `${id}-1`, ... Defaults to `qr`. */
  id?: string;
}

/**
 * Builds an Artboard `path` node drawing every dark module of the QR, plus an
 * optional background `rect` when `light` is given.
 *
 * The path's `d` is written in module coordinates and the node's `viewBox` is
 * the module grid, so the renderer's own scale carries it to `size` — the code
 * stays crisp at any size and re-scales without re-encoding.
 *
 * @throws {CodeError} when the text does not fit a version-10 symbol.
 */
export function qrNode(opts: QrNodeOptions): Node[] {
  const { text, x, y, size } = opts;
  const ec = opts.ec ?? 'M';
  const dark = opts.dark ?? '#111111';
  const quiet = opts.quiet ?? 4;

  if (!(size > 0)) throw new CodeError(`QR size must be positive; got ${size}.`);
  if (!Number.isInteger(quiet) || quiet < 0) {
    throw new CodeError(`QR quiet zone must be a non-negative whole number of modules; got ${quiet}.`);
  }

  const matrix = qrMatrix(text, ec);
  const span = matrix.length + quiet * 2;

  // Merge horizontally adjacent dark modules into one run per subpath. A dense
  // v10-H code drops from ~2800 subpaths to a few hundred.
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r]!;
    let c = 0;
    while (c < row.length) {
      if (!row[c]) { c++; continue; }
      let end = c;
      while (end < row.length && row[end]) end++;
      parts.push(rectPath(quiet + c, quiet + r, end - c, 1));
      c = end;
    }
  }

  const nextId = ids(opts.id ?? 'qr');
  const nodes: Node[] = [];

  if (opts.light !== undefined) {
    nodes.push({
      ...base(nextId(), 'QR background', x, y, size, size),
      kind: 'rect',
      fill: { kind: 'solid', color: opts.light },
      stroke: { ...NO_STROKE },
      radius: 0,
    });
  }

  nodes.push({
    ...base(nextId(), 'QR code', x, y, size, size),
    kind: 'path',
    d: parts.join(''),
    viewBox: [span, span],
    fill: { kind: 'solid', color: dark },
    stroke: { ...NO_STROKE },
  });

  return nodes;
}

/* ── barcodes ───────────────────────────────────────────────────────────── */

export type Symbology = 'code128' | 'ean13';

export interface BarcodeNodeOptions {
  /** Code 128: any printable ASCII. EAN-13: 12 or 13 digits. */
  text: string;
  symbology: Symbology;
  x: number;
  y: number;
  /** Total width, quiet zones included. */
  width: number;
  /** Total height, the human-readable line included when `showText` is on. */
  height: number;
  /** Bar colour, and the colour of the human-readable line. Defaults to `#111111`. */
  dark?: string;
  /** Adds a centred human-readable line under the bars. Defaults to `false`. */
  showText?: boolean;
  /** Id prefix. Nodes are `${id}-0`, `${id}-1`, ... Defaults to `barcode`. */
  id?: string;
}

/** Left and right quiet zones, in modules, per the two symbologies' specs. */
const QUIET: Record<Symbology, [number, number]> = {
  code128: [10, 10],
  ean13: [9, 7],
};

/** Share of the node height the bars occupy once a text line is added. */
const BAR_SHARE = 0.82;

/** Vertical resolution of the barcode path's viewBox. */
const BAR_UNITS = 1000;

/**
 * Builds an Artboard `path` node drawing every bar, plus an optional `text`
 * node carrying the human-readable line.
 *
 * Quiet zones are included inside `width` — 10 modules either side for
 * Code 128, 9 left and 7 right for EAN-13 — so the node can be placed flush
 * against other content and still scan.
 *
 * @throws {CodeError} on input the chosen symbology cannot encode.
 */
export function barcodeNode(opts: BarcodeNodeOptions): Node[] {
  const { text, symbology, x, y, width, height } = opts;
  const dark = opts.dark ?? '#111111';
  const showText = opts.showText ?? false;

  if (!(width > 0) || !(height > 0)) {
    throw new CodeError(`Barcode width and height must be positive; got ${width}x${height}.`);
  }

  let modules: boolean[];
  let label: string;
  let guards: ReadonlyArray<readonly [number, number]>;

  switch (symbology) {
    case 'code128':
      modules = code128(text);
      label = text;
      guards = [];
      break;
    case 'ean13':
      modules = ean13(text);
      label = ean13Digits(text);
      guards = EAN13_GUARDS;
      break;
    default:
      throw new CodeError(`Unknown symbology ${JSON.stringify(symbology)}; use "code128" or "ean13".`);
  }

  const [quietLeft, quietRight] = QUIET[symbology];
  const span = quietLeft + modules.length + quietRight;

  const barHeight = showText ? height * BAR_SHARE : height;
  // Guard bars drop past the digits, the way a printed EAN does. With no text
  // line there is nothing to drop past, so every bar runs full height.
  const shortBar = showText && guards.length > 0 ? Math.round(BAR_UNITS * 0.93) : BAR_UNITS;
  const isGuard = (i: number): boolean => guards.some(([from, to]) => i >= from && i < to);

  const parts: string[] = [];
  let i = 0;
  while (i < modules.length) {
    if (!modules[i]) { i++; continue; }
    const guard = isGuard(i);
    let end = i;
    while (end < modules.length && modules[end] && isGuard(end) === guard) end++;
    parts.push(rectPath(quietLeft + i, 0, end - i, guard ? BAR_UNITS : shortBar));
    i = end;
  }

  const nextId = ids(opts.id ?? 'barcode');
  const nodes: Node[] = [];

  nodes.push({
    ...base(nextId(), 'Barcode', x, y, width, barHeight),
    kind: 'path',
    d: parts.join(''),
    viewBox: [span, BAR_UNITS],
    fill: { kind: 'solid', color: dark },
    stroke: { ...NO_STROKE },
  });

  if (showText) {
    // KNOWN GAP (EAN-13): the retail convention puts the first digit to the
    // LEFT of the left guard and splits the remaining twelve 6/6 under each
    // half of the symbol. This emits one centred block of all thirteen.
    //
    // Scanners read bars, never the text, so nothing fails to scan -- but it
    // reads as visibly non-standard to anyone who knows retail barcodes, and
    // the geometry above is already set up for the real layout: `shortBar`
    // extends the guard bars down into the text zone for exactly the gaps
    // those digit groups are supposed to sit in. Half the convention is
    // implemented and the label does not use it.
    //
    // Fixing it means three text nodes, not one, positioned off `guards`.
    // Code 128 has no such convention -- one centred line is correct there.
    const textHeight = height - barHeight;
    nodes.push({
      ...base(nextId(), 'Barcode text', x, y + barHeight, width, textHeight),
      kind: 'text',
      text: label,
      fontFamily: 'JetBrains Mono',
      fontSize: round(textHeight * 0.78),
      fontWeight: 500,
      italic: false,
      lineHeight: 1.2,
      letterSpacing: round(width / span),
      align: 'center',
      valign: 'middle',
      color: dark,
      uppercase: false,
    });
  }

  return nodes;
}
