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

  /*
   * REMOVED WITH THE RULE IT PINNED: `it('applies the same rule vertically,
   * from valign')`. The y half of `textAware` is gone -- it was generalised
   * from x by symmetry with nothing measured, it cost a net 1941px of extra
   * tearing across the corpus under the per-node model, and under the clustered
   * model it fires on 0 of the 4 text nodes left to place themselves (the same
   * probe reports 46 with clustering off, so the 0 is a measurement).
   *
   * The case this test built -- a 280x800 quote box, far taller than its two
   * lines, `valign: top` -- is the one shape where the argument does survive,
   * and it is written down here rather than deleted so that a future y rule has
   * to start from it. What that rule needs and this one lacked is a test for
   * actual vertical SLACK: `align: left` is nearly always meaningful because a
   * headline box is as wide as its column, while `valign: top` is nearly always
   * inert because a text box is as tall as its text. Distinguishing the two
   * means measuring the block against the box, which means `layoutText` inside
   * the command layer -- a real coupling, and one that should be bought with a
   * design that visibly needs it rather than with symmetry a second time.
   */

  it('an isolated text node anchors by its box, not by its valign', () => {
    /*
     * The converted pin. The old y rule is gone, and this asserts what replaced
     * it rather than leaving a comment where a test was -- the lead measured the
     * case through `apply()` and it is a behaviour change, not a dead-code
     * deletion, so it deserves a live test.
     *
     * Margins of 430 and 350 in a 1000 frame differ by 80, exactly the 8% band,
     * so the box reads `middle`; nothing is near it, so no stack forms and the
     * node places itself. That is the one shape in which the removed rule was
     * ever reachable.
     */
    const FROM = { width: 1000, height: 1000 };
    const TO = { width: 1000, height: 2000 };
    const lone = doc(FROM, [
      buildNode({ id: 'note', kind: 'text', x: 300, y: 430, width: 400, height: 220, text: 'A note', fontSize: 28, valign: 'top' }),
    ]);
    const before = nodeById(lone, 'note');
    expect(classifyAnchors(before, FROM).y).toBe('middle');

    const after = nodeById(apply(lone, resize('ab-1', TO.width, TO.height)), 'note');
    expect(after.y).toBeCloseTo(970, 1);

    // What the removed rule did, on the same box: 110px higher. Computed rather
    // than quoted, so the gap is checked and not remembered.
    const byValign = reanchor(before, { x: 'centre', y: 'top' }, FROM, TO);
    expect(byValign.y).toBeCloseTo(860, 1);
  });

  it('inside a stack, align still places x while nothing places y but the stack', () => {
    /*
     * renderer-wins' point, and the pin the deleted test should have been.
     * Measuring whether the y rule HELPED was impossible from the corpus: every
     * text node in all 30 fixtures lands in a stack of two or more, and
     * `stackPlacements` overwrites y for all of them, so the y branch is
     * unreachable there. Disabling the override and forcing `y: 'top'`
     * unconditionally both moved 0 of 120 placements -- two rules that should
     * disagree violently, agreeing perfectly, which is a blind instrument
     * rather than a correct one.
     *
     * What IS reachable, and is now the design, is the split: `stackPlacements`
     * writes y and height and leaves x alone, so a stacked text node takes its
     * column's vertical placement while `align` still decides where it sits
     * horizontally.
     *
     * The two halves police each other. The align row moving through three
     * distinct x values is what makes the valign row's stillness a measurement
     * instead of a silence -- without it, "valign changes nothing" is equally
     * what a broken harness reports. And should a future y rule arrive (the
     * comment above invites one), this fails unless it is written to lose to
     * stack placement.
     */
    const stacked = (align: string, valign: string) => doc(SQ, [
      buildNode({ id: 'head', kind: 'text', x: 96, y: 380, width: 888, height: 120, text: 'Launch day', fontSize: 48, align, valign }),
      buildNode({ id: 'body', kind: 'text', x: 96, y: 536, width: 888, height: 380, text: 'Everything you need.', fontSize: 28, align: 'left', valign: 'top' }),
    ]);
    const placed = (align: string, valign: string) => {
      const n = nodeById(apply(stacked(align, valign), resize('ab-1', BANNER.width, BANNER.height)), 'head');
      return { x: n.x, y: n.y };
    };

    const xs = ['left', 'center', 'right'].map(a => placed(a, 'top').x);
    expect(new Set(xs).size).toBe(3);                       // align is live

    const ys = ['left', 'center', 'right'].map(a => placed(a, 'top').y);
    expect(new Set(ys).size).toBe(1);                       // and touches y not at all

    const byValign = ['top', 'middle', 'bottom'].map(v => placed('left', v));
    expect(new Set(byValign.map(p => `${p.x},${p.y}`)).size).toBe(1);
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

  /*
   * THE CLUMPING SIDE, which the lead flagged as having no assertion yet.
   *
   * The tearing tests above bound STACK_GAP from BELOW: set it too small and a
   * 36px gap (3.3% of the frame) stops reading as contiguous and the column
   * tears. Nothing yet bounds it from above, where the failure is the opposite
   * and quieter -- every gap reads as contiguous, the whole page becomes one
   * block, and the design stops adapting to the frame instead of visibly
   * breaking in it.
   *
   * One page carries both. A badge 220px above the headline is 20.4% of the
   * frame; the headline and body are 36px apart, 3.3%. Resize to a frame with
   * height to spare and the two gaps must behave DIFFERENTLY: the tight one
   * scales by k, the loose one absorbs what is left over.
   *
   * Together they bracket STACK_GAP into (3.3%, 20.4%) without pinning it. That
   * the bracket really does straddle the threshold was measured rather than
   * assumed, and measured from OUTSIDE the implementation: membership is
   * `gapY <= STACK_GAP * frame.height`, so holding a 36px gap fixed and
   * shrinking the frame walks it across the boundary without anyone editing the
   * constant. It flips between 10.59% of frame height (torn) and 10.00% (one
   * stack) -- so 3.3% and 20.4% sit either side of it with room to spare.
   *
   * Knowing the threshold is 0.10 is exactly why this does not assert it. The
   * lead's sweep puts the flat spot at 10-12% and the danger below 8%, so the
   * bracket is deliberately far wider than the region they measured: it rules
   * out the two failure modes and stays silent about the choice between 10 and
   * 12, which is the same shape as the centre-band bound.
   */
  it.each([
    ['story', 1080, 1920],
    ['a4', 2480, 3508],
  ])('puts the new height in the loose gap, not the tight one: %s', (_label, w, h) => {
    const page = column([buildNode({ id: 'badge', kind: 'rect', x: 96, y: 60, width: 888, height: 100 })]);
    const looseBefore = nodeById(page, 'head').y - (nodeById(page, 'badge').y + nodeById(page, 'badge').height);
    const after = apply(page, resize('ab-1', w, h));
    const k = resizeFactor(SQ, { width: w, height: h });
    const loose = nodeById(after, 'head').y - (nodeById(after, 'badge').y + nodeById(after, 'badge').height);

    expect(looseBefore).toBe(220);
    expect(gapOf(after)).toBeCloseTo(gapOf(page) * k, 1);     // tight: scales by k
    expect(loose).toBeGreaterThan(looseBefore * k * 1.5);     // loose: absorbs the rest
  });

  it('but only where there IS height to spare', () => {
    // The honest exception, asserted rather than dodged by picking targets that
    // suit the story. Square -> 1584x396 is a SHORTER frame: ry equals k, so
    // there is no leftover height and every gap simply scales by k, loose and
    // tight alike. A test that only ever resized into taller frames would read
    // as though the loose gap always grows.
    const BANNER = { width: 1584, height: 396 };
    const page = column([buildNode({ id: 'badge', kind: 'rect', x: 96, y: 60, width: 888, height: 100 })]);
    const looseBefore = nodeById(page, 'head').y - (nodeById(page, 'badge').y + nodeById(page, 'badge').height);
    const after = apply(page, resize('ab-1', BANNER.width, BANNER.height));
    const k = resizeFactor(SQ, BANNER);
    const loose = nodeById(after, 'head').y - (nodeById(after, 'badge').y + nodeById(after, 'badge').height);

    expect(BANNER.height / SQ.height).toBeCloseTo(k, 6);      // ry === k: nothing spare
    expect(loose).toBeCloseTo(looseBefore * k, 1);
    expect(gapOf(after)).toBeCloseTo(gapOf(page) * k, 1);
  });

  it('centres a full-height column instead of stretching it', () => {
    /*
     * The one branch the mutants found unguarded: a stack whose own box spans
     * 90% of the frame classifies `stretch`, and `stackPlacements` overrides
     * that to `middle`.
     *
     * Worth pinning because the branch is real, and worth reading carefully
     * because the mechanism is not the one the source comment describes. That
     * comment says stretching a stack "distributes the new height through its
     * interior, which is the tear this exists to prevent". Measured, the
     * interior is immune either way -- members land at `next.y + offset * k`
     * and the stretched `next.height` (1760 here) is computed and never read,
     * so the gap between these two nodes is 40 under both rules.
     *
     * What the override actually decides is where the column LANDS: centred at
     * 456.11, or pinned proportionally to its old top at 71.11. Centring is the
     * better answer -- a column that filled a square should sit in the middle
     * of a taller frame, not ride up against its top edge -- so the guard is
     * right and only its stated reason is wrong.
     */
    const tall = doc(SQ, [
      buildNode({ id: 'head', kind: 'rect', x: 96, y: 40, width: 888, height: 120 }),
      buildNode({ id: 'body', kind: 'rect', x: 96, y: 200, width: 888, height: 830 }),
    ]);
    // The premise: the stack's combined box really does read as stretch.
    expect(classifyAnchors({ x: 0, y: 40, width: 1080, height: 990 }, SQ).y).toBe('stretch');

    const after = apply(tall, resize('ab-1', STORY.width, STORY.height));
    const head = nodeById(after, 'head'), body = nodeById(after, 'body');
    const k = resizeFactor(SQ, STORY);

    // Centred, not pinned to the top. The stretched alternative puts the head
    // at 40 * ry = 71.11, so this discriminates rather than merely describing.
    const stretched = reanchor({ x: 0, y: 40, width: 0, height: 990 }, { x: 'left', y: 'stretch' }, SQ, STORY);
    expect(head.y).toBeGreaterThan(stretched.y * 2);
    // Centred means the stack's centre keeps its FRACTION of the frame, not
    // that it lands on the frame's midpoint -- this column sat a hair above
    // centre (0.4954) and lands a hair above centre, at 951.11 of 1920. The
    // midpoint version of this assertion failed by 8.89px on correct code.
    const centreFraction = (top: number, bottom: number, f: number) => (top + (bottom - top) / 2) / f;
    expect(centreFraction(head.y, body.y + body.height, STORY.height))
      .toBeCloseTo(centreFraction(40, 1030, SQ.height), 4);

    // And the interior is untouched by the choice, which is why the gap cannot
    // be the thing asserted here.
    expect(body.y - (head.y + head.height)).toBeCloseTo(40 * k, 1);
  });

  /*
   * WHAT THE BRACKET ABOVE DOES NOT PIN: the FORM of the comparison.
   *
   * renderer-wins reconstructed the predicate out of tree and showed the hole.
   * Membership is classified on the FROM frame, and every case above starts
   * from the same 1080 square -- so with a tight gap of 36 and a loose one of
   * 220, an absolute `gapY <= 108` partitions those nodes identically to the
   * ratio, and so does reading `frame.width` instead of `frame.height`. The
   * three targets vary only the TO frame, which changes k and changes which gap
   * absorbs the slack, but membership was already decided before any of that.
   *
   * Varying the FROM frame is what separates them, and the geometry below is
   * the pair that does it. I had measured this and written it in a comment,
   * which is worth exactly nothing to CI.
   *
   *   from 1080x360   gap 36 = 10.00% of height, and 36 <= 108   both agree
   *   from 1080x340   gap 36 = 10.59% of height, and 36 <= 108   they disagree
   *
   * The 340 frame is non-square, so the same pair also kills the width variant:
   * 10% of 340 is 34 and the gap is 36, while 10% of 1080 is 108.
   */
  const twoRows = (H: number) => doc({ width: 1080, height: H }, [
    buildNode({ id: 'head', kind: 'rect', x: 96, y: Math.round(H * 0.352), width: 888, height: Math.round(H * 0.111) }),
    buildNode({ id: 'body', kind: 'rect', x: 96, y: Math.round(H * 0.352) + Math.round(H * 0.111) + 36, width: 888, height: Math.round(H * 0.352) }),
  ]);

  it('reads adjacency as a fraction of the frame, not as a pixel count', () => {
    // Same 36px gap, same nodes, two from-frames either side of the boundary.
    // A stacked pair keeps its gap at k; a torn one does not.
    const k = (H: number) => resizeFactor({ width: 1080, height: H }, { width: 1080, height: H * 2 });

    const stacked = apply(twoRows(360), resize('ab-1', 1080, 720));
    expect(gapOf(stacked)).toBeCloseTo(36 * k(360), 1);

    const torn = apply(twoRows(340), resize('ab-1', 1080, 680));
    expect(gapOf(torn)).not.toBeCloseTo(36 * k(340), 1);
    expect(gapOf(torn)).toBeGreaterThan(36 * k(340) * 2);
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


/* ── a rotated subtree keeps its angle rather than becoming a parallelogram ── */

describe('resizeArtboard: a rotated group scales uniformly', () => {
  /*
   * The branch the mutants found next: `rotated && !uniform` collapses both
   * factors to min(sx, sy), so a group holding a rotated child scales uniformly
   * and keeps its angle. Stretching it on one axis would shear the child into a
   * parallelogram -- which `scale` refuses outright, but refusing here would be
   * wrong, because picking a page preset must never fail. It lands
   * proportionally placed instead of not at all.
   *
   * renderer-wins flagged this as possibly unreachable from the corpus and
   * therefore not worth reading a survivor as a gap. It is unreachable from the
   * corpus and it is trivially reachable by construction, so a survivor here
   * was a hole in my case set rather than a dead line -- the opposite of the
   * `valign` situation, and worth distinguishing rather than pattern-matching.
   *
   * The two rotations police each other: without the unrotated row, "the aspect
   * is preserved" is equally what a resize that changed nothing would report.
   */
  const SQ = { width: 1080, height: 1080 };
  const LAND = { width: 1920, height: 1080 };

  // The group's own box spans 96% of the width and 19% of the height, so it
  // stretches horizontally (sx = 1.78) and takes k vertically (sy = 1). That
  // gap between the two factors is the whole test; a uniform resize cannot see
  // this branch at all.
  const page = (rotation: number) => doc(SQ, [
    buildNode({ id: 'g', kind: 'group', x: 0, y: 0, width: 0, height: 0, children: [
      buildNode({ id: 'c1', kind: 'rect', x: 20, y: 400, width: 500, height: 200, rotation }),
      buildNode({ id: 'c2', kind: 'rect', x: 560, y: 400, width: 500, height: 200 }),
    ] }),
  ]);
  const child = (d: Document, id: string) => {
    const g = (ab(d).nodes as any[]).find(n => n.id === 'g');
    return g.children.find((c: any) => c.id === id);
  };
  const aspect = (n: any) => n.width / n.height;

  it('stretches an axis-aligned group, because there is nothing to shear', () => {
    const after = apply(page(0), resize('ab-1', LAND.width, LAND.height));
    expect(aspect(child(after, 'c1'))).toBeCloseTo(4.444, 2);   // 2.5 -> 4.44
    expect(aspect(child(after, 'c2'))).toBeCloseTo(4.444, 2);
  });

  it('refuses to shear once any descendant is rotated', () => {
    const after = apply(page(12), resize('ab-1', LAND.width, LAND.height));
    // Both children take min(sx, sy) -- not just the rotated one, or the group
    // would come apart internally.
    expect(aspect(child(after, 'c1'))).toBeCloseTo(2.5, 2);
    expect(aspect(child(after, 'c2'))).toBeCloseTo(2.5, 2);
    expect(child(after, 'c1').rotation).toBe(12);               // and keeps its angle
  });

  it('still resizes it -- proportionally placed beats not at all', () => {
    // The guard must not become "leave a rotated group alone". It lands in the
    // new frame; it just does not shear on the way.
    const before = child(page(12), 'c1');
    const after = child(apply(page(12), resize('ab-1', 2480, 3508)), 'c1');
    expect(after.x).not.toBeCloseTo(before.x, 1);
    expect(after.width).toBeGreaterThan(before.width);
  });
});
