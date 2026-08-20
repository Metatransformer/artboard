import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('generators: the inventory above is the whole inventory', () => {
  /**
   * This file is only as good as its list of generators. A new package that
   * makes nodes and never gets a `describe` block here leaves the suite green
   * on something it has never looked at -- the same green-oracle-on-an-
   * uncovered-path failure that hid grouping, image fits and the codes drift.
   *
   * So the list is derived, and the hand-maintained part is an EXCLUSION:
   * every package found to construct nodes must be named below with where it
   * is tested. Forgetting to classify a new one fails loudly; forgetting to
   * add one to a hand-written include list would have failed silently, which
   * is the polarity that keeps going wrong here.
   */
  const KINDS = ['rect', 'text', 'ellipse', 'line', 'path', 'image', 'group'];

  /** Where each node-producing package is covered. Add a package, or explain it. */
  const ACCOUNTED_FOR: Record<string, string> = {
    templates: 'this file -- generators: templates become finished documents',
    charts: 'this file -- generators: charts produce finished nodes',
    codes: 'this file -- generators: codes produce finished nodes',
    commands: 'tests/commands.test.ts -- makeGroup produces a schema-complete group node',
  };

  const root = fileURLToPath(new URL('../packages/', import.meta.url));

  const sourcesOf = (dir: string): string[] => {
    const out: string[] = [];
    const visit = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) visit(join(d, e.name));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(join(d, e.name));
      }
    };
    visit(dir);
    return out;
  };

  // A construction site, not a mention: `kind: 'rect',` inside an object
  // literal. Type declarations end in `;`, comparisons use `===`, and the
  // schema itself uses z.literal -- none of those make a node.
  const CONSTRUCTS = new RegExp(`kind: '(${KINDS.join('|')})',`);
  const producers = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, 'src')))
    .filter(e => sourcesOf(join(root, e.name, 'src')).some(f => {
      const src = readFileSync(f, 'utf8');
      return src.split('\n').some(line => CONSTRUCTS.test(line) && !line.includes('z.literal'));
    }))
    .map(e => e.name);

  it('finds the generators it expects to find', () => {
    // If this drops to nothing the detection broke, and every assertion below
    // would pass vacuously.
    expect(producers.length).toBeGreaterThanOrEqual(4);
    expect(producers).toEqual(expect.arrayContaining(['templates', 'charts', 'codes']));
  });

  it('has every node-producing package accounted for', () => {
    const unaccounted = producers.filter(p => !(p in ACCOUNTED_FOR));
    expect(unaccounted, `these packages construct nodes and nothing names where they are tested: ${unaccounted.join(', ')}`)
      .toEqual([]);
  });

  it('does not name a package that stopped producing nodes', () => {
    // The other direction: a stale entry means the note points at coverage
    // that no longer has a subject.
    expect(Object.keys(ACCOUNTED_FOR).filter(p => !producers.includes(p))).toEqual([]);
  });
});
