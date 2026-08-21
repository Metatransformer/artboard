import type { Artboard, Fill, Node } from '@artboard/schema';
import { aabb } from '@artboard/engine';
import { parseHex, over, type Rgba } from './color';

/**
 * WHAT IS BEHIND THIS TEXT?
 *
 * This is the judgement half of the contrast checker, and it is the part that
 * can be confidently wrong. Comparing a text colour against `artboard.background`
 * regardless of what is stacked in between produces a clean number for the
 * wrong reason, and a clean wrong number is worse than no number: nobody
 * re-checks a checker that answers.
 *
 * So this resolver only reports a colour when it can SHOW that colour is what
 * is behind the whole text box, and returns `unknown` with a reason otherwise.
 * The caller is expected to report "cannot determine" rather than guess.
 *
 * ── what it can see ───────────────────────────────────────────────────────
 *   - an unrotated rect that fully contains the text box
 *   - an ellipse that contains all four corners of the text box
 *   - the artboard background, when nothing is stacked in between
 *   - translucency: a covering shape with opacity < 1, or an `#rrggbbaa`
 *     fill, is composited over whatever this same resolver finds beneath it
 *   - gradients: every stop is returned, and the caller takes the worst case
 *
 * ── what it cannot, and says so ───────────────────────────────────────────
 *   - images: no pixels here, and a photo has no single colour anyway
 *   - paths: arbitrary geometry; "the bounding box overlaps" is not coverage
 *   - a shape that covers the text box only PARTIALLY -- the text straddles a
 *     boundary and has two different contrast ratios
 *   - a ROTATED covering shape: its bounding box containing the text box does
 *     not mean the shape does. Refusing here costs a few real answers and
 *     avoids asserting a colour that is not there.
 *
 * Text and lines are never treated as backdrops: glyphs and hairlines are
 * sparse, so "behind" them is mostly still whatever is behind them.
 */

export type Backdrop =
  | { kind: 'colors'; colors: Rgba[]; source: string }
  | { kind: 'unknown'; why: string };

const OPAQUE_ENOUGH = 0.999;

/** Paint order, nearest-last, with groups flattened and opacity accumulated. */
interface Painted { node: Node; alpha: number }

function flatten(nodes: readonly Node[], alpha: number, out: Painted[]): void {
  for (const n of nodes) {
    if (!(n as any).visible) continue;
    const a = alpha * ((n as any).opacity ?? 1);
    if ((n as any).kind === 'group') flatten(((n as any).children ?? []) as Node[], a, out);
    else out.push({ node: n, alpha: a });
  }
}

export function paintOrder(artboard: Artboard): Painted[] {
  const out: Painted[] = [];
  flatten(artboard.nodes as Node[], 1, out);
  return out;
}

const box = (n: any) => aabb({ x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation ?? 0 });
const contains = (o: ReturnType<typeof box>, i: ReturnType<typeof box>) =>
  o.x <= i.x && o.y <= i.y && o.x + o.width >= i.x + i.width && o.y + o.height >= i.y + i.height;
const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every colour a fill can paint. A gradient contributes all of its stops. */
function fillColors(fill: Fill | undefined): Rgba[] | undefined {
  if (!fill || fill.kind === 'none') return undefined;
  if (fill.kind === 'solid') { const c = parseHex(fill.color); return c ? [c] : undefined; }
  const stops = fill.stops.map(s => parseHex(s.color)).filter((c): c is Rgba => !!c);
  return stops.length ? stops : undefined;
}

/** All four corners of `inner` inside the ellipse inscribed in `outer`. */
function ellipseContains(outer: any, inner: ReturnType<typeof box>): boolean {
  if ((outer.rotation ?? 0) !== 0) return false;
  const rx = outer.width / 2, ry = outer.height / 2;
  const cx = outer.x + rx, cy = outer.y + ry;
  if (rx <= 0 || ry <= 0) return false;
  const corners: Array<[number, number]> = [
    [inner.x, inner.y], [inner.x + inner.width, inner.y],
    [inner.x, inner.y + inner.height], [inner.x + inner.width, inner.y + inner.height],
  ];
  return corners.every(([px, py]) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1);
}

/** The artboard's own background, which is always fully behind everything. */
function artboardBackdrop(artboard: Artboard): Backdrop {
  const colors = fillColors(artboard.background as Fill);
  return colors
    ? { kind: 'colors', colors, source: 'the artboard background' }
    : { kind: 'unknown', why: 'the artboard background is "none", so the export is transparent there' };
}

/**
 * Resolve what is painted behind `target`, considering only what is painted
 * below it. `stack` is the paint order; `index` is where the search starts.
 */
function resolveFrom(artboard: Artboard, stack: Painted[], index: number, target: ReturnType<typeof box>): Backdrop {
  for (let i = index; i >= 0; i--) {
    const { node, alpha } = stack[i]!;
    const kind = (node as any).kind;
    if (kind === 'text' || kind === 'line') continue;         // too sparse to be a backdrop
    const b = box(node);
    if (!overlaps(b, target)) continue;

    if (kind === 'image') return { kind: 'unknown', why: `an image ("${(node as any).name || node.id}") is behind it` };
    if (kind === 'path') return { kind: 'unknown', why: `a path ("${(node as any).name || node.id}") is behind it` };

    const covers = kind === 'ellipse' ? ellipseContains(node, target)
      : ((node as any).rotation ?? 0) === 0 && contains(b, target);
    if (!covers) {
      return { kind: 'unknown', why: `"${(node as any).name || node.id}" covers only part of it, so the text sits on two different backgrounds` };
    }

    const colors = fillColors((node as any).fill);
    if (!colors) continue;                                     // fill:none paints nothing; keep looking down

    // Translucent? Then the effective colour depends on what is under THIS
    // node, so resolve that first and composite. A gradient over a gradient
    // multiplies the cases, so every combination is returned and the caller
    // takes the worst.
    const minAlpha = Math.min(alpha, ...colors.map(c => c.a));
    if (minAlpha >= OPAQUE_ENOUGH) return { kind: 'colors', colors, source: `"${(node as any).name || node.id}"` };

    const beneath = resolveFrom(artboard, stack, i - 1, target);
    if (beneath.kind === 'unknown') return beneath;
    const composited = colors.flatMap(c => beneath.colors.map(u => over({ ...c, a: c.a * alpha }, u)));
    return { kind: 'colors', colors: composited, source: `"${(node as any).name || node.id}" over ${beneath.source}` };
  }
  return artboardBackdrop(artboard);
}

/** What is behind `node` in `artboard`, or why that cannot be determined. */
export function backdropOf(artboard: Artboard, node: Node): Backdrop {
  const stack = paintOrder(artboard);
  const at = stack.findIndex(p => p.node.id === node.id);
  return resolveFrom(artboard, stack, at - 1, box(node));
}
