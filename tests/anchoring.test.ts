import { describe, it, expect } from 'vitest';
import { classifyAnchors, reanchor, resizeFactor, type Anchors } from '@artboard/engine';

/**
 * Magic Resize's geometry half. Pure boxes in, boxes out.
 *
 * THE ORACLE THAT IS NOT USED HERE, and why. The obvious round trip is
 * `classifyAnchors(reanchor(box, a, from, to), to) === a` -- classify, move,
 * re-classify. It asserts only that the two functions agree with each other,
 * and a classifier answering `centre` for everything paired with a reanchor
 * that centres everything satisfies it at every aspect ratio forever. That is
 * not hypothetical: the first implementation WAS that classifier, and it
 * classified all ten nodes of a real design `centre/middle`.
 *
 * So what is asserted instead is the GEOMETRIC CONSEQUENCE -- a quantity the
 * classifier plays no part in producing:
 *
 *   left-anchored   the left margin, as a fraction of the frame, is unchanged
 *   right-anchored  the right margin, as a fraction of the frame, is unchanged
 *   centred         the box's centre sits at the same fraction of the frame
 *
 * Note "as a fraction". Margins scale by their axis's own ratio, so the pixel
 * gap is NOT preserved and asserting that it is would fail a correct
 * implementation -- a top-anchored node 100px down a 1080 frame belongs 178px
 * down a 1920 one, at the same fraction.
 *
 * Thresholds are pinned only where any sane setting agrees. A 2px margin is
 * `left` however the knob is turned; a 99% span is `stretch` however it is
 * turned. The cases where reasonable people would disagree are deliberately
 * not asserted, because a test that certifies a threshold nobody questioned is
 * how a wrong constant becomes permanent.
 */

const SQ = { width: 1080, height: 1080 };
const STORY = { width: 1080, height: 1920 };
const LAND = { width: 1920, height: 1080 };
const A4 = { width: 2480, height: 3508 };
const LETTER = { width: 2550, height: 3300 };

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/* ── classification: ground truth where every threshold agrees ────────────── */

describe('classifyAnchors: unambiguous cases, whatever the thresholds are', () => {
  it.each([
    ['flush to the left edge',  box(2, 500, 100, 40), 'left'],
    ['flush to the right edge', box(978, 500, 100, 40), 'right'],
    ['exactly centred',         box(490, 500, 100, 40), 'centre'],
    ['spanning 99% of the axis', box(5, 500, 1070, 40), 'stretch'],
  ] as const)('%s -> %s', (_label, b, expected) => {
    expect(classifyAnchors(b, SQ).x).toBe(expected);
  });

  it('classifies the two axes independently', () => {
    // A swapped-axis bug is invisible whenever both axes are treated alike, so
    // the fixture is deliberately asymmetric: hard left, hard bottom.
    expect(classifyAnchors(box(4, 1000, 100, 60), SQ)).toEqual({ x: 'left', y: 'bottom' });
  });
});

describe('classifyAnchors: it discriminates', () => {
  it('does not answer one constant across the frame', () => {
    // THE LOAD-BEARING CONTROL. Everything else in this file is satisfied by a
    // classifier that returns `centre` for everything; this is not.
    const xs = [0, 50, 200, 490, 700, 900, 978].map(x => classifyAnchors(box(x, 500, 100, 40), SQ).x);
    expect(new Set(xs).size).toBeGreaterThan(1);
    expect(new Set(xs)).toEqual(new Set(['left', 'centre', 'right']));
  });

  it('separates a node near an edge from a centred one', () => {
    // 5% from the left is the case the first band-based rule got wrong: too far
    // from the edge for the edge band, too far from the middle for the centre
    // band, and swallowed by the fallback.
    expect(classifyAnchors(box(50, 500, 100, 40), SQ).x).toBe('left');
    expect(classifyAnchors(box(50, 500, 100, 40), SQ).x)
      .not.toBe(classifyAnchors(box(490, 500, 100, 40), SQ).x);
  });

  it('does not read a node twice as far from one edge as the other as centred', () => {
    /*
     * Bounds the centre band from ABOVE without pinning its value. Margins of
     * 300 and 600 are a 1:2 split -- calling that centred is wrong under any
     * reading, so this fails for any band wider than 30% of the frame while
     * staying silent about whether 6%, 8% or 12% is right.
     *
     * Added because a mutant that widened the band to 45% survived every other
     * assertion here: my "unambiguous" cases sat so far from the boundary that
     * an absurd threshold still classified them correctly. Threshold-
     * independent is not the same as threshold-bounding, and this file needed
     * both.
     */
    expect(classifyAnchors(box(300, 500, 100, 40), { width: 1000, height: 1080 }).x).toBe('left');
    expect(classifyAnchors(box(600, 500, 100, 40), { width: 1000, height: 1080 }).x).toBe('right');
  });

  it('reads a kicker 9.3% down the frame as top-bound, not centred', () => {
    // The exact node that exposed the band rule: 100px down a 1080 frame.
    expect(classifyAnchors(box(100, 100, 400, 60), SQ).y).toBe('top');
  });
});

/* ── reanchor: the identity, which needs no judgement at all ──────────────── */

describe('reanchor: resizing to the same frame changes nothing', () => {
  const anchors: Anchors[] = [
    { x: 'left', y: 'top' }, { x: 'centre', y: 'middle' }, { x: 'right', y: 'bottom' },
    { x: 'stretch', y: 'stretch' }, { x: 'left', y: 'stretch' }, { x: 'stretch', y: 'bottom' },
  ];
  it.each(anchors.map(a => [`${a.x}/${a.y}`, a] as const))('%s is the identity', (_label, a) => {
    // Wrong k, wrong anchor arithmetic or a stray rounding step all break this,
    // and no threshold or design opinion is involved in judging it.
    const b = box(137, 291, 216, 88);
    expect(reanchor(b, a, SQ, SQ)).toEqual(b);
  });
});

/* ── reanchor: the geometric consequence ──────────────────────────────────── */

const leftMarginFraction = (b: { x: number }, f: { width: number }) => b.x / f.width;
const rightMarginFraction = (b: { x: number; width: number }, f: { width: number }) =>
  (f.width - (b.x + b.width)) / f.width;
const centreFractionY = (b: { y: number; height: number }, f: { height: number }) =>
  (b.y + b.height / 2) / f.height;

describe('reanchor: the anchored relationship survives the aspect change', () => {
  const trips = [
    ['square -> story', SQ, STORY],
    ['story -> square', STORY, SQ],
    ['square -> landscape', SQ, LAND],
    ['A4 -> letter', A4, LETTER],
  ] as const;

  it.each(trips)('%s keeps a left-bound node left-bound', (_l, from, to) => {
    const b = box(Math.round(from.width * 0.04), Math.round(from.height * 0.3), 200, 80);
    const out = reanchor(b, { x: 'left', y: 'top' }, from, to);
    expect(leftMarginFraction(out, to)).toBeCloseTo(leftMarginFraction(b, from), 4);
  });

  it.each(trips)('%s keeps a right-bound node right-bound', (_l, from, to) => {
    const b = box(Math.round(from.width * 0.7), Math.round(from.height * 0.3), 200, 80);
    const out = reanchor(b, { x: 'right', y: 'top' }, from, to);
    expect(rightMarginFraction(out, to)).toBeCloseTo(rightMarginFraction(b, from), 4);
  });

  it.each(trips)('%s keeps a centred node centred', (_l, from, to) => {
    const b = box(100, Math.round(from.height * 0.45), 200, 80);
    const out = reanchor(b, { x: 'left', y: 'middle' }, from, to);
    expect(centreFractionY(out, to)).toBeCloseTo(centreFractionY(b, from), 4);
  });

  it('keeps a full-bleed banner full-bleed', () => {
    // The one outcome nobody reads as correct is a banner that stopped
    // spanning, so a stretch axis takes its own ratio rather than k.
    const b = box(0, 0, SQ.width, 200);
    const out = reanchor(b, { x: 'stretch', y: 'top' }, SQ, LAND);
    expect(out.width).toBe(LAND.width);
    expect(classifyAnchors(out, LAND).x).toBe('stretch');
  });
});

/* ── reanchor: the factor, and the axis it applies to ─────────────────────── */

describe('reanchor: sizes take k, and each axis takes its own ratio', () => {
  it('leaves sizes untouched widening a square into a story', () => {
    // k = min(1080/1080, 1920/1080) = 1. This is the motivating case, and
    // "nothing shrinks" is the whole point of it.
    expect(resizeFactor(SQ, STORY)).toBe(1);
    const out = reanchor(box(100, 100, 400, 60), { x: 'left', y: 'top' }, SQ, STORY);
    expect(out.width).toBe(400);
    expect(out.height).toBe(60);
  });

  it('does not let one axis take the other axis ratio', () => {
    // rx = 1 and ry = 1.7778 here, so a stretch-X node whose width changed at
    // all is reading the vertical ratio. Both axes alike would hide this.
    const out = reanchor(box(0, 100, 1080, 60), { x: 'stretch', y: 'top' }, SQ, STORY);
    expect(out.width).toBe(1080);
    expect(out.height).toBe(60);
  });

  it('scales a stretch axis by that axis, not by k', () => {
    const out = reanchor(box(0, 0, 200, 1080), { x: 'left', y: 'stretch' }, SQ, STORY);
    expect(out.height).toBe(1920);
  });

  it('pulls a node that overflowed its frame back inside', () => {
    /*
     * The clamp is the only place the arithmetic stops being proportional, and
     * it bites in exactly one situation: a node whose box already hangs off the
     * edge of its SOURCE frame. Scaling its origin proportionally would leave
     * it hanging off the target too.
     *
     * My first attempt at this test shrank an in-frame node hard and asserted
     * it stayed inside -- which it did, with or without the clamp, because a
     * proportional origin never leaves a proportional frame. It passed while
     * proving nothing. This is the case that actually reaches the branch: the
     * box runs 5px past the right edge and comes back flush against it.
     */
    const out = reanchor(box(1075, 500, 100, 40), { x: 'left', y: 'top' }, SQ, SQ);
    expect(out.x).toBe(980);
    expect(out.x + out.width).toBe(SQ.width);
  });
});

/* ── the documented lossiness ─────────────────────────────────────────────── */

describe('resizeFactor: lossy in the return direction, on purpose', () => {
  it('loses 44% of every size on a square -> story -> square round trip', () => {
    /*
     * Pinned so it cannot change silently. `min` is what "nothing overflows"
     * means and the motivating direction is the one it gets right, but the
     * return trip shrinks and a user will meet that.
     *
     * The reversible path is a different gesture: the command captures the
     * nodes it replaced, so undo restores them exactly. "Try a story, dislike
     * it, go back" is Cmd+Z, not a second resize.
     *
     * If someone makes resize itself reversible, this test going red is the
     * signal that they changed a documented behaviour rather than fixed an
     * unnoticed bug.
     */
    expect(resizeFactor(SQ, STORY) * resizeFactor(STORY, SQ)).toBeCloseTo(0.5625, 6);
    expect(resizeFactor(SQ, LAND) * resizeFactor(LAND, SQ)).toBeCloseTo(0.5625, 6);
  });

  it('is the identity for an unchanged frame', () => {
    expect(resizeFactor(SQ, SQ)).toBe(1);
  });

  it('refuses to divide by a degenerate frame', () => {
    expect(resizeFactor({ width: 0, height: 100 }, STORY)).toBe(1);
    expect(resizeFactor({ width: 100, height: 0 }, STORY)).toBe(1);
  });
});
