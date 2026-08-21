import { describe, it, expect } from 'vitest';
import { buildNode, loadDocument, findNode, type Document, type Node } from '@artboard/schema';
import { apply } from '@artboard/commands';
import { nodeBox } from '@artboard/engine';
import { renderToString } from '@artboard/render-svg';

/**
 * A group's STORED x/y/width/height is not the group's box. `nodeBox()` derives
 * the box from the children, and every reader goes through it -- rotation
 * pivot, selection rectangle, the eight handles, hit test, marquee, drag
 * origin, align/distribute, the Inspector fields.
 *
 * So the stored numbers are inert for any group that has children, and this
 * file pins that as a PROPERTY rather than leaving it as a fact someone
 * measured once. It was measured once: corrupting every group's stored box to
 * 0,0,1,1 across the whole golden corpus produced byte-identical SVG, which
 * read as blindness in the oracle before `nodeBox` existed and is the intended
 * invariant now.
 *
 * The reason it needs a test rather than a comment is that it is easy to break
 * silently and awkward to reach by hand. A reader that used `group.x` directly
 * would look right in every screenshot, agree with the Inspector, and be wrong
 * only for a group whose stored box had gone stale -- which is exactly how
 * `group.x/y` shipped as a field that displayed correctly and rendered nothing.
 *
 * The empty group is the one case where the stored box is load-bearing, and it
 * is asserted here as the control: a corruption that changes NOTHING anywhere
 * would satisfy every other assertion in this file.
 */

const AB = 'ab';
const leaf = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): Node =>
  buildNode({ id, kind: 'rect', x, y, width: 40, height: 30, fill: { kind: 'solid', color: '#336699' }, ...extra });

const blank = (): Document => loadDocument({
  id: 'd', name: 'd',
  artboards: [{ id: AB, name: 'ab', width: 400, height: 300,
    background: { kind: 'solid', color: '#ffffff' }, nodes: [] }],
  assets: {},
}).doc;

/** outer[ a, inner[ b, c ] ] */
const nested = (): Document => {
  let doc = blank();
  for (const n of [leaf('a', 10, 10), leaf('b', 80, 40), leaf('c', 150, 90)])
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: n });
  doc = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['b', 'c'], groupId: 'inner' });
  return apply(doc, { type: 'group', artboardId: AB, nodeIds: ['a', 'inner'], groupId: 'outer' });
};

const clone = (d: Document): Document => JSON.parse(JSON.stringify(d));
const svg = (d: Document): string => renderToString(d).svg;
const get = (d: Document, id: string): any => findNode(d, id);

/** Deliberately wreck a group's STORED box, without touching its children. */
const corrupt = (doc: Document, ids: string[]): Document => {
  const out = clone(doc);
  for (const id of ids) Object.assign(get(out, id), { x: -9999, y: 7777, width: 1, height: 1 });
  return out;
};

describe('group bounds: the stored box is inert while the group has children', () => {
  it('derives the same box after the stored one is wrecked', () => {
    const before = nested();
    const after = corrupt(before, ['outer', 'inner']);
    expect(nodeBox(get(after, 'outer'))).toEqual(nodeBox(get(before, 'outer')));
    expect(nodeBox(get(after, 'inner'))).toEqual(nodeBox(get(before, 'inner')));
  });

  it('renders identically after the stored box is wrecked', () => {
    // The measurement that started this, as an assertion. Children carry
    // absolute coordinates and a group emits <g> with no transform, so the
    // stored numbers reach no pixel.
    const before = nested();
    expect(svg(corrupt(before, ['outer', 'inner']))).toBe(svg(before));
  });

  it('derives an outer group through a wrecked inner one', () => {
    // nodeBox recurses, so an inner group's stored box is ignored on the way
    // up too. A version that recursed only one level would pass the flat case.
    const before = nested();
    const after = corrupt(before, ['inner']);
    expect(nodeBox(get(after, 'outer'))).toEqual(nodeBox(get(before, 'outer')));
  });

  it('bounds the children it actually has', () => {
    const doc = nested();
    // inner = b(80,40) + c(150,90), each 40x30 -> x 80..190, y 40..120
    expect(nodeBox(get(doc, 'inner'))).toEqual({ x: 80, y: 40, width: 110, height: 80 });
    // outer additionally contains a(10,10)
    expect(nodeBox(get(doc, 'outer'))).toEqual({ x: 10, y: 10, width: 180, height: 110 });
  });

  it('grows to contain a rotated child, not just its unrotated box', () => {
    // The child's own rotation is applied before union, so a tilted child
    // pushes the parent's box out. Taking the raw child box would silently
    // undersize the selection rectangle for every rotated group.
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: leaf('r', 100, 100, { rotation: 45 }) });
    doc = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['r'], groupId: 'g' });
    const box = nodeBox(get(doc, 'g'));
    const raw = { x: 100, y: 100, width: 40, height: 30 };
    expect(box.width).toBeGreaterThan(raw.width);
    expect(box.height).toBeGreaterThan(raw.height);
    expect(box.x).toBeLessThan(raw.x);
  });
});

describe('group bounds: the empty group is where the stored box still matters', () => {
  it('falls back to the stored box, and notices when it changes', () => {
    // THE CONTROL. Every assertion above is that a corruption changed nothing;
    // a nodeBox that ignored its argument entirely would satisfy all of them.
    // This is the case that must come out different.
    let doc = blank();
    doc = apply(doc, { type: 'addNode', artboardId: AB, node:
      buildNode({ id: 'empty', kind: 'group', x: 20, y: 30, width: 60, height: 70, children: [] }) });
    expect(nodeBox(get(doc, 'empty'))).toEqual({ x: 20, y: 30, width: 60, height: 70 });

    const wrecked = corrupt(doc, ['empty']);
    expect(nodeBox(get(wrecked, 'empty'))).toEqual({ x: -9999, y: 7777, width: 1, height: 1 });
    expect(nodeBox(get(wrecked, 'empty'))).not.toEqual(nodeBox(get(doc, 'empty')));
  });
});

describe('group bounds: the commands keep the stored box in agreement', () => {
  // Inert is not the same as free to be wrong. `scale` and `translate` write
  // the stored box so it stays consistent with the children -- an editor that
  // read it directly would be wrong, but a document that disagrees with itself
  // is still a bug, and it is the shape the whole group-drag saga had.
  it.each([
    ['translate', { type: 'translate', nodeIds: ['inner'], dx: 37, dy: -19 }],
    ['scale', { type: 'scale', nodeIds: ['inner'], sx: 2, sy: 3, ox: 5, oy: 5 }],
  ])('%s leaves stored and derived agreeing', (_label, cmd) => {
    const after = apply(nested(), cmd as any);
    const g = get(after, 'inner');
    const derived = nodeBox(g);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(g[k] - derived[k]), `stored ${k}=${g[k]} but derived ${k}=${derived[k]}`)
        .toBeLessThanOrEqual(0.011);
    }
  });
});
