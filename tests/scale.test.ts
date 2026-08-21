import { describe, it, expect } from 'vitest';
import { buildNode, loadDocument, findNode, type Document, type Node } from '@artboard/schema';
import { apply, invert, isAxisAligned, unscalableDescendant, StaleCommandError, InvalidCommandError, type Command } from '@artboard/commands';
import { renderToString } from '@artboard/render-svg';

/**
 * `scale` multiplies a subtree about a fixed point.
 *
 * THE ORACLE IS EXPRESSED ON POINTS, NOT ON SIZES. Scaling maps a point p to
 * o + (p - o) * s; a box is its two corners, and its width is whatever falls
 * out of transforming them. The implementation instead multiplies the size
 * directly (`width * sx`) and positions it separately. Those are two different
 * derivations of the same specification, so they agree only if both are right
 * -- which is the property that makes this an oracle rather than a mirror of
 * the code under test.
 *
 * The two derivations round at different moments (the implementation rounds x
 * and width independently; the oracle rounds after subtracting two unrounded
 * corners), so geometry is compared to within a hundredth. That tolerance is
 * far below every bug worth catching here: a swapped sx/sy, a scalar used
 * where an axis factor belongs, a forgotten origin, or a subtree scaled twice
 * all move numbers by whole units or more.
 *
 * WHAT IS DELIBERATELY NOT PINNED HERE: how a SCALAR -- a font size, a corner
 * radius, a stroke width -- follows a NON-UNIFORM scale. A box has two factors
 * and a font size is one number, and which number it should be is a live design
 * decision (see the fontSize test below). Every other test in this file is
 * written to be independent of that choice, so when it is settled exactly one
 * test moves and the diff says which decision changed.
 */

/* ── fixtures ────────────────────────────────────────────────────────────── */

const AB = 'ab';
const leaf = (id: string, x: number, y: number): Node =>
  buildNode({ id, kind: 'rect', x, y, width: 40, height: 30, radius: 4, fill: { kind: 'solid', color: '#336699' } });

const blank = (): Document => loadDocument({
  id: 'd', name: 'd',
  artboards: [{ id: AB, name: 'ab', width: 400, height: 300,
    background: { kind: 'solid', color: '#ffffff' }, nodes: [] }],
  assets: {},
}).doc;

/** outer[ a, inner[ b, c ] ] -- two depths, so recursion failures show up. */
const nested = (): Document => {
  let doc = blank();
  for (const n of [leaf('a', 10, 10), leaf('b', 80, 40), leaf('c', 150, 90)])
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: n });
  doc = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['b', 'c'], groupId: 'inner' });
  return apply(doc, { type: 'group', artboardId: AB, nodeIds: ['a', 'inner'], groupId: 'outer' });
};

const svg = (doc: Document): string => renderToString(doc).svg;
const reload = (doc: unknown): Document => loadDocument(JSON.parse(JSON.stringify(doc))).doc;
const get = (doc: Document, id: string): any => findNode(doc, id);

/* ── the oracle ──────────────────────────────────────────────────────────── */

type Sc = { sx: number; sy: number; ox: number; oy: number };

/** A point under the scale. This is the whole specification. */
const mapPoint = (px: number, py: number, s: Sc): [number, number] =>
  [s.ox + (px - s.ox) * s.sx, s.oy + (py - s.oy) * s.sy];

/** The box a node MUST end up with, derived from its transformed corners. */
const expectedBox = (n: any, s: Sc) => {
  const [x1, y1] = mapPoint(n.x, n.y, s);
  const [x2, y2] = mapPoint(n.x + n.width, n.y + n.height, s);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};

/** Every node id in a subtree, so the check reaches the leaves and not just the root. */
const idsIn = (n: any): string[] => [n.id, ...((n.children ?? []) as any[]).flatMap(idsIn)];

/** Assert the geometry of a whole subtree against the corner-derived oracle. */
const expectSubtreeScaled = (before: Document, after: Document, rootId: string, s: Sc) => {
  for (const id of idsIn(get(before, rootId))) {
    const want = expectedBox(get(before, id), s);
    const got = get(after, id);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(got[k] - (want as any)[k]), `${id}.${k}: got ${got[k]}, oracle says ${(want as any)[k]}`)
        .toBeLessThanOrEqual(0.011);
    }
  }
};

const scale = (nodeIds: string[], s: Sc): Command => ({ type: 'scale', nodeIds, ...s } as Command);

/* ── geometry ────────────────────────────────────────────────────────────── */

describe('scale: geometry against a corner-derived oracle', () => {
  it('scales a plain node uniformly about a point', () => {
    const before = nested();
    const s = { sx: 2, sy: 2, ox: 0, oy: 0 };
    expectSubtreeScaled(before, apply(before, scale(['a'], s)), 'a', s);
  });

  it('scales a plain node by different x and y factors', () => {
    const before = nested();
    const s = { sx: 3, sy: 0.5, ox: 100, oy: 50 };
    expectSubtreeScaled(before, apply(before, scale(['a'], s)), 'a', s);
  });

  it('scales a group and every descendant, at every depth', () => {
    const before = nested();
    const s = { sx: 1.5, sy: 2.5, ox: 20, oy: 20 };
    const after = apply(before, scale(['outer'], s));
    // 'a' is a child, 'b' and 'c' are grandchildren: a recursion that stops one
    // level early leaves the deepest pair behind and this catches it.
    expectSubtreeScaled(before, after, 'outer', s);
    expect(idsIn(get(before, 'outer')).sort()).toEqual(['a', 'b', 'c', 'inner', 'outer']);
  });

  it('leaves the origin exactly where it is', () => {
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: leaf('p', 70, 90) });
    const after = apply(doc, scale(['p'], { sx: 4, sy: 7, ox: 70, oy: 90 }));
    expect(get(after, 'p').x).toBe(70);
    expect(get(after, 'p').y).toBe(90);
  });

  it('scales a subtree once when a group and its own child are both selected', () => {
    const before = nested();
    const s = { sx: 2, sy: 2, ox: 0, oy: 0 };
    // If the walk did not stop at a selected node, 'b' would be scaled by
    // 'inner' and again on its own: 4x, not 2x. That is compounding, not
    // doubling, and it is the failure the oracle is aimed at.
    const after = apply(before, scale(['inner', 'b'], s));
    expectSubtreeScaled(before, after, 'inner', s);
  });

  it('does not touch nodes outside the selection', () => {
    const before = nested();
    const after = apply(before, scale(['inner'], { sx: 2, sy: 2, ox: 0, oy: 0 }));
    expect(get(after, 'a')).toEqual(get(before, 'a'));
  });
});

/* ── the thing the whole command exists to avoid ─────────────────────────── */

describe('scale: it is not a silent no-op', () => {
  it('changes the rendered output when a group is scaled', () => {
    // `group.x/y` moved a number and changed no pixels. A resize that reports
    // success and re-renders byte-identically is the same bug on the other
    // axis, so this asserts on the RENDER and not on the model.
    const before = nested();
    const after = apply(before, scale(['outer'], { sx: 2, sy: 2, ox: 0, oy: 0 }));
    expect(svg(after)).not.toBe(svg(before));
  });

  it('is a genuine no-op at factor 1, and says so by identity', () => {
    const doc = nested();
    expect(apply(doc, scale(['outer'], { sx: 1, sy: 1, ox: 0, oy: 0 }))).toBe(doc);
  });
});

/* ── undo ────────────────────────────────────────────────────────────────── */

describe('scale: apply o invert is the identity', () => {
  it('restores the document and the render exactly', () => {
    // The reason this matters more here than for `translate`: rounding is to
    // 2dp, so scaling by 2 and then by 0.5 does NOT return the original
    // numbers. A reciprocal-scale inverse would look obviously right and fail
    // this by a delta small enough to read as noise.
    const before = nested();
    const cmd = scale(['outer'], { sx: 1.37, sy: 2.11, ox: 13, oy: 29 });
    const undo = invert(before, cmd);
    const after = apply(before, cmd);
    const back = apply(after, undo);
    expect(back).toEqual(before);
    expect(svg(back)).toBe(svg(before));
  });

  it('round-trips a scale that is not invertible by reciprocal', () => {
    const before = nested();
    // 1/3 then 3 loses digits at 2dp; captured state does not.
    const cmd = scale(['inner'], { sx: 1 / 3, sy: 1 / 3, ox: 7, oy: 11 });
    const back = apply(apply(before, cmd), invert(before, cmd));
    expect(back).toEqual(before);
  });
});

/* ── refusals ────────────────────────────────────────────────────────────── */

describe('scale: what it refuses', () => {
  it.each([
    ['zero x factor', { sx: 0, sy: 1, ox: 0, oy: 0 }],
    ['zero y factor', { sx: 1, sy: 0, ox: 0, oy: 0 }],
    ['a negative factor, because mirroring is flipX/flipY', { sx: -1, sy: 1, ox: 0, oy: 0 }],
    ['a non-finite factor', { sx: Number.POSITIVE_INFINITY, sy: 1, ox: 0, oy: 0 }],
    ['a NaN origin', { sx: 2, sy: 2, ox: Number.NaN, oy: 0 }],
  ])('refuses %s', (_label, s) => {
    const doc = nested();
    expect(() => apply(doc, scale(['outer'], s as Sc))).toThrow(InvalidCommandError);
  });

  it('refuses to scale a node that is not there', () => {
    const doc = nested();
    expect(() => apply(doc, scale(['ghost'], { sx: 2, sy: 2, ox: 0, oy: 0 }))).toThrow(StaleCommandError);
  });

  it('refuses rather than silently scaling nothing', () => {
    // A refusal that returns the document unchanged would be the lying-field
    // bug wearing a different hat: the caller sees success and no change.
    const doc = nested();
    let threw = false;
    try { apply(doc, scale(['outer'], { sx: -2, sy: 1, ox: 0, oy: 0 })); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

/* ── scalars ─────────────────────────────────────────────────────────────── */

describe('scale: scalars', () => {
  const withText = (): Document => {
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: buildNode({
      id: 't', kind: 'text', x: 0, y: 0, width: 200, height: 60,
      text: 'Hello world', fontSize: 20 }) });
    return doc;
  };

  it('multiplies a font size by the factor under a uniform scale', () => {
    // Uniform is the case with no design question in it: every candidate rule
    // agrees, so this can be exact and must stay exact.
    const after = apply(withText(), scale(['t'], { sx: 3, sy: 3, ox: 0, oy: 0 }));
    expect(get(after, 't').fontSize).toBe(60);
  });

  it('does not take a font size from the HORIZONTAL factor', () => {
    /*
     * DELIBERATELY A DISJUNCTION, because the rule is undecided.
     *
     * A font size is one number and a non-uniform scale supplies two, so it is
     * either the vertical factor sy (a font size is a vertical measure; a
     * sideways stretch should widen the frame and reflow the text, not enlarge
     * the glyphs) or the geometric mean sqrt(sx*sy) (it preserves area ratio
     * and is continuous). Both are defensible and the choice is renderer-wins'
     * to make.
     *
     * What is NOT defensible is sx: taking a vertical measure from the
     * horizontal factor. This pins that, and nothing else, so the live decision
     * stays open and a wrong answer still cannot land quietly.
     */
    const sx = 4, sy = 1.21;
    const after = apply(withText(), scale(['t'], { sx, sy, ox: 0, oy: 0 }));
    const got = get(after, 't').fontSize;
    const candidates = { sy: 20 * sy, geometricMean: 20 * Math.sqrt(sx * sy) };
    expect(
      Object.values(candidates).some(c => Math.abs(got - c) <= 0.011),
      `fontSize became ${got}; expected the vertical factor (${candidates.sy}) or the geometric mean (${candidates.geometricMean}), not the horizontal factor (${20 * sx})`,
    ).toBe(true);
  });

  it('floors a font size at 1 and stays reloadable', () => {
    // The schema floors fontSize at 1, so an aggressive shrink would otherwise
    // produce a node that cannot be read back from disk. Intended, not a
    // rounding artefact -- a fuzzer with wide factors will find it.
    const after = apply(withText(), scale(['t'], { sx: 0.001, sy: 0.001, ox: 0, oy: 0 }));
    expect(get(after, 't').fontSize).toBe(1);
    expect(() => reload(after)).not.toThrow();
  });

  it('keeps a shrunk subtree reloadable at every depth', () => {
    const after = apply(nested(), scale(['outer'], { sx: 0.01, sy: 0.01, ox: 0, oy: 0 }));
    expect(() => reload(after)).not.toThrow();
  });
});

/* ── bounds ──────────────────────────────────────────────────────────────── */

describe('scale: stored group bounds stay honest', () => {
  it('leaves a group box in agreement with its children', () => {
    /*
     * Scoped to this command on purpose, exactly as for `translate`, and NOT to
     * be promoted into a global invariant or a fuzz post-condition: fixtures
     * exist whose group boxes are already stale, and asserting this everywhere
     * would make those documents fail for something `scale` did not do.
     *
     * `scale` recomputes nothing -- it multiplies the group's own box in the
     * same pass as its children -- so agreement is preserved rather than
     * repaired. A version that recomputed the box from the children would pass
     * this test while silently FIXING an already-wrong document, which is how a
     * disagreement gets hidden instead of found.
     */
    const s = { sx: 2, sy: 3, ox: 5, oy: 5 };
    const before = nested();
    const after = apply(before, scale(['inner'], s));
    const g = get(after, 'inner');
    const kids = (g.children as any[]);
    const minX = Math.min(...kids.map(k => k.x));
    const minY = Math.min(...kids.map(k => k.y));
    const maxX = Math.max(...kids.map(k => k.x + k.width));
    const maxY = Math.max(...kids.map(k => k.y + k.height));
    expect(Math.abs(g.x - minX)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(g.y - minY)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(g.width - (maxX - minX))).toBeLessThanOrEqual(0.011);
    expect(Math.abs(g.height - (maxY - minY))).toBeLessThanOrEqual(0.011);
  });
});

/* ── quarter turns ───────────────────────────────────────────────────────── */

describe('scale: isAxisAligned measures distance to the NEARER quarter turn', () => {
  it('accepts exact quarter turns, including negative ones', () => {
    for (const r of [0, 90, 180, 270, 360, -90, -180]) expect(isAxisAligned(r)).toBe(true);
  });

  it('accepts a rotation a hair BELOW a quarter turn', () => {
    /*
     * The whole reason the function is written the way it is, and invisible to
     * any test that only tries 0/90/180.
     *
     * `89.99999999999999 % 90` is `89.99999999999999` -- NOT a near-zero
     * remainder. A modulo-and-compare test (`r <= tol`) therefore refuses a
     * rotation one float step below a quarter turn while accepting one a step
     * above it, which is an asymmetry with no basis in the geometry: both are
     * the same distance from a right angle and both are perfectly scalable.
     * Taking `min(r, 90 - r)` is what removes it.
     */
    expect(isAxisAligned(89.99999999999999)).toBe(true);
    expect(isAxisAligned(90.00000000000001)).toBe(true);
    expect(isAxisAligned(269.99999999999997)).toBe(true);
    // The naive version, stated explicitly so the difference is on the record.
    const naive = (r: number) => Math.abs(r) % 90 <= 1e-6;
    expect(naive(90.00000000000001)).toBe(true);
    expect(naive(89.99999999999999)).toBe(false);
  });

  it('refuses a rotation that is genuinely off-axis, at both ends', () => {
    for (const r of [0.001, 20, 45, 89.9, 90.1, -20]) expect(isAxisAligned(r)).toBe(false);
  });
});

describe('scale: the parallelogram refusal', () => {
  /** outer[ inner[ tilted ] ] -- the rotated node is a GRANDCHILD, so a
   *  recursion that only checks the root returns null and lets it through. */
  const withTilt = (deg: number): Document => {
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: leaf('flat', 10, 10) });
    doc = apply(doc, { type: 'addNode', artboardId: AB, node:
      buildNode({ id: 'tilted', kind: 'rect', x: 80, y: 40, width: 100, height: 50, rotation: deg }) });
    doc = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['tilted'], groupId: 'inner' });
    return apply(doc, { type: 'group', artboardId: AB, nodeIds: ['flat', 'inner'], groupId: 'outer' });
  };

  it('finds a rotated node at depth, not just at the top', () => {
    const doc = withTilt(20);
    const found = unscalableDescendant(get(doc, 'outer'));
    expect(found?.id).toBe('tilted');
    expect(unscalableDescendant(get(doc, 'flat'))).toBeNull();
  });

  it('refuses a non-uniform scale over a rotated descendant', () => {
    // A 100x50 rect at 20deg under scale (2,1) has 115.7deg between adjacent
    // edges. A node is an axis-aligned box plus an angle, so the result is not
    // a shape the schema can store -- refusing beats storing something that
    // renders differently from what the handles showed.
    const doc = withTilt(20);
    expect(() => apply(doc, scale(['outer'], { sx: 2, sy: 1, ox: 0, oy: 0 }))).toThrow(InvalidCommandError);
  });

  it('names the offending node and its angle, not just the selection', () => {
    // The selection is 'outer'; the problem is 'tilted', two levels down. An
    // error naming only what the user clicked is unactionable.
    const doc = withTilt(20);
    let msg = '';
    try { apply(doc, scale(['outer'], { sx: 2, sy: 1, ox: 0, oy: 0 })); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('tilted');
    expect(msg).toContain('20');
  });

  it('allows a non-uniform scale over a quarter-turned descendant', () => {
    // A quarter turn only swaps the axes, so the box stays a box.
    for (const deg of [90, 180, 270]) {
      const doc = withTilt(deg);
      expect(() => apply(doc, scale(['outer'], { sx: 2, sy: 1, ox: 0, oy: 0 }))).not.toThrow();
    }
  });

  it('allows a UNIFORM scale at any angle', () => {
    const doc = withTilt(20);
    const s = { sx: 2, sy: 2, ox: 0, oy: 0 };
    const after = apply(doc, scale(['outer'], s));
    expectSubtreeScaled(doc, after, 'outer', s);
    expect(get(after, 'tilted').rotation).toBe(20);
  });

  it('treats factors a thousandth apart as non-uniform, and float noise as uniform', () => {
    /*
     * The boundary that killed the gesture in the editor: ratio-locking against
     * a GRID-SNAPPED box produced sx and sy a thousandth apart, the command
     * called that non-uniform and refused every frame, and the transient
     * swallowed it. Fixed editor-side by sending one factor when the subtree is
     * locked -- but the command's own boundary is what a fuzzer will find, so
     * it is pinned here rather than left implicit.
     *
     * A thousandth apart is a real difference and must refuse. A part in 1e12
     * is a genuinely square drag arriving through division and must not.
     */
    const doc = withTilt(20);
    expect(() => apply(doc, scale(['outer'], { sx: 1.5, sy: 1.501, ox: 0, oy: 0 }))).toThrow(InvalidCommandError);
    expect(() => apply(doc, scale(['outer'], { sx: 1.5, sy: 1.5 + 1e-12, ox: 0, oy: 0 }))).not.toThrow();
  });
});

/* ── the rule that is currently in force ─────────────────────────────────── */

describe('scale: every scalar agrees under a uniform scale', () => {
  it('multiplies font size, letter spacing, stroke width and radius by the same factor', () => {
    // Uniform is the case users actually hit, and it is the one with no design
    // question in it: sy, sx and the geometric mean are all the same number, so
    // this is exact and must stay exact. If these ever disagree under a uniform
    // scale, one of them is not reading the factor it thinks it is.
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: buildNode({
      id: 'tx', kind: 'text', x: 0, y: 0, width: 200, height: 60, text: 'Hello',
      fontSize: 20, letterSpacing: 3 }) });
    // Stroke and radius live on the shape kinds, not on text.
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: buildNode({
      id: 'rc', kind: 'rect', x: 0, y: 0, width: 40, height: 30, radius: 4,
      stroke: { color: '#000000', width: 6, dash: [2, 8] } }) });
    const after = apply(doc, scale(['tx', 'rc'], { sx: 2.5, sy: 2.5, ox: 0, oy: 0 }));
    expect(get(after, 'tx').fontSize).toBe(50);
    expect(get(after, 'tx').letterSpacing).toBe(7.5);
    expect(get(after, 'rc').stroke.width).toBe(15);
    expect(get(after, 'rc').stroke.dash).toEqual([5, 20]);
    expect(get(after, 'rc').radius).toBe(10);
  });

  it('takes a font size from sy and letter spacing from sx under a non-uniform scale', () => {
    /*
     * The decision, now settled and measured (35efc25). This is the ONE place
     * it is pinned exactly; the disjunction test above is the permanent guard
     * that survives the rule changing again, this one is the current answer.
     *
     * Why sy and not the geometric mean: under the mean, a horizontal stretch
     * enlarges the glyphs AND widens the frame, so the reflow the stretch was
     * meant to cause partly cancels itself. Under sy a horizontal stretch is
     * purely a reflow, which is what every design tool does. Browser-measured:
     * an east drag at sx=1.3548 sy=1.0001 leaves the glyphs at x1.0000, where
     * the geometric mean predicted x1.1640.
     */
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: buildNode({
      id: 'tx', kind: 'text', x: 0, y: 0, width: 200, height: 60, text: 'Hello',
      fontSize: 20, letterSpacing: 10 }) });
    const after = apply(doc, scale(['tx'], { sx: 4, sy: 1.5, ox: 0, oy: 0 }));
    expect(get(after, 'tx').fontSize).toBe(30);
    expect(get(after, 'tx').letterSpacing).toBe(40);
  });
});
