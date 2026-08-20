import { describe, it, expect } from 'vitest';
import { buildNode, type TextNode } from '@artboard/schema';
import {
  layoutText, metricMeasurer, hitTest, objectFit, corners, aabb, round, snap,
  resolveFont, fontVerticalMetrics, FONT_METRICS, DEFAULT_FAMILY,
  MAX_TEXT_CHARS, type Box,
} from '@artboard/engine';

/**
 * Fully-defaulted text node; `over` supplies only what the test cares about.
 * Goes through `buildNode` so every field added to NodeBase arrives for free.
 */
const text = (over: Record<string, unknown> = {}): TextNode =>
  buildNode({
    id: 't', kind: 'text', x: 0, y: 0, width: 200, height: 100,
    fontSize: 10, fontWeight: 400, lineHeight: 1.2, text: '', ...over,
  }) as TextNode;

describe('engine: text wrapping', () => {
  const SENTENCE = 'the quick brown fox jumps over the lazy dog near the river bank';

  /**
   * Assertions here are derived from the measurer rather than from hard-coded
   * glyph widths. Advances come from the real font binaries via ./metrics, so a
   * regenerated table would silently invalidate any number written by hand.
   */
  const widthOf = (node: TextNode, s: string) => metricMeasurer(s, node);

  it('never emits a line wider than the box, except a single unbreakable word', () => {
    for (const width of [40, 80, 150, 300, 600]) {
      const node = text({ text: SENTENCE, width });
      for (const line of layoutText(node).lines) {
        if (line.text.includes(' ')) {
          expect(widthOf(node, line.text), `width=${width} line="${line.text}"`)
            .toBeLessThanOrEqual(Math.max(1, width));
        }
      }
    }
  });

  it('wraps greedily: the next line\u2019s first word would not have fitted on this one', () => {
    const width = 150;
    const node = text({ text: SENTENCE, width });
    const lines = layoutText(node).lines;

    for (let i = 0; i < lines.length - 1; i++) {
      const nextWord = lines[i + 1]!.text.split(' ')[0]!;
      const combined = `${lines[i]!.text} ${nextWord}`;
      expect(widthOf(node, combined), `line ${i} could have taken "${nextWord}"`)
        .toBeGreaterThan(width);
    }
  });

  it('reports each line\u2019s own measured width', () => {
    const node = text({ text: SENTENCE, width: 150 });
    for (const line of layoutText(node).lines) {
      expect(line.width).toBeCloseTo(round(widthOf(node, line.text)), 5);
    }
  });

  it('puts everything on one line when the box is wide enough for the whole string', () => {
    const node = text({ text: SENTENCE, width: 10000 });
    const layout = layoutText(node);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.text).toBe(SENTENCE);
  });

  it('breaks every word onto its own line when the box is narrower than any word', () => {
    const layout = layoutText(text({ text: 'alpha beta gamma delta', width: 1 }));
    expect(layout.lines.map(l => l.text)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  it('loses no words, whatever the box width', () => {
    for (const width of [1, 40, 150, 10000]) {
      const words = layoutText(text({ text: SENTENCE, width })).lines.map(l => l.text).join(' ').split(/\s+/).filter(Boolean);
      expect(words, `width=${width}`).toEqual(SENTENCE.split(' '));
    }
  });

  it('narrowing the box never reduces the line count', () => {
    const counts = [600, 300, 150, 80, 40, 20].map(w => layoutText(text({ text: SENTENCE, width: w })).lines.length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
  });

  it('reports a block height consistent with the line count and line height', () => {
    const layout = layoutText(text({ text: SENTENCE, width: 150, fontSize: 10, lineHeight: 1.5 }));
    expect(layout.lineHeightPx).toBe(15);
    expect(layout.blockHeight).toBe(layout.lines.length * 15);
  });

  it('uppercases the source text when uppercase is set', () => {
    const layout = layoutText(text({ text: 'hi there', width: 5000, uppercase: true }));
    expect(layout.lines[0]!.text).toBe('HI THERE');
  });
});

describe('engine: degenerate boxes', () => {
  it('does not divide by zero or hang on a zero-width box (clamps to 1px)', () => {
    const started = Date.now();
    const layout = layoutText(text({ text: 'aa bb cc', width: 0 }));
    expect(Date.now() - started).toBeLessThan(1000);

    expect(layout.lines.map(l => l.text)).toEqual(['aa', 'bb', 'cc']);
    for (const line of layout.lines) {
      expect(Number.isFinite(line.width)).toBe(true);
      expect(Number.isFinite(line.x)).toBe(true);
      expect(Number.isFinite(line.y)).toBe(true);
    }
    expect(Number.isFinite(layout.blockHeight)).toBe(true);
  });

  it('survives a zero-height, zero-width box with middle valign', () => {
    const layout = layoutText(text({ text: 'x', width: 0, height: 0, valign: 'middle' }));
    expect(Number.isFinite(layout.lines[0]!.y)).toBe(true);
  });

  it('handles empty text', () => {
    const layout = layoutText(text({ text: '', width: 100 }));
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.text).toBe('');
    expect(layout.lines[0]!.width).toBe(0);
  });
});

describe('engine: budget', () => {
  it('sets truncated:true for text over MAX_TEXT_CHARS', () => {
    const layout = layoutText(text({ text: 'a'.repeat(MAX_TEXT_CHARS + 1), width: 100 }));
    expect(layout.truncated).toBe(true);
    expect(layout.lines.map(l => l.text).join('').length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it('leaves truncated:false at exactly MAX_TEXT_CHARS', () => {
    const layout = layoutText(text({ text: 'a'.repeat(MAX_TEXT_CHARS), width: 100 }));
    expect(layout.truncated).toBe(false);
  });

  it('truncates rather than throwing', () => {
    expect(() => layoutText(text({ text: 'a'.repeat(MAX_TEXT_CHARS * 2), width: 100 }))).not.toThrow();
  });
});

describe('engine: hard line breaks', () => {
  it('honours explicit \\n', () => {
    const layout = layoutText(text({ text: 'one\ntwo\nthree', width: 500 }));
    expect(layout.lines.map(l => l.text)).toEqual(['one', 'two', 'three']);
  });

  it('preserves empty lines from consecutive newlines', () => {
    const layout = layoutText(text({ text: 'a\n\nb', width: 500 }));
    expect(layout.lines.map(l => l.text)).toEqual(['a', '', 'b']);
    expect(layout.lines[1]!.width).toBe(0);
  });

  it('preserves a leading and a trailing empty line', () => {
    const layout = layoutText(text({ text: '\nmid\n', width: 500 }));
    expect(layout.lines.map(l => l.text)).toEqual(['', 'mid', '']);
  });

  it('advances the baseline by one line height per line, empty lines included', () => {
    const layout = layoutText(text({ text: 'a\n\nb', width: 500, fontSize: 10, lineHeight: 2 }));
    const ys = layout.lines.map(l => l.y);
    expect(ys[1]! - ys[0]!).toBeCloseTo(20, 5);
    expect(ys[2]! - ys[1]!).toBeCloseTo(20, 5);
  });

  it('combines hard breaks with soft wrapping', () => {
    // width 1 forces every word apart, so the only structure left is the hard break
    const layout = layoutText(text({ text: 'aaa aaa\nbbb', width: 1 }));
    expect(layout.lines.map(l => l.text)).toEqual(['aaa', 'aaa', 'bbb']);
  });
});

describe('engine: vertical alignment', () => {
  const opts = { text: 'one line', width: 500, height: 200, fontSize: 10, lineHeight: 1.2 };

  it('shifts the first baseline downward from top → middle → bottom', () => {
    const top = layoutText(text({ ...opts, valign: 'top' })).lines[0]!.y;
    const middle = layoutText(text({ ...opts, valign: 'middle' })).lines[0]!.y;
    const bottom = layoutText(text({ ...opts, valign: 'bottom' })).lines[0]!.y;

    expect(top).toBeLessThan(middle);
    expect(middle).toBeLessThan(bottom);
  });

  it('places the top baseline just below the box top (ascent only)', () => {
    const layout = layoutText(text({ ...opts, valign: 'top' }));
    expect(layout.lines[0]!.y).toBeCloseTo(round(10 * 0.79), 5);
  });

  it('centres the block for middle and bottom-aligns it for bottom', () => {
    const mid = layoutText(text({ ...opts, valign: 'middle' }));
    const bot = layoutText(text({ ...opts, valign: 'bottom' }));
    const ascent = 10 * 0.79;
    expect(mid.lines[0]!.y).toBeCloseTo((200 - mid.blockHeight) / 2 + ascent, 5);
    expect(bot.lines[0]!.y).toBeCloseTo(200 - bot.blockHeight + ascent, 5);
  });

  it('makes valign a no-op when the block exactly fills the box', () => {
    const exact = { text: 'x', width: 500, height: 12, fontSize: 10, lineHeight: 1.2 };
    expect(layoutText(text({ ...exact, valign: 'top' })).lines[0]!.y)
      .toBeCloseTo(layoutText(text({ ...exact, valign: 'bottom' })).lines[0]!.y, 5);
  });
});

describe('engine: horizontal alignment', () => {
  it('sets line.x to 0 / width÷2 / width for left / center / right', () => {
    const opts = { text: 'a\nbb', width: 300, fontSize: 8 };
    expect(layoutText(text({ ...opts, align: 'left' })).lines.map(l => l.x)).toEqual([0, 0]);
    expect(layoutText(text({ ...opts, align: 'center' })).lines.map(l => l.x)).toEqual([150, 150]);
    expect(layoutText(text({ ...opts, align: 'right' })).lines.map(l => l.x)).toEqual([300, 300]);
  });

  it('does not let alignment change the line breaking', () => {
    const of = (align: string) => layoutText(text({ text: 'aaa aaa aaa', width: 40, fontSize: 10, fontWeight: 400, align })).lines.map(l => l.text);
    expect(of('center')).toEqual(of('left'));
    expect(of('right')).toEqual(of('left'));
  });
});

describe('engine: hit testing', () => {
  const box: Box = { x: 0, y: 0, width: 100, height: 20, rotation: 0 };

  it('returns true inside and false outside an unrotated box', () => {
    expect(hitTest(box, 50, 10)).toBe(true);
    expect(hitTest(box, 0, 0)).toBe(true);
    expect(hitTest(box, 100, 20)).toBe(true);
    expect(hitTest(box, 150, 10)).toBe(false);
    expect(hitTest(box, 50, 40)).toBe(false);
    expect(hitTest(box, -1, 10)).toBe(false);
  });

  it('accounts for rotation: a point inside the unrotated box can miss the rotated one', () => {
    const rotated: Box = { ...box, rotation: 45 };
    // (2,2) sits inside the axis-aligned box …
    expect(hitTest(box, 2, 2)).toBe(true);
    // … but the 45° rotation swings that corner away from it
    expect(hitTest(rotated, 2, 2)).toBe(false);
  });

  it('keeps the centre inside under any rotation (rotation is about the centre)', () => {
    for (const rotation of [0, 15, 45, 90, 180, 270, -30, 361]) {
      expect(hitTest({ ...box, rotation }, 50, 10)).toBe(true);
    }
  });

  it('hits a point that only the rotated box covers', () => {
    // straight up from the centre: outside the 20px-tall flat box, inside once rotated 90°
    expect(hitTest(box, 50, 45)).toBe(false);
    expect(hitTest({ ...box, rotation: 90 }, 50, 45)).toBe(true);
  });

  it('agrees with the rotated corner positions', () => {
    const rotated: Box = { ...box, rotation: 45 };
    for (const [cx, cy] of corners(rotated)) {
      // nudge each rotated corner towards the centre; it must be a hit
      expect(hitTest(rotated, cx + (50 - cx) * 0.05, cy + (10 - cy) * 0.05)).toBe(true);
    }
  });

  it('grows the AABB when a box is rotated', () => {
    const flat = aabb(box);
    const tilted = aabb({ ...box, rotation: 45 });
    expect(flat.width).toBeCloseTo(100, 5);
    expect(tilted.height).toBeGreaterThan(flat.height);
    expect(tilted.width).toBeLessThan(flat.width);
  });
});

describe('engine: objectFit', () => {
  const inSource = (crop: { x: number; y: number; width: number; height: number }, sw: number, sh: number) => {
    expect(crop.width).toBeGreaterThan(0);
    expect(crop.height).toBeGreaterThan(0);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(sw + 1e-9);
    expect(crop.y + crop.height).toBeLessThanOrEqual(sh + 1e-9);
  };

  it('cover crops a landscape source horizontally to match the destination aspect', () => {
    const crop = objectFit(200, 100, 100, 100, 'cover');
    expect(crop).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    inSource(crop, 200, 100);
    expect(crop.width / crop.height).toBeCloseTo(1, 5);
  });

  it('cover crops a portrait source vertically to match the destination aspect', () => {
    const crop = objectFit(100, 200, 100, 100, 'cover');
    expect(crop).toEqual({ x: 0, y: 50, width: 100, height: 100 });
    inSource(crop, 100, 200);
    expect(crop.width / crop.height).toBeCloseTo(1, 5);
  });

  it('cover always matches the destination aspect ratio and stays centred', () => {
    const cases: Array<[number, number, number, number]> = [
      [800, 600, 400, 400], [600, 800, 400, 400], [1000, 100, 200, 400], [100, 1000, 400, 200],
    ];
    for (const [sw, sh, dw, dh] of cases) {
      const crop = objectFit(sw, sh, dw, dh, 'cover');
      inSource(crop, sw, sh);
      expect(crop.width / crop.height).toBeCloseTo(dw / dh, 5);
      expect(crop.x).toBeCloseTo((sw - crop.width) / 2, 5);
      expect(crop.y).toBeCloseTo((sh - crop.height) / 2, 5);
    }
  });

  it('contain uses the whole source for both orientations', () => {
    expect(objectFit(200, 100, 100, 100, 'contain')).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(objectFit(100, 200, 100, 100, 'contain')).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });

  it('fill uses the whole source for both orientations', () => {
    expect(objectFit(200, 100, 30, 90, 'fill')).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(objectFit(100, 200, 90, 30, 'fill')).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });

  it('never returns a zero-sized crop for a degenerate source', () => {
    for (const fit of ['cover', 'contain', 'fill'] as const) {
      const crop = objectFit(0, 0, 100, 100, fit);
      expect(crop.width).toBeGreaterThan(0);
      expect(crop.height).toBeGreaterThan(0);
    }
  });
});

describe('engine: metricMeasurer', () => {
  const node = text({ fontSize: 20, fontWeight: 400, letterSpacing: 0 });

  it('is deterministic: same input, same output', () => {
    const runs = Array.from({ length: 5 }, () => metricMeasurer('The quick brown fox', node));
    expect(new Set(runs).size).toBe(1);
  });

  it('measures wider text wider', () => {
    expect(metricMeasurer('aaaa', node)).toBeGreaterThan(metricMeasurer('aa', node));
    expect(metricMeasurer('mmmm', node)).toBeGreaterThan(metricMeasurer('iiii', node));
    expect(metricMeasurer('WWW', node)).toBeGreaterThan(metricMeasurer('lll', node));
  });

  it('measures the empty string as zero', () => {
    expect(metricMeasurer('', node)).toBe(0);
  });

  it('scales with font size', () => {
    const small = metricMeasurer('hello', text({ fontSize: 10, fontWeight: 400 }));
    const large = metricMeasurer('hello', text({ fontSize: 20, fontWeight: 400 }));
    expect(large).toBeCloseTo(small * 2, 5);
  });

  it('grows with letter spacing and with font weight', () => {
    const plain = metricMeasurer('hello', text({ fontSize: 20, fontWeight: 400, letterSpacing: 0 }));
    expect(metricMeasurer('hello', text({ fontSize: 20, fontWeight: 400, letterSpacing: 3 }))).toBeGreaterThan(plain);
    expect(metricMeasurer('hello', text({ fontSize: 20, fontWeight: 900, letterSpacing: 0 }))).toBeGreaterThan(plain);
  });

  it('gives layoutText stable output across repeated calls', () => {
    const opts = { text: 'the quick brown fox jumps over the lazy dog', width: 120, fontSize: 14 };
    const a = JSON.stringify(layoutText(text(opts)));
    const b = JSON.stringify(layoutText(text(opts)));
    expect(a).toBe(b);
    expect(layoutText(text(opts)).lines.length).toBeGreaterThan(1);
  });
});

describe('engine: numeric helpers', () => {
  it('rounds to two decimal places', () => {
    expect(round(1.234)).toBe(1.23);
    expect(round(1.239)).toBe(1.24);
    expect(round(1 / 3)).toBe(0.33);
    expect(round(-2.348)).toBe(-2.35);
    expect(round(7)).toBe(7);
  });

  it('snaps to a grid and passes values through when the grid is zero', () => {
    expect(snap(23, 10)).toBe(20);
    expect(snap(26, 10)).toBe(30);
    expect(snap(23.7, 0)).toBe(23.7);
  });
});

describe('engine: font resolution', () => {
  it('resolves a known family and weight exactly', () => {
    const match = resolveFont(DEFAULT_FAMILY, 400);
    expect(match).toMatchObject({ family: DEFAULT_FAMILY, weight: 400, fallback: 'exact' });
    expect(match.requestedFamily).toBe(DEFAULT_FAMILY);
  });

  it('treats quoting, casing and whitespace as the same family', () => {
    const canonical = resolveFont('Playfair Display', 400);
    for (const spelling of ["'Playfair Display'", '  playfair   display ', '"Playfair Display", serif']) {
      expect(resolveFont(spelling, 400), spelling).toMatchObject({ family: canonical.family, fallback: 'exact' });
    }
  });

  it('falls back to the nearest weight the family actually ships', () => {
    // DM Serif Display ships one weight, so every request lands on it
    const match = resolveFont('DM Serif Display', 900);
    expect(match.family).toBe('DM Serif Display');
    expect(match.weight).toBe(400);
    expect(match.fallback).toBe('weight');
  });

  it('falls back to the default family for an unknown one', () => {
    const match = resolveFont('Definitely Not A Font', 400);
    expect(match.family).toBe(DEFAULT_FAMILY);
    expect(match.fallback).toBe('family');
    expect(match.requestedFamily).toBe('Definitely Not A Font');
  });

  it('only ever resolves to a weight the family declares', () => {
    for (const [family, metrics] of Object.entries(FONT_METRICS)) {
      const available = Object.keys(metrics.weights).map(Number);
      for (const requested of [100, 350, 450, 550, 1000]) {
        const match = resolveFont(family, requested);
        expect(available, `${family}@${requested}`).toContain(match.weight);
      }
    }
  });

  it('is stable: resolving the same request twice gives the same match', () => {
    expect(resolveFont('Space Grotesk', 620)).toEqual(resolveFont('Space Grotesk', 620));
  });

  it('exposes real vertical metrics, with a negative descender', () => {
    for (const family of Object.keys(FONT_METRICS)) {
      const vm = fontVerticalMetrics(family, 400);
      expect(vm.ascender, family).toBeGreaterThan(0);
      expect(vm.descender, family).toBeLessThan(0);
      expect(vm.lineGap, family).toBeGreaterThanOrEqual(0);
      expect(vm.naturalLineHeight, family).toBeCloseTo(vm.ascender - vm.descender + vm.lineGap, 3);
    }
  });
});

describe('engine: layout diagnostics', () => {
  it('warns FONT_SUBSTITUTED when the requested family has no metrics', () => {
    const layout = layoutText(text({ text: 'hello', fontFamily: 'Nonexistent Sans' }));

    const diag = layout.diagnostics.find(d => d.code === 'FONT_SUBSTITUTED');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('warn');
    expect(diag!.nodeId).toBe('t');
    expect(diag!.message).toContain('Nonexistent Sans');
    expect(layout.font.fallback).toBe('family');
  });

  it('stays silent for a known family, even when the weight is substituted', () => {
    const exact = layoutText(text({ text: 'hello', fontFamily: DEFAULT_FAMILY, fontWeight: 400 }));
    expect(exact.diagnostics).toEqual([]);
    expect(exact.font.fallback).toBe('exact');

    // a missing weight is routine and must not nag
    const nearest = layoutText(text({ text: 'hello', fontFamily: 'DM Serif Display', fontWeight: 900 }));
    expect(nearest.diagnostics).toEqual([]);
    expect(nearest.font.fallback).toBe('weight');
  });

  it('reports the font it actually measured with on every layout', () => {
    const layout = layoutText(text({ text: 'hello', fontFamily: 'Playfair Display', fontWeight: 700 }));
    expect(layout.font).toMatchObject({ family: 'Playfair Display', weight: 700, requestedWeight: 700 });
  });

  it('measures different families differently', () => {
    const wide = metricMeasurer('lllllllll', text({ fontFamily: 'JetBrains Mono', fontSize: 20 }));
    const narrow = metricMeasurer('lllllllll', text({ fontFamily: DEFAULT_FAMILY, fontSize: 20 }));
    expect(wide).not.toBeCloseTo(narrow, 3);   // a monospace 'l' is far wider than a proportional one
  });

  it('measures an unknown codepoint with the family fallback width rather than zero', () => {
    const node = text({ fontSize: 100, fontFamily: DEFAULT_FAMILY, fontWeight: 400 });
    expect(metricMeasurer('\u{1F600}', node)).toBeGreaterThan(0);
  });
});
