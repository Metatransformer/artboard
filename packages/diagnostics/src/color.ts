/**
 * Colour arithmetic for the contrast checker, kept separate because it is the
 * half that is decidable: given two opaque colours there is exactly one right
 * answer and it is published. The hard, judgement-laden half — *which* two
 * colours — lives in `backdrop.ts`.
 *
 * WCAG 2.x, https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and
 * #dfn-contrast-ratio.
 */

export interface Rgba { r: number; g: number; b: number; a: number }

/** `#rgb`, `#rrggbb`, `#rrggbbaa`. Anything else returns undefined rather than
 *  guessing -- the schema validates hex, but a caller may pass anything. */
export function parseHex(hex: string): Rgba | undefined {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

/** Composite `fg` over `src`, both straight (non-premultiplied). */
export function over(fg: Rgba, src: Rgba): Rgba {
  const a = fg.a + src.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const c = (f: number, s: number) => (f * fg.a + s * src.a * (1 - fg.a)) / a;
  return { r: c(fg.r, src.r), g: c(fg.g, src.g), b: c(fg.b, src.b), a };
}

/** WCAG relative luminance. The 0.03928 cutoff and 2.4 exponent are the
 *  standard's, not a curve fit -- do not "simplify" them. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio, 1..21. Both colours must already be opaque: a translucent
 *  colour has no ratio of its own, only one against a specific backdrop. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Two decimal places, the precision WCAG examples are quoted to. Truncated
 *  rather than rounded: 4.4999 must not present as 4.50 and read as a pass. */
export const quote = (ratio: number): number => Math.floor(ratio * 100) / 100;
