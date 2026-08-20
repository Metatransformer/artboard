/**
 * The geometric shape catalogue.
 *
 * Everything regular — polygons, stars, rings — is COMPUTED, not typed out.
 * Hand-written path data for a heptagon is a transcription error waiting to
 * happen, and it cannot be re-tuned (a star whose valleys are slightly too deep
 * stays that way forever). Only the organic shapes, which have no formula, are
 * written by hand.
 *
 * Every shape is drawn in a **0..100 box** (`PathNode.viewBox = [100, 100]`),
 * so a shape is scaled to whatever size the node is. Coordinates round to 3 dp
 * so the same call always produces the same string, which is what lets these
 * appear in a golden test.
 *
 * Shapes are FILLED (`stroke: false`). Icons are stroked. That distinction is
 * the whole reason `Shape.stroke` and `Icon.stroke` exist: rendering a filled
 * shape as an outline loses it, and filling a stroked icon turns it into a
 * black blob.
 */

const C = 50;

/** 3-dp rounding with no `-0`, formatted without trailing zeros. */
const r3 = (v: number): number => {
  const n = Math.round(v * 1000) / 1000;
  return Object.is(n, -0) ? 0 : n;
};

const pt = (radius: number, angle: number): [number, number] =>
  [C + radius * Math.cos(angle), C + radius * Math.sin(angle)];

const poly = (points: Array<[number, number]>): string =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r3(x)} ${r3(y)}`).join(' ') + ' Z';

/** A regular n-gon, first vertex at 12 o'clock, wound clockwise on screen. */
export function polygonPath(sides: number, r = 50): string {
  const n = Math.max(3, Math.floor(sides));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push(pt(r, -Math.PI / 2 + (i * 2 * Math.PI) / n));
  return poly(out);
}

/**
 * A star with `points` spikes. `outer` is the tip radius, `inner` the radius of
 * the valleys between them — the smaller `inner` is, the spikier the star.
 */
export function starPath(points: number, outer = 50, inner = 20): string {
  const n = Math.max(3, Math.floor(points));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n * 2; i++) {
    out.push(pt(i % 2 === 0 ? outer : inner, -Math.PI / 2 + (i * Math.PI) / n));
  }
  return poly(out);
}

/**
 * A circle as path data. `cw` picks the winding direction, which is how the
 * ring shapes below punch a hole: an inner subpath wound *against* the outer
 * one sums to zero under the default non-zero fill rule, so it reads as empty
 * rather than as a second filled disc.
 */
export function circlePath(cx: number, cy: number, r: number, cw = true): string {
  const s = cw ? 1 : 0;
  return `M${r3(cx - r)} ${r3(cy)}A${r3(r)} ${r3(r)} 0 1 ${s} ${r3(cx + r)} ${r3(cy)}A${r3(r)} ${r3(r)} 0 1 ${s} ${r3(cx - r)} ${r3(cy)} Z`;
}

export interface Shape {
  id: string;
  name: string;
  /** Path data in the 0..100 box. */
  d: string;
  /** Filled, never stroked — see the note at the top of this file. */
  stroke: false;
}

const shape = (id: string, name: string, d: string): Shape => ({ id, name, d, stroke: false });

export const SHAPES: readonly Shape[] = [
  /* ── regular polygons ─────────────────────────────────────────────────── */
  shape('triangle', 'Triangle', polygonPath(3)),
  shape('diamond', 'Diamond', polygonPath(4)),
  shape('pentagon', 'Pentagon', polygonPath(5)),
  shape('hexagon', 'Hexagon', polygonPath(6)),
  shape('heptagon', 'Heptagon', polygonPath(7)),
  shape('octagon', 'Octagon', polygonPath(8)),
  shape('decagon', 'Decagon', polygonPath(10)),

  /* ── stars ────────────────────────────────────────────────────────────── */
  shape('star-4', '4-point star', starPath(4, 50, 15)),
  shape('star-5', '5-point star', starPath(5, 50, 21)),
  shape('star-6', '6-point star', starPath(6, 50, 27)),
  shape('star-8', '8-point star', starPath(8, 50, 30)),
  shape('sparkle', 'Sparkle', starPath(4, 50, 7)),
  shape('burst', 'Burst', starPath(12, 50, 39)),

  /* ── rings and frames (hole = opposite winding) ───────────────────────── */
  shape('ring', 'Ring', circlePath(50, 50, 48, true) + circlePath(50, 50, 27, false)),
  shape('frame', 'Frame', 'M4 4 H96 V96 H4 Z M20 20 V80 H80 V20 Z'),
  shape('crescent', 'Crescent', circlePath(50, 50, 46, true) + circlePath(72, 50, 38, false)),
  shape('semicircle', 'Semicircle', 'M2 74 A48 48 0 0 1 98 74 Z'),
  shape('quarter', 'Quarter circle', 'M8 92 V8 A84 84 0 0 1 92 92 Z'),
  shape('pill', 'Pill', 'M28 22 H72 A28 28 0 0 1 72 78 H28 A28 28 0 0 1 28 22 Z'),

  /* ── arrows and chevrons ──────────────────────────────────────────────── */
  shape('arrow-right', 'Arrow right', 'M4 36 H58 V16 L96 50 L58 84 V64 H4 Z'),
  shape('arrow-left', 'Arrow left', 'M96 36 H42 V16 L4 50 L42 84 V64 H96 Z'),
  shape('arrow-up', 'Arrow up', 'M36 96 V42 H16 L50 4 L84 42 H64 V96 Z'),
  shape('arrow-down', 'Arrow down', 'M36 4 V58 H16 L50 96 L84 58 H64 V4 Z'),
  shape('chevron', 'Chevron', 'M10 6 L54 50 L10 94 H46 L90 50 L46 6 Z'),
  shape('cross', 'Cross', 'M36 4 H64 V36 H96 V64 H64 V96 H36 V64 H4 V36 H36 Z'),

  /* ── speech and banners ───────────────────────────────────────────────── */
  shape('speech-round', 'Speech bubble',
    'M20 8 H80 A16 16 0 0 1 96 24 V60 A16 16 0 0 1 80 76 H44 L24 94 V76 H20 A16 16 0 0 1 4 60 V24 A16 16 0 0 1 20 8 Z'),
  shape('speech-square', 'Square bubble', 'M4 8 H96 V72 H40 L20 92 V72 H4 Z'),
  shape('thought', 'Thought bubble',
    'M32 12 C40 6 56 4 66 10 C78 6 92 14 92 26 C98 32 98 44 90 50 C86 62 70 68 58 64 C48 70 32 68 26 60 C12 60 4 48 8 36 C10 26 20 18 32 12 Z'
    + circlePath(34, 78, 8) + circlePath(16, 92, 6)),
  shape('banner', 'Banner', 'M0 26 H100 L86 50 L100 74 H0 L14 50 Z'),
  shape('ribbon', 'Ribbon', 'M10 6 H90 V94 L50 70 L10 94 Z'),
  shape('tag', 'Tag', 'M52 4 H90 A6 6 0 0 1 96 10 V48 L48 96 L4 52 Z'),

  /* ── organic ──────────────────────────────────────────────────────────── */
  shape('heart', 'Heart',
    'M50 91 C44 84 10 62 10 38 C10 22 24 12 38 12 C45 12 50 17 50 22 C50 17 55 12 62 12 C76 12 90 22 90 38 C90 62 56 84 50 91 Z'),
  shape('teardrop', 'Teardrop', 'M50 4 C68 26 84 42 84 58 A34 34 0 0 1 16 58 C16 42 32 26 50 4 Z'),
  shape('shield', 'Shield', 'M50 4 L92 18 V48 C92 72 74 90 50 96 C26 90 8 72 8 48 V18 Z'),
  shape('bolt', 'Lightning bolt', 'M58 4 L16 58 H42 L38 96 L84 40 H56 Z'),
  shape('cloud', 'Cloud',
    'M24 80 C12 80 4 71 4 60 C4 50 11 42 20 40 C22 24 36 12 52 12 C66 12 78 21 82 34 C92 36 98 45 98 55 C98 69 87 80 74 80 Z'),
  shape('blob-1', 'Blob',
    'M78 14 C90 26 96 44 90 60 C84 76 68 90 50 92 C32 94 14 84 8 68 C2 52 6 32 18 20 C30 8 50 4 62 6 C68 7 74 10 78 14 Z'),
  shape('blob-2', 'Pebble',
    'M50 4 C72 4 94 18 96 40 C98 62 82 84 60 92 C38 100 12 90 6 70 C0 50 10 26 26 14 C34 8 42 4 50 4 Z'),
  shape('blob-3', 'Splat',
    'M30 8 C52 0 80 8 90 28 C100 48 92 74 74 86 C56 98 30 96 16 82 C2 68 0 42 10 24 C14 17 22 11 30 8 Z'),
];
