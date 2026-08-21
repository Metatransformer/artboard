import { describe, it, expect } from 'vitest';
import { buildNode, loadDocument, type Artboard, type Node } from '@artboard/schema';
import { checkArtboard, backdropOf, contrastRatio, parseHex, quote } from '@artboard/diagnostics';

/**
 * Two halves, tested differently on purpose.
 *
 * The arithmetic has exactly one right answer, published, so it is checked
 * against values quoted in WCAG and its examples rather than against itself.
 *
 * The backdrop resolution has no published answer -- it is a judgement about
 * what "behind" means -- so what is tested is that it DECLINES in the cases it
 * cannot see. A contrast checker that answers confidently about text sitting on
 * a photograph is worse than one that says it cannot tell, because nobody
 * re-checks a checker that answers.
 */

const ratio = (a: string, b: string) => quote(contrastRatio(parseHex(a)!, parseHex(b)!));

const board = (nodes: Node[], background: any = { kind: 'solid', color: '#ffffff' }): Artboard =>
  loadDocument({
    id: 'd', name: 'd', assets: {},
    artboards: [{ id: 'ab', name: 'ab', width: 400, height: 300, background, nodes }],
  }).doc.artboards[0] as Artboard;

const text = (over: Partial<any> = {}): Node => buildNode({
  id: 't', kind: 'text', x: 50, y: 50, width: 200, height: 40,
  text: 'Readable text', fontSize: 16, fontWeight: 400, color: '#777777', ...over,
});
const rect = (over: Partial<any> = {}): Node => buildNode({
  id: 'r', kind: 'rect', x: 0, y: 0, width: 400, height: 300,
  fill: { kind: 'solid', color: '#000000' }, ...over,
});

const codes = (ab: Artboard, o?: any) => checkArtboard(ab, o).map(d => d.code);

describe('diagnostics: WCAG arithmetic against published values', () => {
  it.each([
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#767676', '#ffffff', 4.54],   // the canonical "just passes AA" grey
    ['#595959', '#ffffff', 7],      // the canonical "just passes AAA" grey
    ['#0000ff', '#ffffff', 8.59],
  ])('%s on %s is %s:1', (fg, bg, want) => {
    expect(ratio(fg, bg)).toBeCloseTo(want as number, 2);
  });

  it('is symmetric -- contrast has no foreground', () => {
    expect(ratio('#123456', '#fedcba')).toBe(ratio('#fedcba', '#123456'));
  });

  it('quotes downward, so a near miss never reads as a pass', () => {
    // 4.4999 must not present as 4.50 next to a "4.5 required".
    expect(quote(4.4999)).toBe(4.49);
  });
});

describe('diagnostics: what counts as large text', () => {
  const onWhite = (over: any) => codes(board([text({ color: '#949494', ...over })]));
  // #949494 on white is ~3.1:1 -- passes AA for large text, fails for body.
  it('holds 16px regular to the body threshold', () => {
    expect(onWhite({ fontSize: 16 })).toContain('CONTRAST_AA');
  });
  it('lets 24px through as large text', () => {
    expect(onWhite({ fontSize: 24 })).not.toContain('CONTRAST_AA');
  });
  it('lets 19px BOLD through, which 19px regular does not get', () => {
    expect(onWhite({ fontSize: 19, fontWeight: 700 })).not.toContain('CONTRAST_AA');
    expect(onWhite({ fontSize: 19, fontWeight: 400 })).toContain('CONTRAST_AA');
  });
  it('holds everything to the stricter bar when asked for AAA', () => {
    expect(codes(board([text({ color: '#767676', fontSize: 16 })]), { level: 'AAA' })).toContain('CONTRAST_AAA');
    expect(codes(board([text({ color: '#767676', fontSize: 16 })]))).not.toContain('CONTRAST_AA');
  });
});

describe('diagnostics: what is behind the text', () => {
  it('uses the artboard background when nothing is stacked in between', () => {
    const b = backdropOf(board([text()]), text());
    expect(b).toMatchObject({ kind: 'colors', source: 'the artboard background' });
  });

  it('uses a covering rect instead of the artboard background', () => {
    // White text would pass on black and fail on the white artboard. If the
    // rect were ignored, this would report a failure that is not there.
    const ab = board([rect(), text({ color: '#ffffff' })]);
    expect(codes(ab)).not.toContain('CONTRAST_AA');
  });

  it('ignores a rect painted ON TOP of the text, which is not behind it', () => {
    const ab = board([text({ color: '#ffffff' }), rect()]);
    expect(codes(ab)).toContain('CONTRAST_AA');
  });

  it('declines when a shape covers the text only partially', () => {
    const ab = board([rect({ width: 100 }), text({ color: '#ffffff' })]);
    expect(backdropOf(ab, text()).kind).toBe('unknown');
    expect(codes(ab, { reportUnknown: true })).toContain('CONTRAST_UNKNOWN');
  });

  it('declines over an image, because there are no pixels here to sample', () => {
    const img = buildNode({ id: 'i', kind: 'image', x: 0, y: 0, width: 400, height: 300, assetId: 'a' });
    const b = backdropOf(board([img, text()]), text());
    expect(b.kind).toBe('unknown');
    expect(b.kind === 'unknown' && b.why).toMatch(/image/);
  });

  it('declines over a rotated cover, whose bounding box is not its shape', () => {
    expect(backdropOf(board([rect({ rotation: 12 }), text()]), text()).kind).toBe('unknown');
  });

  it('takes the worst stop of a gradient rather than an average', () => {
    // Black->white behind mid-grey text: passes at one end, fails at the other.
    const g = { kind: 'gradient', type: 'linear', angle: 90,
      stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
    expect(codes(board([text({ color: '#808080' })], g))).toContain('CONTRAST_AA');
  });

  it('composites a translucent cover over what is beneath it', () => {
    // 50% black over white is mid-grey, so white text fails -- though it would
    // pass against the opaque black the rect claims to be.
    const ab = board([rect({ opacity: 0.5 }), text({ color: '#ffffff' })]);
    const b = backdropOf(ab, text());
    expect(b.kind === 'colors' && b.source).toMatch(/over the artboard background/);
    expect(codes(ab)).toContain('CONTRAST_AA');
  });

  it('dims text by its own opacity, which is a real contrast loss', () => {
    expect(codes(board([text({ color: '#000000' })]))).not.toContain('CONTRAST_AA');
    expect(codes(board([text({ color: '#000000', opacity: 0.25 })]))).toContain('CONTRAST_AA');
  });

  it('sees through a group to the shapes inside it', () => {
    const grouped = buildNode({ id: 'g', kind: 'group', x: 0, y: 0, width: 400, height: 300,
      children: [rect()] });
    expect(codes(board([grouped, text({ color: '#ffffff' })]))).not.toContain('CONTRAST_AA');
  });

  it('says nothing about text it cannot judge unless asked', () => {
    const img = buildNode({ id: 'i', kind: 'image', x: 0, y: 0, width: 400, height: 300, assetId: 'a' });
    expect(codes(board([img, text()]))).toHaveLength(0);
    expect(codes(board([img, text()]), { reportUnknown: true })).toEqual(['CONTRAST_UNKNOWN']);
  });
});

describe('diagnostics: typography', () => {
  it('flags type below the legibility floor', () => {
    expect(codes(board([text({ fontSize: 6, color: '#000000' })]))).toContain('TEXT_TOO_SMALL');
    expect(codes(board([text({ fontSize: 12, color: '#000000' })]))).not.toContain('TEXT_TOO_SMALL');
  });

  it('flags a paragraph whose measured lines run too long', () => {
    const long = text({ color: '#000000', fontSize: 10, width: 900,
      text: 'word '.repeat(120) });
    expect(codes(board([long]))).toContain('LINE_TOO_LONG');
  });

  it('leaves a long single-line heading alone', () => {
    // No wrap means no return sweep, so the rule does not apply.
    const heading = text({ color: '#000000', fontSize: 10, width: 4000,
      text: 'A single very long line of display type that never wraps at all, so it is a heading' });
    expect(codes(board([heading]))).not.toContain('LINE_TOO_LONG');
  });

  it('says nothing about empty text', () => {
    expect(codes(board([text({ text: '   ', color: '#eeeeee' })]))).toHaveLength(0);
  });
});
