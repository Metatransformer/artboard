import { describe, it, expect } from 'vitest';
import { buildNode, loadDocument, type Document, type Node } from '@artboard/schema';
import { apply, invert, StaleArtboardError, InvalidCommandError, type Command } from '@artboard/commands';
import { layoutText, classifyAnchors, reanchor, resizeFactor } from '@artboard/engine';

/**
 * Magic Resize's command half: `resizeArtboard`.
 *
 * `anchoring.test.ts` covers the geometry -- pure boxes in, boxes out. This
 * covers what the command adds on top: validation, the relayout of every node
 * on the page, the text-reflow invariant that retired the planned auto-fit
 * pass, and an undo that has to CAPTURE because the transform is not
 * reversible by arithmetic.
 *
 * The reflow invariant is the one worth being careful about, because "no text
 * overflowed" is also what a probe reports when it cannot see overflow at all,
 * and because a generous text box fits under any rule you care to apply. So
 * the assertion is not "it fits" -- it is that THE WRAP IS IDENTICAL, with the
 * retired rule run on the same box as a control that produces a different line
 * count and a real overflow. A test that only the correct implementation can
 * pass is worth more than one that measures how much slack the fixture had.
 */

const PROSE =
  'Typography is the craft of endowing human language with a durable visual form, '
  + 'and thus with an independent existence. Its heartwood is calligraphy, and its '
  + 'roots reach deep into the history of writing.';

const doc = (frame: { width: number; height: number }, nodes: unknown[]): Document => loadDocument({
  id: 'doc-1', name: 'Deck',
  artboards: [{
    id: 'ab-1', name: 'Page 1', width: frame.width, height: frame.height,
    background: { kind: 'solid', color: '#ffffff' },
    nodes,
  }],
}).doc;

const resize = (artboardId: string, width: number, height: number): Command =>
  ({ type: 'resizeArtboard', artboardId, width, height }) as Command;

const ab = (d: Document) => d.artboards[0]! as unknown as { width: number; height: number; nodes: Node[] };
const nodeById = (d: Document, id: string) => ab(d).nodes.find(n => n.id === id)! as any;

/* ── validation ───────────────────────────────────────────────────────────── */

describe('resizeArtboard: refuses what it cannot do', () => {
  it('rejects an artboard that is no longer there', () => {
    expect(() => apply(doc({ width: 800, height: 600 }, []), resize('ab-gone', 400, 400)))
      .toThrow(StaleArtboardError);
  });

  it.each([
    ['zero width', 0, 600],
    ['zero height', 800, 0],
    ['negative width', -800, 600],
    ['NaN', Number.NaN, 600],
    ['Infinity', Number.POSITIVE_INFINITY, 600],
  ])('rejects %s', (_label, w, h) => {
    expect(() => apply(doc({ width: 800, height: 600 }, []), resize('ab-1', w, h)))
      .toThrow(InvalidCommandError);
    // A degenerate frame must be refused BEFORE anything is relaid out.
    // `resizeFactor` returns 1 rather than dividing by zero, so a missing guard
    // here would not throw -- it would silently produce a zero-sized page with
    // every node still in it, which is far harder to notice than an error.
  });

  it('is a no-op, not a rebuild, when the size is unchanged', () => {
    // Object identity on purpose. Relaying out to the same frame is very nearly
    // the identity but not exactly -- `round` at 2dp makes it a slow leak on a
    // document that gets its own size applied repeatedly.
    const d = doc({ width: 800, height: 600 }, [
      buildNode({ id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50 }),
    ]);
    expect(apply(d, resize('ab-1', 800, 600))).toBe(d);
  });
});

/* ── the page changes, and the artwork comes with it ──────────────────────── */

describe('resizeArtboard: the frame and its contents move together', () => {
  const SQ = { width: 1080, height: 1080 };
  const STORY = { width: 1080, height: 1920 };

  const built = () => doc(SQ, [
    buildNode({ id: 'left', kind: 'rect', x: 40, y: 500, width: 120, height: 60 }),
    buildNode({ id: 'right', kind: 'rect', x: 920, y: 500, width: 120, height: 60 }),
    buildNode({ id: 'band', kind: 'rect', x: 20, y: 60, width: 1040, height: 80 }),
  ]);

  it('records the new page size', () => {
    const after = apply(built(), resize('ab-1', STORY.width, STORY.height));
    expect({ width: ab(after).width, height: ab(after).height }).toEqual(STORY);
  });

  it('keeps each node against the edge it was against, as a fraction', () => {
    const after = apply(built(), resize('ab-1', STORY.width, STORY.height));
    const l = nodeById(after, 'left');
    const r = nodeById(after, 'right');
    // Fraction, not pixels. STORY is the same width as SQ so the horizontal
    // fractions happen to be the same pixels here -- which is exactly why the
    // vertical case below, where they are not, carries the real weight.
    expect(l.x / STORY.width).toBeCloseTo(40 / SQ.width, 6);
    expect((STORY.width - (r.x + r.width)) / STORY.width).toBeCloseTo((SQ.width - (920 + 120)) / SQ.width, 6);
  });

  it('moves a top-anchored node DOWN when the page gets taller', () => {
    // The mistake this catches is preserving the pixel gap. A band 60px below
    // the top of a 1080 frame belongs 106.67px down a 1920 one; leaving it at
    // 60 would look correct on this node and wrong on the page.
    const after = apply(built(), resize('ab-1', STORY.width, STORY.height));
    const band = nodeById(after, 'band');
    expect(band.y).toBeCloseTo(60 * (STORY.height / SQ.height), 1);
    expect(band.y).not.toBeCloseTo(60, 1);
  });

  it('leaves an empty page as an empty page of the new size', () => {
    const after = apply(doc(SQ, []), resize('ab-1', 400, 400));
    expect(ab(after).nodes).toEqual([]);
    expect(ab(after).width).toBe(400);
  });
});

/* ── the invariant that retired the auto-fit pass ─────────────────────────── */

describe('resizeArtboard: relayout cannot introduce text overflow', () => {
  /*
   * The shape that discriminates. A column stretch-anchored on Y and not on X,
   * resized 1000x1000 -> 500x1000:
   *
   *   ry = 1     the height is unchanged
   *   rx = 0.5   and k = min(rx, ry) = 0.5, so the WIDTH halves
   *
   * Scale the font by the vertical factor and it does not change at all, in a
   * box half as wide -- the wrap doubles inside a box that did not grow. Scale
   * it by k and the box and the glyphs shrink together, so the wrap is
   * identical. Every other anchor combination has sy === k and cannot tell the
   * two rules apart, which is why this file constructs this one by hand rather
   * than trusting a sweep of realistic pages.
   */
  const column = () => doc({ width: 1000, height: 1000 }, [
    buildNode({
      id: 'col', kind: 'text', x: 250, y: 30, width: 480, height: 940,
      text: PROSE, fontSize: 44, lineHeight: 1.3, align: 'left', valign: 'top',
    }),
  ]);

  const wrap = (n: any) => layoutText(n);

  it('keeps the wrap identical through a relayout that halves the box', () => {
    const before = nodeById(column(), 'col');
    const after = nodeById(apply(column(), resize('ab-1', 500, 1000)), 'col');

    expect(after.width).toBe(before.width / 2);      // the box did halve
    expect(after.height).toBe(before.height);        // and the height did not
    expect(wrap(after).lines.length).toBe(wrap(before).lines.length);
    expect(wrap(after).blockHeight).toBeLessThanOrEqual(after.height);
  });

  it('CONTROL: the retired vertical rule overflows the same box', () => {
    // Without this, the test above passes on any node with a roomy text box and
    // proves only that the fixture had slack. Here the discarded rule is run on
    // the identical geometry: same box, font scaled by sy instead of k.
    const before = nodeById(column(), 'col');
    const after = nodeById(apply(column(), resize('ab-1', 500, 1000)), 'col');
    const sy = after.height / before.height;
    const retired = { ...after, fontSize: Math.max(1, before.fontSize * sy) };

    expect(wrap(retired).lines.length).toBeGreaterThan(wrap(before).lines.length);
    expect(wrap(retired).blockHeight).toBeGreaterThan(retired.height);
  });

  /*
   * INTRODUCE is the load-bearing word, and getting it wrong is how this test
   * first failed. `head` below does not fit its box at 1000x1000 either -- two
   * lines of 56px in a 120px frame, 112% full before anything is resized. An
   * assertion that every node fits AFTER a relayout therefore fails on a
   * correct implementation, including at a uniform 1000x1000 -> 1080x1080
   * where nothing meaningful happened at all. It was testing the fixture, not
   * the invariant.
   *
   * What relayout promises is that it does not make the fill WORSE: a box that
   * was 40% full is at most 40% full afterwards, and one that was already
   * overflowing overflows no further. `head` is kept deliberately over-full,
   * because a page of comfortable boxes cannot tell a preserved wrap from a
   * lucky one.
   */
  const fills = (d: Document) => Object.fromEntries(
    (ab(d).nodes as any[]).filter(n => n.kind === 'text')
      .map(n => [n.id, layoutText(n).blockHeight / n.height]),
  );

  it.each([
    ['story', 1080, 1920],
    ['landscape', 1920, 1080],
    ['square', 1080, 1080],
    ['a4', 2480, 3508],
    ['a narrow strip', 400, 1600],
  ])('fills no text box further than it already was, resizing to %s', (_label, w, h) => {
    const page = doc({ width: 1000, height: 1000 }, [
      buildNode({ id: 'col', kind: 'text', x: 250, y: 30, width: 480, height: 940, text: PROSE, fontSize: 44, lineHeight: 1.3, align: 'left', valign: 'top' }),
      buildNode({ id: 'head', kind: 'text', x: 60, y: 40, width: 880, height: 120, text: 'A headline that runs a fair way along the page', fontSize: 56, lineHeight: 1.2, align: 'left', valign: 'top' }),
      buildNode({ id: 'foot', kind: 'text', x: 60, y: 900, width: 300, height: 60, text: 'Footnote', fontSize: 18, lineHeight: 1.2, align: 'left', valign: 'top' }),
    ]);
    const before = fills(page);
    const after = fills(apply(page, resize('ab-1', w, h)));
    /*
     * 0.1% of slack, and it is rounding rather than a rule that nearly holds.
     * The box, the font size and the line height each land on a 2dp grid, and
     * blockHeight multiplies the line height by the line count -- so a uniform
     * 1000 -> 1080 moves a fill from 0.669361702 to 0.669405043, up in the
     * fifth decimal. What this check exists to catch moves it from 0.67 to
     * past 1.0, which the CONTROL below measures rather than assumes.
     */
    for (const id of Object.keys(before)) {
      expect(after[id]!, `${id} got fuller`).toBeLessThanOrEqual(before[id]! * 1.001);
    }
  });

  it('CONTROL: the fill check can see a box getting fuller', () => {
    // The assertion above is a <=, which is what a comparison of a number with
    // itself also satisfies. This is the same measurement applied to a node
    // whose box was narrowed without its font, and it has to report the rise.
    const page = doc({ width: 1000, height: 1000 }, [
      buildNode({ id: 'col', kind: 'text', x: 250, y: 30, width: 480, height: 940, text: PROSE, fontSize: 44, lineHeight: 1.3, align: 'left', valign: 'top' }),
    ]);
    const narrowed = doc({ width: 1000, height: 1000 }, [
      buildNode({ id: 'col', kind: 'text', x: 250, y: 30, width: 240, height: 940, text: PROSE, fontSize: 44, lineHeight: 1.3, align: 'left', valign: 'top' }),
    ]);
    expect(fills(narrowed).col!).toBeGreaterThan(fills(page).col!);
  });
});

/* ── undo ─────────────────────────────────────────────────────────────────── */

describe('resizeArtboard: undo restores, a second resize does not', () => {
  const SQ = { width: 1080, height: 1080 };
  const STORY = { width: 1080, height: 1920 };

  const page = () => doc(SQ, [
    buildNode({ id: 'r1', kind: 'rect', x: 37, y: 211, width: 133, height: 67 }),
    buildNode({ id: 't1', kind: 'text', x: 300, y: 700, width: 431, height: 129, text: 'Hello', fontSize: 29 }),
    buildNode({ id: 'g1', kind: 'group', x: 0, y: 0, width: 0, height: 0, children: [
      buildNode({ id: 'c1', kind: 'rect', x: 800, y: 100, width: 90, height: 41 }),
      buildNode({ id: 'c2', kind: 'rect', x: 850, y: 160, width: 90, height: 41 }),
    ] }),
  ]);

  it('is exact, down to the hundredth, in one step', () => {
    const before = page();
    const cmd = resize('ab-1', STORY.width, STORY.height);
    expect(apply(apply(before, cmd), invert(before, cmd))).toStrictEqual(before);
  });

  it('is NOT reachable by resizing back, and that is the documented behaviour', () => {
    /*
     * `resizeFactor` is min(rx, ry) -- the largest factor at which nothing
     * overflows -- so square -> story is k = 1 and story -> square is k =
     * 0.5625. Going there and back lands at 56%, not 100%. This is not a bug to
     * be fixed by making the round trip exact; making it exact would mean the
     * forward direction stopped guaranteeing that nothing overflows.
     *
     * If someone changes this, the test going red is the notice that they
     * changed a documented behaviour rather than fixed an unnoticed one.
     */
    const before = page();
    const there = apply(before, resize('ab-1', STORY.width, STORY.height));
    const back = apply(there, resize('ab-1', SQ.width, SQ.height));

    expect({ width: ab(back).width, height: ab(back).height }).toEqual(SQ);   // the page returns
    expect(back).not.toStrictEqual(before);                                   // the artwork does not
    expect(nodeById(back, 'r1').width).toBeCloseTo(133 * 0.5625, 2);
  });

  it('needs BOTH halves of the capture, and neither alone will do', () => {
    /*
     * The invert is a batch of two: the old page dimensions, and the old nodes.
     * The comment at the invert says neither is sufficient. Asserting that is
     * cheap, and it is the kind of claim that quietly stops being true when
     * someone simplifies the batch away.
     */
    const before = page();
    const cmd = resize('ab-1', STORY.width, STORY.height);
    const after = apply(before, cmd);
    const undoCmd = invert(before, cmd) as Extract<Command, { type: 'batch' }>;
    expect(undoCmd.type).toBe('batch');
    expect(undoCmd.commands).toHaveLength(2);

    for (const [i, half] of undoCmd.commands.entries()) {
      expect(apply(after, half), `half ${i} restored the document on its own`).not.toStrictEqual(before);
    }
    expect(apply(after, undoCmd)).toStrictEqual(before);
  });

  it('restores a group and its children, not just the group box', () => {
    const before = page();
    const cmd = resize('ab-1', STORY.width, STORY.height);
    const restored = apply(apply(before, cmd), invert(before, cmd));
    expect(nodeById(restored, 'g1').children).toStrictEqual(nodeById(before, 'g1').children);
  });
});


/* ── a text box is a frame, not the visible extent ────────────────────────── */

describe('resizeArtboard: alignment overrides a centred box reading, and only that', () => {
  /*
   * The bug this pins, in renderer-wins' words: a text box is a FRAME, not the
   * visible extent. A left-aligned headline at x=96 with width=888 in a 1080
   * frame has margins of 96 and 96, so the box classifies `centre` -- correct
   * about the box, wrong about the element, because the glyphs start hard left
   * and every pixel of slack is on the right. Re-centring that box on a wider
   * frame walks the visible text away from the edge it was aligned to.
   *
   * So `textAware` overrides the anchor from the node's own `align`/`valign` --
   * but ONLY where the box said `centre`/`middle`. The tests below are as much
   * about that "only" as about the override: an override that fires on a
   * decisive box reading, or that eats a stretch, trades one wrong answer for
   * another.
   *
   * Each case below was checked against the three plausible ways to get
   * `textAware` wrong, by running them on the same boxes rather than reasoning
   * about them -- which was worth doing, because the reasoning was wrong about
   * the fourth row. The number is the metric the test asserts; * marks a value
   * the shipped rule does not produce, i.e. the case discriminates.
   *
   *   case                  shipped   no override   always fires   no fall-through
   *   headline left          0.0889     0.3972*        0.0889          0.0889
   *   tag right-bound        0.0370     0.0370         0.1343*         0.0370
   *   band stretch           0.9907     0.9907         0.2477*         0.9907
   *   headline center        0.5000     0.5000         0.5000          0.1917*
   *   quote valign top       0.1296     0.2917*        0.1296          0.1296
   *
   * Every mutant is killed by some case and every case kills some mutant, so
   * none of the five is padding. `headline center` looked like the padding --
   * an override that never fires cannot break a case it does not touch -- and
   * it is the only thing standing between us and a fall-through that treats
   * every align as `left`, which is an ordinary way to write this slightly
   * wrong.
   */
  const SQ = { width: 1080, height: 1080 };
  const BANNER = { width: 1584, height: 396 };          // the aspect inversion

  const page = (over: Record<string, unknown>) => doc(SQ, [
    buildNode({
      id: 'head', kind: 'text', x: 96, y: 480, width: 888, height: 120,
      text: 'Launch day', fontSize: 48, ...over,
    }),
  ]);

  const leftFraction = (n: any, frame: { width: number }) => n.x / frame.width;

  it('keeps a left-aligned headline left-bound when its BOX reads centred', () => {
    const before = nodeById(page({ align: 'left' }), 'head');
    // The premise: the box really does classify as centred. If a threshold
    // change ever makes this `left` on its own, this test stops exercising the
    // override and silently becomes a much weaker test -- so it is asserted.
    expect(classifyAnchors(before, SQ).x).toBe('centre');

    const after = nodeById(apply(page({ align: 'left' }), resize('ab-1', BANNER.width, BANNER.height)), 'head');
    expect(leftFraction(after, BANNER)).toBeCloseTo(leftFraction(before, SQ), 4);
  });

  it('CONTROL: without the override the same headline walks to the middle', () => {
    // Not a hypothetical drift. `reanchor` is asked for the un-overridden
    // answer on the identical box, and it reproduces the number renderer-wins
    // measured on social-gradient-launch: 8.9% of the frame becomes 39.7%.
    const before = nodeById(page({ align: 'left' }), 'head');
    const centred = reanchor(before, { x: 'centre', y: 'middle' }, SQ, BANNER);

    expect(leftFraction(before, SQ)).toBeCloseTo(0.089, 3);
    expect(leftFraction(centred, BANNER)).toBeCloseTo(0.397, 3);
  });

  it('does not fight a box reading that is decisive', () => {
    // Hard against the right edge, and left-aligned. The box knows where this
    // node lives; `align` describes where the glyphs sit INSIDE it and has no
    // business moving it. An override applied unconditionally would drag a
    // right-bound element back across the page.
    const hardRight = doc(SQ, [
      buildNode({ id: 'tag', kind: 'text', x: 900, y: 40, width: 140, height: 48, text: 'New', fontSize: 24, align: 'left' }),
    ]);
    const before = nodeById(hardRight, 'tag');
    expect(classifyAnchors(before, SQ).x).toBe('right');

    const after = nodeById(apply(hardRight, resize('ab-1', BANNER.width, BANNER.height)), 'tag');
    const rightFraction = (n: any, f: { width: number }) => (f.width - (n.x + n.width)) / f.width;
    expect(rightFraction(after, BANNER)).toBeCloseTo(rightFraction(before, SQ), 4);
  });

  it('does not eat a stretch: a full-bleed band stays full-bleed', () => {
    // `stretch` is not `centre`, so the override must not reach it. A band that
    // spans the page and comes back inset is the outcome nobody reads as
    // correct, and it is the failure an over-eager override produces.
    const bleed = doc(SQ, [
      buildNode({ id: 'band', kind: 'text', x: 5, y: 500, width: 1070, height: 90, text: 'Across the page', fontSize: 36, align: 'left' }),
    ]);
    const before = nodeById(bleed, 'band');
    expect(classifyAnchors(before, SQ).x).toBe('stretch');

    const after = nodeById(apply(bleed, resize('ab-1', BANNER.width, BANNER.height)), 'band');
    expect(after.width / BANNER.width).toBeCloseTo(before.width / SQ.width, 4);
  });

  it('leaves a genuinely centred element centred', () => {
    // The case the override exists to leave alone. If `align: 'center'` came
    // back left-bound, the override would have swallowed its own exception.
    const before = nodeById(page({ align: 'center' }), 'head');
    const after = nodeById(apply(page({ align: 'center' }), resize('ab-1', BANNER.width, BANNER.height)), 'head');
    const centreFraction = (n: any, f: { width: number }) => (n.x + n.width / 2) / f.width;
    expect(centreFraction(after, BANNER)).toBeCloseTo(centreFraction(before, SQ), 4);
  });

  it('applies the same rule vertically, from valign', () => {
    // `textAware` reads both axes and the y half is easy to leave half-written,
    // because every fixture that exercises x tends to be middle-anchored on y.
    const stacked = doc(SQ, [
      buildNode({ id: 'quote', kind: 'text', x: 400, y: 140, width: 280, height: 800, text: 'A tall quote', fontSize: 32, valign: 'top' }),
    ]);
    const before = nodeById(stacked, 'quote');
    expect(classifyAnchors(before, SQ).y).toBe('middle');

    const TALL = { width: 1080, height: 1920 };
    const after = nodeById(apply(stacked, resize('ab-1', TALL.width, TALL.height)), 'quote');
    expect(after.y / TALL.height).toBeCloseTo(before.y / SQ.height, 4);
  });
});


/* ── stacks are placed as one, so a column is not torn ────────────────────── */

describe('resizeArtboard: adjacency survives the aspect change', () => {
  /*
   * The tear this pins, in the lead's numbers: anchoring each node on its own
   * splits any contiguous column straddling the frame's midline. The members
   * nearer the top leave for the top edge, the members nearer the bottom leave
   * for the bottom, and the whole of the new height lands in the seam between
   * them -- on social-gradient-launch a 36px gap became 468px, a void the
   * height of the headline in the middle of a text column.
   *
   * The invariant that replaces it: a gap INSIDE a stack scales by k like
   * everything else, and only the space BETWEEN stacks absorbs the frame's
   * extra height. That is the property worth holding, rather than the stack
   * detection itself -- STACK_GAP sits in a flat spot between two failure modes
   * by the lead's own sweep, and a test that pinned 0.10 would certify a number
   * they measured as not load-bearing.
   */
  const SQ = { width: 1080, height: 1080 };
  const STORY = { width: 1080, height: 1920 };

  // Deliberately straddling: the headline reads `top` on its own and the body
  // reads `bottom`, so per-node anchoring sends them in opposite directions.
  const HEAD = { id: 'head', kind: 'text', x: 96, y: 380, width: 888, height: 120, text: 'Launch day', fontSize: 48, align: 'left' };
  const BODY = { id: 'body', kind: 'text', x: 96, y: 536, width: 888, height: 380, text: 'Everything you need, in one place.', fontSize: 28, align: 'left' };

  const column = (extra: unknown[] = []) => doc(SQ, [buildNode(HEAD), buildNode(BODY), ...extra]);
  const gapOf = (d: Document) => {
    const h = nodeById(d, 'head'), b = nodeById(d, 'body');
    return b.y - (h.y + h.height);
  };

  it('the two nodes really do anchor in opposite directions on their own', () => {
    // The premise. Without it this whole block could be exercising a column
    // that was never at risk, and would pass on the code it is meant to catch.
    expect(classifyAnchors(nodeById(column(), 'head'), SQ).y).toBe('top');
    expect(classifyAnchors(nodeById(column(), 'body'), SQ).y).toBe('bottom');
  });

  it('scales the gap inside a column by k, not by the frame', () => {
    const before = gapOf(column());
    const after = gapOf(apply(column(), resize('ab-1', STORY.width, STORY.height)));
    // k is 1 for square -> story (min(1, 1.78)), so the gap is unchanged. The
    // assertion is written against k rather than against 36 so it still means
    // something on a resize where k is not 1 -- see the A4 case below.
    expect(after).toBeCloseTo(before * resizeFactor(SQ, STORY), 1);
  });

  it('CONTROL: anchored per node, the same column tears open', () => {
    // Not a description of the old behaviour -- a reproduction of it. `reanchor`
    // is asked for each node's own answer on the identical boxes, which is
    // exactly what this code did before stacks existed.
    const h = nodeById(column(), 'head'), b = nodeById(column(), 'body');
    const perNode = (n: any) => reanchor(n, classifyAnchors(n, SQ), SQ, STORY);
    const torn = perNode(b).y - (perNode(h).y + perNode(h).height);

    expect(gapOf(column())).toBe(36);
    expect(torn).toBeGreaterThan(400);            // measured 452.9
  });

  it('holds when k is not 1', () => {
    // Square -> A4 shrinks nothing and stretches nothing on the horizontal, so
    // k = 1080/2480 is not 1 and a gap that merely stayed put would fail here.
    const A4 = { width: 2480, height: 3508 };
    const before = gapOf(column());
    const after = gapOf(apply(column(), resize('ab-1', A4.width, A4.height)));
    expect(after).toBeCloseTo(before * resizeFactor(SQ, A4), 1);
    expect(after).not.toBeCloseTo(before, 1);      // it did scale, not merely survive
  });

  it('does not let a full-bleed backdrop swallow the column', () => {
    // A shape running off the page is decoration behind the content, not a
    // member of its rhythm -- and being adjacent to everything, it would
    // otherwise pull every node on the page into one stack and change where
    // that stack lands. The gap alone cannot see this: interior gaps scale by k
    // whatever the stack contains. The stack's POSITION is what moves: a stack
    // spanning the blob reads as stretch, is forced to middle, and puts the
    // headline at 800 instead of 1092.44 -- measured, so the assertion below is
    // known to discriminate rather than assumed to.
    const blob = { id: 'blob', kind: 'rect', x: -100, y: -200, width: 1280, height: 1480 };
    const plain = apply(column(), resize('ab-1', STORY.width, STORY.height));
    const withBlob = apply(column([buildNode(blob)]), resize('ab-1', STORY.width, STORY.height));
    expect(nodeById(withBlob, 'head').y).toBeCloseTo(nodeById(plain, 'head').y, 2);
  });

  it('leaves a node in no stack exactly as it was', () => {
    // "A stack of one is the old behaviour exactly, so nothing already right
    // changes" is a claim in the commit message. A lone badge, far from
    // everything, has to land where its own anchor puts it.
    const lone = { id: 'badge', kind: 'rect', x: 940, y: 24, width: 100, height: 40 };
    const page = doc(SQ, [buildNode(lone)]);
    const after = nodeById(apply(page, resize('ab-1', STORY.width, STORY.height)), 'badge');
    const own = reanchor(nodeById(page, 'badge'), classifyAnchors(nodeById(page, 'badge'), SQ), SQ, STORY);
    expect({ x: after.x, y: after.y, width: after.width, height: after.height }).toEqual(own);
  });
});
