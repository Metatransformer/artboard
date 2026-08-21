import type { Diagnostic, TextNode } from '@artboard/schema';
import { DEFAULT_FAMILY, FONT_METRICS, type FamilyMetrics, type WeightMetrics } from './metrics';

/**
 * The engine owns ALL geometry. Renderers only paint what it returns.
 * A renderer that measures text is a bug.
 */

export class LayoutBudgetExceededError extends Error {
  constructor(public chars: number) { super(`Text too long to lay out (${chars} chars).`); this.name = 'LayoutBudgetExceededError'; }
}

export const MAX_TEXT_CHARS = 20000;

export interface Measurer { (text: string, node: TextNode): number; }

/* ── font resolution ────────────────────────────────────────────────────────
 *
 * Widths come from `./metrics`, generated from the real font binaries by
 * `npm run metrics`. Nothing here reads a file, touches the network, or asks
 * the OS: same input, same number, on every machine.
 */

export { FONT_METRICS, DEFAULT_FAMILY, type FamilyMetrics, type WeightMetrics } from './metrics';

/** How far down the fallback chain a measurement had to go. */
export type FontFallback =
  | 'exact'    // this family, this weight, straight from the table
  | 'weight'   // this family, nearest weight it can supply
  | 'family';  // family unknown → DEFAULT_FAMILY, nearest weight

/** What `metricMeasurer` actually measured with. Never silent — see `layoutText`. */
export interface FontMatch {
  readonly requestedFamily: string;
  readonly requestedWeight: number;
  readonly family: string;
  readonly weight: number;
  readonly fallback: FontFallback;
}

interface Resolved { readonly match: FontMatch; readonly family: FamilyMetrics; readonly weight: WeightMetrics; }

const DEFAULT_METRICS = FONT_METRICS[DEFAULT_FAMILY] as FamilyMetrics;

/** `"Playfair Display"`, `'  playfair display '` and `"'Playfair Display', serif"` are the same font. */
const normalise = (family: string): string =>
  ((family ?? '').split(',')[0] ?? '').replace(/["']/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

const CANONICAL = new Map<string, string>(
  Object.keys(FONT_METRICS).map(family => [normalise(family), family]),
);

/**
 * Nearest weight the family can actually supply. Ties go to the lighter weight,
 * which only bites at an exact midpoint (e.g. 450 between 400 and 500).
 * DM Serif Display ships one weight, so every request there lands on 400.
 */
function nearestWeight(metrics: FamilyMetrics, requested: number): number {
  const available = Object.keys(metrics.weights).map(Number).sort((a, b) => a - b);
  let best = available[0] ?? 400, bestDistance = Math.abs(best - requested);
  for (const weight of available) {
    const distance = Math.abs(weight - requested);
    if (distance < bestDistance) { best = weight; bestDistance = distance; }
  }
  return best;
}

const resolveCache = new Map<string, Resolved>();

function resolve(fontFamily: string, fontWeight: number): Resolved {
  const key = `${fontFamily} ${fontWeight}`;
  const cached = resolveCache.get(key);
  if (cached) return cached;

  const canonical = CANONICAL.get(normalise(fontFamily));
  const family = canonical ?? DEFAULT_FAMILY;
  const familyMetrics = FONT_METRICS[family] ?? DEFAULT_METRICS;
  const weight = nearestWeight(familyMetrics, fontWeight);

  const resolved: Resolved = {
    match: {
      requestedFamily: fontFamily, requestedWeight: fontWeight,
      family, weight,
      fallback: canonical === undefined ? 'family' : weight === fontWeight ? 'exact' : 'weight',
    },
    family: familyMetrics,
    weight: familyMetrics.weights[weight] as WeightMetrics,
  };
  resolveCache.set(key, resolved);
  return resolved;
}

/** Which family+weight a given request would actually be measured with. */
export function resolveFont(fontFamily: string, fontWeight: number): FontMatch {
  return resolve(fontFamily, fontWeight).match;
}

/**
 * Real ascender / descender / lineGap for the family that would be used, as a
 * multiple of the font size. `naturalLineHeight` is what the font itself asks
 * for; `layoutText` still honours `node.lineHeight`, but a caller that wants an
 * "auto" line height now has a measured number instead of a guess.
 */
export function fontVerticalMetrics(fontFamily: string, fontWeight: number): {
  ascender: number; descender: number; lineGap: number; naturalLineHeight: number;
} {
  const { family } = resolve(fontFamily, fontWeight);
  return {
    ascender: family.ascender, descender: family.descender,
    lineGap: family.lineGap, naturalLineHeight: family.naturalLineHeight,
  };
}

/**
 * Deterministic measurer. Used in Node and for golden tests — never touches the OS.
 *
 * Advances are real per-glyph widths from the shipped fonts, as a fraction of
 * the em, so the weight is already baked in and there is no fudge factor left.
 * Codepoints outside the sampled set (Latin-1 plus the typographic marks the
 * app can produce) fall back to the family's mean advance. Kerning is out of
 * scope — see docs/FONT-METRICS.md.
 */
export const metricMeasurer: Measurer = (text, node) => {
  const { advances, fallbackWidth } = resolve(node.fontFamily, node.fontWeight).weight;
  let em = 0, glyphs = 0;
  for (const ch of text) { em += advances[ch] ?? fallbackWidth; glyphs++; }
  return em * node.fontSize + Math.max(0, glyphs - 1) * node.letterSpacing;
};

export interface TextLine { text: string; width: number; x: number; y: number; }
export interface TextLayout {
  lines: TextLine[];
  lineHeightPx: number;
  blockHeight: number;
  truncated: boolean;
  /** The family+weight the widths came from. `fallback !== 'exact'` means a substitution happened. */
  font: FontMatch;
  /** `FONT_SUBSTITUTED` when the requested family has no metrics at all. Renderers forward these. */
  diagnostics: Diagnostic[];
}

export function layoutText(node: TextNode, measure: Measurer = metricMeasurer): TextLayout {
  let source = node.uppercase ? node.text.toUpperCase() : node.text;
  let truncated = false;
  if (source.length > MAX_TEXT_CHARS) { source = source.slice(0, MAX_TEXT_CHARS); truncated = true; }

  // A missing weight is routine (DM Serif Display has one); a missing family
  // means the wrap is a guess, and the user deserves to be told.
  const font = resolveFont(node.fontFamily, node.fontWeight);
  const diagnostics: Diagnostic[] = [];
  if (font.fallback === 'family') {
    diagnostics.push({
      level: 'warn', code: 'FONT_SUBSTITUTED', nodeId: node.id,
      message: `No metrics for "${node.fontFamily}"; measured with ${font.family} ${font.weight}. Lines may wrap differently in the browser.`,
    });
  }

  const lineHeightPx = round(node.fontSize * node.lineHeight);
  const maxWidth = Math.max(1, node.width);           // degenerate box → clamp, never divide by zero
  const lines: TextLine[] = [];

  for (const paragraph of source.split('\n')) {
    if (paragraph === '') { lines.push({ text: '', width: 0, x: 0, y: 0 }); continue; }
    const words = paragraph.split(/(\s+)/).filter(w => w !== '');
    let current = '';
    for (const word of words) {
      const candidate = current + word;
      if (current !== '' && measure(candidate.trimEnd(), node) > maxWidth) {
        lines.push({ text: current.trimEnd(), width: 0, x: 0, y: 0 });
        current = word.trimStart();
      } else { current = candidate; }
    }
    lines.push({ text: current.trimEnd(), width: 0, x: 0, y: 0 });
  }

  const blockHeight = round(lines.length * lineHeightPx);
  const vOffset = node.valign === 'middle' ? (node.height - blockHeight) / 2
                : node.valign === 'bottom' ? node.height - blockHeight : 0;

  lines.forEach((ln, i) => {
    ln.width = round(measure(ln.text, node));
    ln.x = node.align === 'center' ? round(node.width / 2)
         : node.align === 'right' ? round(node.width) : 0;
    // baseline: top of line box + ~0.79 of font size approximates the ascent
    ln.y = round(vOffset + i * lineHeightPx + node.fontSize * 0.79);
  });

  return { lines, lineHeightPx, blockHeight, truncated, font, diagnostics };
}

/* ── transforms & hit testing ───────────────────────────────────────────── */
export interface Box { x: number; y: number; width: number; height: number; rotation: number; }

export function corners(b: Box): Array<[number, number]> {
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const r = (b.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return ([[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]] as Array<[number, number]>)
    .map(([px, py]) => { const dx = px - cx, dy = py - cy; return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as [number, number]; });
}

export function aabb(b: Box): { x: number; y: number; width: number; height: number } {
  const pts = corners(b);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * The box a node actually occupies, which for a group is NOT the box it stores.
 *
 * A group owns no geometry of its own: its children carry absolute coordinates
 * and every renderer emits no transform for it. The stored x/y/width/height is
 * a cache written once, at creation, that no writer refreshes -- move a child
 * and the group still reports the box it had the day it was made.
 *
 * Everywhere that box is only drawn, a stale value is a cosmetic lie. Where it
 * is the rotation PIVOT it is a wrong pixel in the exported file, and where it
 * is the selection rectangle it is a control pointing at the wrong place. So
 * nobody reads the stored value: they ask here.
 *
 * Rotation is honoured per child, so a rotated child widens the box exactly as
 * it does on screen, and a nested group contributes its own DERIVED box widened
 * by its OWN rotation. Pushing a nested derived box unrotated is the easy
 * mistake and it is silently close -- it only shows up once something several
 * levels down is turned.
 *
 * An empty group falls back to its stored box: there is nothing to derive from,
 * and the stored value is at least what the editor last showed.
 */
export function nodeBox(node: unknown): { x: number; y: number; width: number; height: number } {
  const n = node as any;
  if (n.kind !== 'group') return { x: n.x, y: n.y, width: n.width, height: n.height };
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (const c of (n.children ?? []) as any[]) {
    const b = nodeBox(c);
    boxes.push(aabb({ x: b.x, y: b.y, width: b.width, height: b.height, rotation: c.rotation ?? 0 }));
  }
  if (!boxes.length) return { x: n.x, y: n.y, width: n.width, height: n.height };
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
}

/* ── magic resize: anchoring ────────────────────────────────────────────────
 *
 * Reflowing a design into another aspect ratio is marketed as AI and is not.
 * It is a rules table, and the whole of the judgement lives in one step:
 * deciding what each node was BOUND to in the frame it was laid out in. Get
 * that right and the rest is arithmetic.
 *
 * These are pure box functions -- no Node, no Document, no recursion -- so the
 * classifier can be tested against nothing but numbers, and a caller can apply
 * the result to a leaf, a group or a whole subtree however it needs to.
 *
 * The failure mode worth designing against: a classifier that answers `centre`
 * for everything is invisible to any test that only asks whether nodes are
 * still on the page. What catches it is asserting the RELATIONSHIP survives --
 * a left-bound node stays left-bound at any target size -- rather than
 * asserting coordinates, which pin one aspect ratio and certify nothing about
 * the 9:16 case the feature exists for.
 * ------------------------------------------------------------------------- */

export type AnchorX = 'left' | 'centre' | 'right' | 'stretch';
export type AnchorY = 'top' | 'middle' | 'bottom' | 'stretch';
export interface Anchors { x: AnchorX; y: AnchorY }

/** Spans this much of an axis or more and it is treated as full-bleed. */
const STRETCH_SPAN = 0.9;
/** Margins this close to equal, as a fraction of the frame, read as centred. */
const CENTRE_BAND = 0.08;

/*
 * Classified from the two MARGINS, not from absolute distance to an edge.
 *
 * The first cut used bands -- centred if the box's centre sat within 6% of the
 * frame's centre, edge-bound if within 8% of an edge, centre otherwise -- and
 * on the first real design it classified all ten nodes `centre/middle`. A
 * kicker 100px down a 1080 frame is 9.3% from the top, so it missed the edge
 * band, was nowhere near the centre band, and fell through the "open field"
 * fallback to centre. Every band-based rule has that hole, and it is invisible
 * to any test that only asks whether nodes are still on the page: a classifier
 * answering one constant passes them all.
 *
 * Comparing the margins has no hole. Either they are close, in which case the
 * node is centred at any size, or one is smaller, in which case that is the
 * edge it was laid out against. Nothing falls between, and no threshold
 * decides whether a node is anchored at all -- only WHICH way.
 */
function axisAnchor(start: number, extent: number, frame: number): 'start' | 'centre' | 'end' | 'stretch' {
  if (frame <= 0) return 'start';
  if (extent / frame >= STRETCH_SPAN) return 'stretch';
  const before = start, after = frame - (start + extent);
  if (Math.abs(before - after) <= CENTRE_BAND * frame) return 'centre';
  return before < after ? 'start' : 'end';
}

/** Which edges a box is bound to, inferred from where it sits in its frame. */
export function classifyAnchors(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): Anchors {
  const ax = axisAnchor(box.x, box.width, frame.width);
  const ay = axisAnchor(box.y, box.height, frame.height);
  return {
    x: ax === 'start' ? 'left' : ax === 'end' ? 'right' : ax === 'stretch' ? 'stretch' : 'centre',
    y: ay === 'start' ? 'top' : ay === 'end' ? 'bottom' : ay === 'stretch' ? 'stretch' : 'middle',
  };
}

/**
 * The uniform factor sizes take. Positions do NOT use it -- they resolve by
 * anchor -- because scaling a position by k is what turns a 1:1 into a 9:16 by
 * leaving everything in the top square, which is the bug this feature is for.
 *
 * `min` is deliberate and it makes resize LOSSY IN THE RETURN DIRECTION. That
 * is a decision, not an oversight, so it is written here rather than left for a
 * user to report:
 *
 *     1080x1080 -> 1080x1920    k = 1        nothing shrinks, which is the point
 *     1080x1920 -> 1080x1080    k = 0.5625   content must fit a shorter frame
 *     net, there and back                    0.5625
 *
 * `min` is what "nothing overflows the new frame" means, and the motivating
 * direction is exactly the one it gets right: widening a square into a story
 * leaves every element at its original size. The return trip genuinely has to
 * shrink -- content that filled 1920 of height cannot also fill 1080 -- so the
 * loss is inherent to relayout and not an artefact of this factor.
 *
 * What makes it acceptable is that the reversible path exists and is a
 * different one: the resize command captures the nodes it replaced, so UNDO
 * restores them exactly rather than recomputing a reciprocal that would drift a
 * hundredth per round trip. "Try a story, dislike it, go back" is Cmd+Z, not a
 * second resize. Making resize itself reversible would mean remembering an
 * original frame on the document -- real state for a modest gain -- and if
 * anyone takes that on, this comment is the record that they are changing a
 * documented behaviour rather than fixing an unnoticed one.
 *
 * Found by the `tests` session, who worked out the arithmetic before the
 * feature shipped rather than after a user hit it.
 */
export function resizeFactor(from: { width: number; height: number }, to: { width: number; height: number }): number {
  if (from.width <= 0 || from.height <= 0) return 1;
  return Math.min(to.width / from.width, to.height / from.height);
}

/** The box a node should occupy in the new frame. */
export function reanchor(
  box: { x: number; y: number; width: number; height: number },
  anchors: Anchors,
  from: { width: number; height: number },
  to: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const k = resizeFactor(from, to);
  const rx = from.width > 0 ? to.width / from.width : 1;
  const ry = from.height > 0 ? to.height / from.height : 1;

  const axis = (
    start: number, extent: number, fromLen: number, toLen: number,
    ratio: number, anchor: 'start' | 'centre' | 'end' | 'stretch',
  ): [number, number] => {
    // A stretch axis takes its own ratio, not k: a full-bleed banner that
    // stopped being full-bleed is the one outcome nobody reads as correct.
    if (anchor === 'stretch') return [round(start * ratio), round(extent * ratio)];
    const size = round(extent * k);
    if (anchor === 'centre') {
      // The CENTRE's fraction of the frame is preserved, not the origin's.
      // Preserving the origin drifts anything off-centre toward the near edge
      // as the frame grows, and the drift is proportional to the node's own
      // width, so wide elements skew more than narrow ones in the same design.
      const centre = (start + extent / 2) / fromLen * toLen;
      return [round(centre - size / 2), size];
    }
    // Margin from the anchored edge, scaled by that axis's ratio. Clamped so a
    // large shrink cannot push a node off the far side of its own frame.
    if (anchor === 'start') return [round(Math.min(start * ratio, Math.max(0, toLen - size))), size];
    const margin = fromLen - (start + extent);
    return [round(Math.max(0, toLen - margin * ratio - size)), size];
  };

  const ax = anchors.x === 'left' ? 'start' : anchors.x === 'right' ? 'end' : anchors.x === 'stretch' ? 'stretch' : 'centre';
  const ay = anchors.y === 'top' ? 'start' : anchors.y === 'bottom' ? 'end' : anchors.y === 'stretch' ? 'stretch' : 'centre';
  const [x, width] = axis(box.x, box.width, from.width, to.width, rx, ax);
  const [y, height] = axis(box.y, box.height, from.height, to.height, ry, ay);
  return { x, y, width, height };
}

/** Point-in-node test in artboard space, accounting for rotation. */
export function hitTest(b: Box, px: number, py: number): boolean {
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const r = (-b.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  const lx = cx + dx * cos - dy * sin, ly = cy + dx * sin + dy * cos;
  return lx >= b.x && lx <= b.x + b.width && ly >= b.y && ly <= b.y + b.height;
}

/** Fit a source rect into a destination rect. Returns the source crop rect. */
export function objectFit(sw: number, sh: number, dw: number, dh: number, fit: 'cover' | 'contain' | 'fill') {
  if (fit === 'fill' || sw <= 0 || sh <= 0) return { x: 0, y: 0, width: sw || 1, height: sh || 1 };
  const sr = sw / sh, dr = dw / dh;
  if (fit === 'cover') {
    if (sr > dr) { const w = sh * dr; return { x: (sw - w) / 2, y: 0, width: w, height: sh }; }
    const h = sw / dr; return { x: 0, y: (sh - h) / 2, width: sw, height: h };
  }
  return { x: 0, y: 0, width: sw, height: sh };
}

export const round = (n: number): number => Math.round(n * 100) / 100;
export const snap = (n: number, grid: number): number => (grid > 0 ? Math.round(n / grid) * grid : n);
