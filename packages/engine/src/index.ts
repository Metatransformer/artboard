import type { TextNode } from '@artboard/schema';

/**
 * The engine owns ALL geometry. Renderers only paint what it returns.
 * A renderer that measures text is a bug.
 */

export class LayoutBudgetExceededError extends Error {
  constructor(public chars: number) { super(`Text too long to lay out (${chars} chars).`); this.name = 'LayoutBudgetExceededError'; }
}

export const MAX_TEXT_CHARS = 20000;

export interface Measurer { (text: string, node: TextNode): number; }

/** Deterministic fallback measurer. Used in Node and for golden tests — never touches the OS. */
const WIDTH_TABLE: Record<string, number> = { i: .28, l: .28, j: .3, t: .36, f: .34, r: .38, I: .3, '.': .28, ',': .28, "'": .22, '"': .38, ' ': .27, m: .88, w: .8, M: .86, W: .92 };
export const metricMeasurer: Measurer = (text, node) => {
  let units = 0;
  for (const ch of text) units += WIDTH_TABLE[ch] ?? (ch >= 'A' && ch <= 'Z' ? .66 : .53);
  const weightFactor = 1 + (node.fontWeight - 400) * 0.00018;
  return units * node.fontSize * weightFactor + Math.max(0, text.length - 1) * node.letterSpacing;
};

export interface TextLine { text: string; width: number; x: number; y: number; }
export interface TextLayout {
  lines: TextLine[];
  lineHeightPx: number;
  blockHeight: number;
  truncated: boolean;
}

export function layoutText(node: TextNode, measure: Measurer = metricMeasurer): TextLayout {
  let source = node.uppercase ? node.text.toUpperCase() : node.text;
  let truncated = false;
  if (source.length > MAX_TEXT_CHARS) { source = source.slice(0, MAX_TEXT_CHARS); truncated = true; }

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

  return { lines, lineHeightPx, blockHeight, truncated };
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
