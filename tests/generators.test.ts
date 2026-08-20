import { describe, it, expect } from 'vitest';
import { Node, buildNode, loadDocument } from '@artboard/schema';
import { TEMPLATES } from '@artboard/templates';
import { buildChart, type ChartKind } from '@artboard/charts';
import { qrNode, barcodeNode } from '@artboard/codes';

/**
 * Every package that MAKES nodes has to make whole ones.
 *
 * `makeGroup` shipped a group missing `alt`, `flipX` and `flipY`, so the group
 * a user made stopped matching the group a reload parsed. The three fields
 * were not the bug -- the bug was a node built by hand instead of by the
 * schema, which falls behind silently every time the schema grows. These tests
 * are the class-level guard, and they have already caught the next instance:
 * @artboard/codes had lost `cap`, `join`, `markerStart` and `markerEnd` on its
 * stroke, all four added to the schema after that package was written.
 *
 * Two different contracts, so two different checks:
 *
 *  - `codes` and `charts` return finished `Node`s, which go straight into a
 *    document. Parsing one must change nothing.
 *  - a template's `build()` returns a partial SPEC on purpose -- `store.tsx`
 *    feeds it to `loadDocument`, which is what fills the defaults. Requiring
 *    completeness there would be requiring the wrong thing, so what is checked
 *    is that the document it becomes is complete and stable.
 */
const parsesToItself = (n: unknown) => expect(Node.parse(n)).toStrictEqual(n);

const walk = (n: any): any[] => [n, ...((n?.children ?? []) as any[]).flatMap(walk)];

describe('generators: charts produce finished nodes', () => {
  const spec = (kind: ChartKind) => ({
    kind, labels: ['a', 'b', 'c'],
    series: [{ name: 's1', values: [3, 1, 2] }, { name: 's2', values: [1, 4, 2] }],
    x: 0, y: 0, width: 400, height: 300, title: 'T', showValues: true,
  });

  it.each(['bar', 'column', 'line', 'area', 'scatter', 'pie', 'donut'] as ChartKind[])('%s', kind => {
    const nodes = buildChart(spec(kind)).flatMap(walk);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) parsesToItself(n);
  });
});

describe('generators: codes produce finished nodes', () => {
  it('qrNode', () => {
    for (const opts of [
      { text: 'https://example.com', x: 10, y: 10, size: 120 },
      { text: 'hello', x: 0, y: 0, size: 64, light: '#ffffff' },   // adds the background rect
    ]) {
      const nodes = qrNode(opts as any).flatMap(walk);
      expect(nodes.length).toBeGreaterThan(0);
      for (const n of nodes) parsesToItself(n);
    }
  });

  it.each([['code128', 'ABC-123'], ['ean13', '012345678905']] as const)('barcodeNode %s', (symbology, text) => {
    // showText adds a second node of a different kind, so cover both
    for (const showText of [false, true]) {
      const nodes = barcodeNode({ text, symbology, x: 0, y: 0, width: 200, height: 80, showText } as any).flatMap(walk);
      expect(nodes.length).toBeGreaterThan(0);
      for (const n of nodes) parsesToItself(n);
    }
  });

  it('mirrors the schema exactly, rather than approximately', () => {
    // @artboard/codes deliberately depends on nothing, so it re-declares the
    // node and stroke shapes instead of importing them. That is a reasonable
    // trade, but a hand-maintained copy of a growing schema drifts by
    // construction -- this is the check that makes the next drift loud.
    const produced = qrNode({ text: 'x', x: 0, y: 0, size: 40 } as any)[0]! as any;
    const fromSchema = buildNode({ id: 'x', kind: 'path', x: 0, y: 0, width: 40, height: 40, d: 'M0 0' }) as any;

    expect(Object.keys(produced).sort()).toEqual(Object.keys(fromSchema).sort());
    expect(Object.keys(produced.stroke).sort()).toEqual(Object.keys(fromSchema.stroke).sort());
  });
});

describe('generators: templates become finished documents', () => {
  // Mirrors what store.tsx does with a template, minus the id stamping.
  const asDocument = (t: (typeof TEMPLATES)[number]) => {
    const built = t.build();
    return loadDocument({
      version: 1, id: 'doc', name: t.name,
      artboards: [{ id: 'ab', name: t.name, width: built.width, height: built.height,
        background: built.background, nodes: built.nodes }],
      assets: {}, diagnostics: [],
    }).doc;
  };

  it.each(TEMPLATES.map(t => t.id))('%s', id => {
    const t = TEMPLATES.find(x => x.id === id)!;
    const doc = asDocument(t);
    const nodes = doc.artboards[0]!.nodes.flatMap(walk);

    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) parsesToItself(n);

    // and the document a user gets is the document a reload gives back
    expect(loadDocument(JSON.parse(JSON.stringify(doc))).doc.artboards).toStrictEqual(doc.artboards);
  });

  it('loads without a single error diagnostic', () => {
    for (const t of TEMPLATES) {
      const errors = asDocument(t).diagnostics.filter((d: any) => d.level === 'error');
      expect(errors, t.id).toEqual([]);
    }
  });
});
