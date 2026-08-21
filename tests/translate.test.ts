import { describe, it, expect } from 'vitest';
import { buildNode, loadDocument, findNode, type Document, type Node } from '@artboard/schema';
import { apply, invert, StaleCommandError, InvalidCommandError, type Command } from '@artboard/commands';
import { renderToString } from '@artboard/render-svg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `translate` exists because `group.x/y` has no rendering meaning.
 *
 * Every node carries absolute artboard coordinates and the renderer emits a
 * group as `<g>` with no transform, so setting a group's x/y moved the number
 * in the model and nothing on the screen: the command reported success and the
 * re-render was byte-identical. These tests assert on RENDERED OUTPUT, because
 * the model was never the thing that was wrong -- an assertion that
 * `group.x` changed would have passed throughout that bug.
 *
 * The oracle is a reference document rather than hand-written coordinates:
 * translating a subtree MUST render exactly like the same document with every
 * node in that subtree offset by the same delta. That is the specification
 * restated, not a mirror of the implementation, so it cannot share a bug with
 * the code under test. Deltas and coordinates are integers because `apply`
 * rounds.
 */

/* ── fixtures ────────────────────────────────────────────────────────────── */

const AB = 'ab';
const leaf = (id: string, x: number, y: number): Node =>
  buildNode({ id, kind: 'rect', x, y, width: 40, height: 30, fill: { kind: 'solid', color: '#336699' } });

/** outer[ a, inner[ b, c ] ] -- two depths, so recursion failures show up. */
const nested = (): Document => {
  let doc = loadDocument({
    id: 'd', name: 'd',
    artboards: [{ id: AB, name: 'ab', width: 400, height: 300,
      background: { kind: 'solid', color: '#ffffff' }, nodes: [] }],
    assets: {},
  }).doc;
  for (const n of [leaf('a', 10, 10), leaf('b', 80, 40), leaf('c', 150, 90)])
    doc = apply(doc, { type: 'addNode', artboardId: AB, node: n });
  doc = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['b', 'c'], groupId: 'inner' });
  return apply(doc, { type: 'group', artboardId: AB, nodeIds: ['a', 'inner'], groupId: 'outer' });
};

const svg = (doc: Document): string => renderToString(doc).svg;
const reload = (doc: unknown): Document => loadDocument(JSON.parse(JSON.stringify(doc))).doc;

/** The specification: offset every node in the subtree by the same delta. */
const offset = (n: any, dx: number, dy: number): any => ({
  ...n, x: n.x + dx, y: n.y + dy,
  ...(n.children ? { children: n.children.map((c: any) => offset(c, dx, dy)) } : {}),
});

/** The document `translate` is required to be indistinguishable from. */
const reference = (doc: Document, ids: string[], dx: number, dy: number): Document => {
  const rec = (nodes: any[]): any[] => nodes.map(n =>
    ids.includes(n.id) ? offset(n, dx, dy)
      : n.children ? { ...n, children: rec(n.children) } : n);
  return reload({ ...doc, artboards: (doc as any).artboards.map((ab: any) => ({ ...ab, nodes: rec(ab.nodes) })) });
};

const translate = (nodeIds: string[], dx: number, dy: number): Command =>
  ({ type: 'translate', nodeIds, dx, dy });

/** Bounds a group's children actually occupy. Test nodes are unrotated. */
const childBounds = (g: any) => {
  const xs = g.children.flatMap((c: any) => [c.x, c.x + c.width]);
  const ys = g.children.flatMap((c: any) => [c.y, c.y + c.height]);
  return { x: Math.min(...xs), y: Math.min(...ys),
           width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

/* ── the artwork moves ───────────────────────────────────────────────────── */

describe('commands: translate moves what is drawn', () => {
  it('is not a vacuous comparison -- the reference really differs from the original', () => {
    const doc = nested();
    expect(svg(reference(doc, ['outer'], 25, 15))).not.toBe(svg(doc));
  });

  it('moves a plain node by the delta', () => {
    const doc = nested();
    expect(svg(apply(doc, translate(['a'], 25, 15)))).toBe(svg(reference(doc, ['a'], 25, 15)));
  });

  it('moves every child of a group by the same delta', () => {
    const doc = nested();
    expect(svg(apply(doc, translate(['inner'], -30, 20)))).toBe(svg(reference(doc, ['inner'], -30, 20)));
  });

  it('moves a nested group at every depth', () => {
    const doc = nested();
    const moved = apply(doc, translate(['outer'], 25, 15));
    expect(svg(moved)).toBe(svg(reference(doc, ['outer'], 25, 15)));
    // Named explicitly: a version that shifted only the top level would render
    // the group's own box right and leave the grandchildren behind.
    const c = findNode(moved, 'c') as any;
    expect([c.x, c.y]).toStrictEqual([175, 105]);
  });

  it('moves several selected nodes at once', () => {
    const doc = nested();
    expect(svg(apply(doc, translate(['b', 'c'], 12, -8)))).toBe(svg(reference(doc, ['b', 'c'], 12, -8)));
  });

  it('does not move a child twice when the selection also names its group', () => {
    const doc = nested();
    // Dragging a group with one of its own children still selected is an
    // ordinary thing to do in the editor, and double-shifting the child is the
    // obvious way to implement this wrong.
    expect(svg(apply(doc, translate(['outer', 'c'], 25, 15)))).toBe(svg(reference(doc, ['outer'], 25, 15)));
  });

  it('restores the render byte-for-byte on undo', () => {
    const doc = nested();
    const cmd = translate(['outer'], 25, 15);
    expect(svg(apply(apply(doc, cmd), invert(doc, cmd)))).toBe(svg(doc));
  });

  it('rejects a stale id without moving anything', () => {
    const doc = nested();
    expect(() => apply(doc, translate(['outer', 'ghost'], 25, 15))).toThrow(StaleCommandError);
  });
});

/* ── the bug itself, not the symptom ─────────────────────────────────────── */

describe('commands: a group no longer lies about where it is', () => {
  it('keeps a translated group’s bounds agreeing with its children', () => {
    // SCOPED DELIBERATELY to translate. This is a POST-CONDITION of translate,
    // NOT a document invariant: group bounds are a stored copy of a derived
    // value with no invalidation, so an ordinary `updateNode` on a CHILD's x or
    // width leaves them stale too. Asserting this globally (e.g. in the fuzz
    // loop in commands.test.ts) goes red on commands that are not bugs.
    //
    // It earns its place here because it is the one wrong implementation the
    // rendered-output oracle above CANNOT see: shifting the children and
    // forgetting the group's own x/y renders byte-identically to the correct
    // result -- precisely because the renderer ignores group x/y, which is the
    // property that caused the original bug.
    const moved = apply(nested(), translate(['outer'], 25, 15));
    for (const id of ['outer', 'inner']) {
      const g = findNode(moved, id) as any;
      const want = childBounds(g);
      expect({ x: g.x, y: g.y, width: g.width, height: g.height }).toStrictEqual(want);
    }
  });

  it('refuses to patch a group’s x/y instead of silently doing nothing', () => {
    // The original bug: this reported success and changed no pixel. Fixing only
    // the drag path would have left the Inspector and the MCP server still
    // able to issue it.
    expect(() => apply(nested(), { type: 'updateNode', nodeId: 'outer', patch: { x: 99, y: 99 } }))
      .toThrow(InvalidCommandError);
  });

  it('still lets a plain node be patched the ordinary way', () => {
    // The guard must be about groups, not about x/y -- a rect keeps working.
    const moved = apply(nested(), { type: 'updateNode', nodeId: 'a', patch: { x: 99 } });
    expect((findNode(moved, 'a') as any).x).toBe(99);
  });
});

/* ── against the committed fixture, not a synthetic one ──────────────────── */

describe('commands: translate on a real document', () => {
  const fixture = (): Document => reload(JSON.parse(readFileSync(
    fileURLToPath(new URL('./golden/insert-data.json', import.meta.url)), 'utf8')));

  it('moves a generated chart group and puts it back exactly', () => {
    const doc = fixture();
    const cmd = translate(['n_chart001-g'], 40, 25);
    const moved = apply(doc, cmd);
    expect(svg(moved)).not.toBe(svg(doc));
    expect(svg(moved)).toBe(svg(reference(doc, ['n_chart001-g'], 40, 25)));
    expect(svg(apply(moved, invert(doc, cmd)))).toBe(svg(doc));
  });
});
