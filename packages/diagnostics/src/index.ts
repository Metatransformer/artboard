import type { Artboard, Diagnostic, Document, Fill, Node, TextNode } from '@artboard/schema';
import { layoutText } from '@artboard/engine';
import { parseHex, over, contrastRatio, quote, type Rgba } from './color';
import { backdropOf, paintOrder } from './backdrop';

export { contrastRatio, relativeLuminance, parseHex, quote } from './color';
export { backdropOf, type Backdrop } from './backdrop';

export interface CheckOptions {
  /** Conformance level to hold text to. AA is the legal bar nearly everywhere
   *  and the default; AAA is a deliberate opt-in because it fails a lot of
   *  perfectly reasonable brand colour. */
  level?: 'AA' | 'AAA';
  /** Report text whose backdrop could not be determined. Off by default: on an
   *  image-heavy document it is one message per text node and says nothing
   *  actionable. On when you are auditing, rather than exporting. */
  reportUnknown?: boolean;
}

/* ── thresholds ──────────────────────────────────────────────────────────── */

/** WCAG "large text": >=18pt, or >=14pt bold, expressed in CSS px as the
 *  standard's own note does (24px / 18.66px). */
const isLarge = (n: TextNode) => n.fontSize >= 24 || (n.fontSize >= 18.66 && n.fontWeight >= 700);
const required = (level: 'AA' | 'AAA', large: boolean) =>
  level === 'AAA' ? (large ? 4.5 : 7) : (large ? 3 : 4.5);

/** Below this, type is not small -- it is unreadable at any print size. Set
 *  low deliberately: 12px body text is a design choice, 6px is a mistake. */
const MIN_FONT_SIZE = 8;
/*
 * THERE IS DELIBERATELY NO LINE-HEIGHT CHECK.
 *
 * The first version flagged `lineHeight < 1.1`. Run over the 28 golden
 * documents it produced 15 findings, and after restricting it to text that
 * actually wraps, 10 -- every one of them a multi-line display heading set
 * between 0.98 and 1.08. That is not a defect, it is how large type is set;
 * tight leading on a headline is correct practice and loose leading is what
 * looks wrong.
 *
 * The mechanical version of the question -- does line N's descender ink reach
 * line N+1's ascender ink -- is answerable, but not from the metrics this
 * engine exposes. `fontVerticalMetrics` gives ascender, descender and lineGap;
 * collision depends on CAP HEIGHT and on which glyph classes are actually
 * present on each line (a line with no descenders cannot collide with
 * anything). Using ascender + |descender| instead flags everything below
 * ~1.21em, which is worse. Any other number is a rule of thumb wearing the
 * costume of a measurement.
 *
 * So this is left to the human. A checker that is confidently wrong about
 * typography teaches people to ignore it, and then it is also wrong about
 * contrast, where it was right.
 */
/** Above this, the eye loses its place returning to the next line. Applied
 *  only to text that actually wrapped -- a long single-line heading is a
 *  heading, not a paragraph, and flagging it is noise. */
const MAX_LINE_CHARS = 90;

/* ── contrast ────────────────────────────────────────────────────────────── */

const fillColors = (fill: Fill | undefined): Rgba[] | undefined => {
  if (!fill || fill.kind === 'none') return undefined;
  if (fill.kind === 'solid') { const c = parseHex(fill.color); return c ? [c] : undefined; }
  const s = fill.stops.map(x => parseHex(x.color)).filter((c): c is Rgba => !!c);
  return s.length ? s : undefined;
};

/** The colours the glyphs are actually painted in. `fill` wins over `color`. */
function textColors(n: TextNode): Rgba[] | undefined {
  const via = fillColors((n as any).fill);
  if (via) return via;
  const c = parseHex(n.color);
  return c ? [c] : undefined;
}

const label = (n: TextNode) =>
  (n.name || n.text.replace(/\s+/g, ' ').trim().slice(0, 32) || n.id);

function contrastDiagnostics(artboard: Artboard, n: TextNode, opts: Required<CheckOptions>): Diagnostic[] {
  if (!n.text.trim()) return [];
  const fg = textColors(n);
  if (!fg) return [];                                   // fill:none -- invisible, not low-contrast

  const backdrop = backdropOf(artboard, n as unknown as Node);
  if (backdrop.kind === 'unknown') {
    return opts.reportUnknown ? [{
      level: 'info', code: 'CONTRAST_UNKNOWN', nodeId: n.id,
      message: `Cannot check the contrast of "${label(n)}": ${backdrop.why}. Check it by eye.`,
    }] : [];
  }

  // The text's own opacity dims it toward its backdrop, which lowers contrast
  // exactly as a translucent fill would. Worst case over every combination.
  const alpha = (n as any).opacity ?? 1;
  let worst = Infinity, found = false;
  for (const bg of backdrop.colors) {
    for (const c of fg) {
      const painted = over({ ...c, a: c.a * alpha }, bg);
      const ratio = contrastRatio(painted, bg);
      if (ratio < worst) { worst = ratio; found = true; }
    }
  }
  if (!found) return [];

  const large = isLarge(n);
  const need = required(opts.level, large);
  if (worst >= need) return [];

  const spread = backdrop.colors.length > 1 ? ' at its worst point' : '';
  return [{
    level: 'warn', code: `CONTRAST_${opts.level}`, nodeId: n.id,
    message: `"${label(n)}" has a contrast ratio of ${quote(worst)}:1 against ${backdrop.source}${spread}, below the ${need}:1 that WCAG ${opts.level} requires for ${large ? 'large' : 'body'} text (${n.fontSize}px${n.fontWeight >= 700 ? ' bold' : ''}).`,
  }];
}

/* ── typography ──────────────────────────────────────────────────────────── */

function typographyDiagnostics(n: TextNode): Diagnostic[] {
  if (!n.text.trim()) return [];
  const out: Diagnostic[] = [];

  if (n.fontSize < MIN_FONT_SIZE) out.push({
    level: 'warn', code: 'TEXT_TOO_SMALL', nodeId: n.id,
    message: `"${label(n)}" is set at ${n.fontSize}px, below the ${MIN_FONT_SIZE}px floor for legible text.`,
  });

  // Measured, not estimated: `layoutText` does the real line breaking with the
  // real font metrics, so both checks below count what will actually land on a
  // line rather than dividing width by a guessed average glyph.
  const lines = layoutText(n).lines;

  // Line length is about the relationship BETWEEN lines, so it needs more than
  // one: a long single-line heading is a heading, not a paragraph.
  if (lines.length > 1) {
    const longest = Math.max(...lines.map(l => l.text.length));
    if (longest > MAX_LINE_CHARS) out.push({
      level: 'info', code: 'LINE_TOO_LONG', nodeId: n.id,
      message: `"${label(n)}" wraps to ${longest} characters per line, above the ~${MAX_LINE_CHARS} at which the eye starts losing its place. Narrow the box or raise the size.`,
    });
  }
  return out;
}

/* ── entry points ────────────────────────────────────────────────────────── */

export function checkArtboard(artboard: Artboard, options: CheckOptions = {}): Diagnostic[] {
  const opts: Required<CheckOptions> = {
    level: options.level ?? 'AA',
    reportUnknown: options.reportUnknown ?? false,
  };
  const out: Diagnostic[] = [];
  for (const { node } of paintOrder(artboard)) {
    if ((node as any).kind !== 'text') continue;
    const t = node as unknown as TextNode;
    out.push(...contrastDiagnostics(artboard, t, opts), ...typographyDiagnostics(t));
  }
  return out;
}

export function checkDocument(doc: Document, options: CheckOptions = {}): Diagnostic[] {
  return (doc.artboards as Artboard[]).flatMap(ab => checkArtboard(ab, options));
}
