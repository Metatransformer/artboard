import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION, DocumentParseError, parseDocument, loadDocument, findNode, walk, buildNode,
  type Document, type Node,
} from '@artboard/schema';
import { baseDoc } from './helpers';

const minimal = {
  id: 'doc-min',
  artboards: [{ id: 'ab-1', width: 400, height: 300, nodes: [] }],
};

describe('schema: parsing', () => {
  it('parses a valid minimal document', () => {
    const { doc, readOnly, diagnostics } = loadDocument(minimal);
    expect(readOnly).toBe(false);
    expect(diagnostics).toEqual([]);
    expect(doc.id).toBe('doc-min');
    expect(doc.artboards).toHaveLength(1);
    expect(doc.artboards[0]!.width).toBe(400);
  });

  it('parses a document containing nodes of every supported kind', () => {
    const doc = baseDoc();
    const kinds = new Set<string>();
    walk(doc, (n) => kinds.add((n as any).kind));
    expect(kinds).toEqual(new Set(['rect', 'ellipse', 'text', 'group']));
    // group children are reached by walk, so the recursive union resolved
    expect(findNode(doc, 'r2')).not.toBeNull();
  });

  it('throws DocumentParseError with a useful message on malformed JSON', () => {
    let caught: unknown;
    try { parseDocument('{ "id": "x", oops }'); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(DocumentParseError);
    const err = caught as DocumentParseError;
    expect(err.name).toBe('DocumentParseError');
    expect(err.message).toMatch(/Document is damaged/);
    // the message must carry the underlying syntax detail, not just "unreadable"
    expect(err.detail.length).toBeGreaterThan(0);
    expect(err.detail).not.toBe('unreadable');
    expect(err.message.length).toBeGreaterThan('Document is damaged: '.length);
  });

  it('throws DocumentParseError naming the offending field on a schema violation', () => {
    let caught: unknown;
    try {
      loadDocument({ id: 'x', artboards: [{ id: 'a', width: 0, height: 300, nodes: [] }] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DocumentParseError);
    expect((caught as DocumentParseError).message).toMatch(/width/);
  });

  it('rejects a document with no artboards', () => {
    expect(() => loadDocument({ id: 'x', artboards: [] })).toThrow(DocumentParseError);
  });
});

describe('schema: forward compatibility', () => {
  it('opens a newer-version document read-only with a VERSION_NEWER diagnostic instead of throwing', () => {
    const future = { ...minimal, version: SCHEMA_VERSION + 7 };
    const result = loadDocument(future);

    expect(result.readOnly).toBe(true);
    const diag = result.diagnostics.find(d => d.code === 'VERSION_NEWER');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('warn');
    expect(diag!.message).toContain(`v${SCHEMA_VERSION + 7}`);
    // the document itself still parsed, with its version preserved (never down-migrated)
    expect(result.doc.version).toBe(SCHEMA_VERSION + 7);
    expect(result.doc.diagnostics).toContainEqual(diag);
  });

  it('preserves an unknown node kind as an opaque node', () => {
    const { doc } = loadDocument({
      ...minimal,
      artboards: [{
        id: 'ab-1', width: 400, height: 300, nodes: [
          { id: 'o1', kind: 'opaque', originalKind: 'video', raw: { src: 'x.mp4' }, x: 0, y: 0, width: 10, height: 10 },
        ],
      }],
    });
    const node = findNode(doc, 'o1') as any;
    expect(node.kind).toBe('opaque');
    expect(node.originalKind).toBe('video');
    expect(node.raw).toEqual({ src: 'x.mp4' });
  });

  it('migrates a version-less document up to the current version', () => {
    const { doc, readOnly } = loadDocument({ id: 'old', artboards: [{ id: 'a', width: 10, height: 10, nodes: [] }] });
    expect(readOnly).toBe(false);
    expect(doc.version).toBe(SCHEMA_VERSION);
  });
});

describe('schema: integrity', () => {
  it('reports a missing image asset as a diagnostic and still parses the document', () => {
    const result = loadDocument({
      ...minimal,
      artboards: [{
        id: 'ab-1', width: 400, height: 300, nodes: [
          { id: 'i1', kind: 'image', assetId: 'nope', x: 0, y: 0, width: 100, height: 100 },
        ],
      }],
    });

    const diag = result.diagnostics.find(d => d.code === 'ASSET_MISSING');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('error');
    expect(diag!.nodeId).toBe('i1');
    expect(diag!.message).toContain('nope');

    // parsed, not thrown: the node survives so the user can relink it
    expect(findNode(result.doc, 'i1')).not.toBeNull();
    expect(result.readOnly).toBe(false);
  });

  it('emits no ASSET_MISSING when the asset is present', () => {
    const result = loadDocument({
      ...minimal,
      assets: { 'img-1': { id: 'img-1', mime: 'image/png', width: 2, height: 2, data: 'data:image/png;base64,AA' } },
      artboards: [{
        id: 'ab-1', width: 400, height: 300, nodes: [
          { id: 'i1', kind: 'image', assetId: 'img-1', x: 0, y: 0, width: 100, height: 100 },
        ],
      }],
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('finds a dangling asset ref nested inside a group', () => {
    const result = loadDocument({
      ...minimal,
      artboards: [{
        id: 'ab-1', width: 400, height: 300, nodes: [
          { id: 'g', kind: 'group', x: 0, y: 0, width: 10, height: 10, children: [
            { id: 'i-deep', kind: 'image', assetId: 'gone', x: 0, y: 0, width: 5, height: 5 },
          ]},
        ],
      }],
    });
    expect(result.diagnostics.map(d => d.nodeId)).toContain('i-deep');
  });
});

describe('schema: defaults', () => {
  it('applies node defaults (a text node without opacity gets opacity 1)', () => {
    const { doc } = loadDocument({
      ...minimal,
      artboards: [{
        id: 'ab-1', width: 400, height: 300, nodes: [
          { id: 't1', kind: 'text', x: 0, y: 0, width: 100, height: 40, text: 'hi' },
        ],
      }],
    });
    const t = findNode(doc, 't1') as any;

    expect(t.opacity).toBe(1);
    expect(t.visible).toBe(true);
    expect(t.locked).toBe(false);
    expect(t.rotation).toBe(0);
    expect(t.shadow).toBeNull();
    expect(t.name).toBe('');
    expect(t.flipX).toBe(false);
    expect(t.flipY).toBe(false);
    expect(t.alt).toBe('');
    expect(t.effects).toEqual([]);
    expect(t.blend).toBe('normal');
    // text-specific defaults
    expect(t.fontFamily).toBe('Inter');
    expect(t.fontSize).toBe(48);
    expect(t.fontWeight).toBe(600);
    expect(t.lineHeight).toBe(1.2);
    expect(t.align).toBe('left');
    expect(t.valign).toBe('top');
    expect(t.color).toBe('#111111');
    expect(t.uppercase).toBe(false);
    expect(t.italic).toBe(false);
    expect(t.letterSpacing).toBe(0);
  });

  it('applies document and artboard defaults', () => {
    const { doc } = loadDocument(minimal);
    expect(doc.version).toBe(SCHEMA_VERSION);
    expect(doc.name).toBe('Untitled');
    expect(doc.assets).toEqual({});
    expect(doc.diagnostics).toEqual([]);
    expect(doc.artboards[0]!.name).toBe('Artboard');
    expect(doc.artboards[0]!.background).toMatchObject({ kind: 'solid', color: '#ffffff' });
  });

  it('applies shape fill/stroke defaults', () => {
    const { doc } = loadDocument({
      ...minimal,
      artboards: [{ id: 'ab-1', width: 400, height: 300, nodes: [
        { id: 'r1', kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
      ]}],
    });
    const r = findNode(doc, 'r1') as any;
    expect(r.fill).toMatchObject({ kind: 'solid', color: '#4f46e5' });
    // Assert the fields this test is about, not the whole object: `Stroke`
    // gains fields over time (markers, etc.) and each one has a default that
    // preserves this behaviour, so exact equality would rot on every addition.
    expect(r.stroke).toMatchObject({ color: '#000000', width: 0, dash: [] });
    expect(r.radius).toBe(0);
  });

  it('does not overwrite explicitly provided values with defaults', () => {
    const { doc } = loadDocument({
      ...minimal,
      artboards: [{ id: 'ab-1', width: 400, height: 300, nodes: [
        { id: 't1', kind: 'text', x: 0, y: 0, width: 10, height: 10, opacity: 0.25, align: 'right', fontSize: 12 },
      ]}],
    });
    const t = findNode(doc, 't1') as any;
    expect(t.opacity).toBe(0.25);
    expect(t.align).toBe('right');
    expect(t.fontSize).toBe(12);
  });
});

describe('schema: round trip', () => {
  const coreOf = (d: Document) => ({
    version: d.version, id: d.id, name: d.name, artboards: d.artboards, assets: d.assets,
  });

  it('survives a save/load cycle unchanged on the core fields', () => {
    const first = baseDoc();
    const reloaded = loadDocument(JSON.parse(JSON.stringify(first))).doc;
    expect(coreOf(reloaded)).toEqual(coreOf(first));
  });

  it('is stable across three cycles (defaults are idempotent, not re-applied differently)', () => {
    let doc = baseDoc();
    const core = coreOf(doc);
    for (let i = 0; i < 3; i++) doc = loadDocument(JSON.parse(JSON.stringify(doc))).doc;
    expect(coreOf(doc)).toEqual(core);
  });

  it('round-trips a document whose image asset is missing', () => {
    const first = loadDocument({
      ...minimal,
      artboards: [{ id: 'ab-1', width: 400, height: 300, nodes: [
        { id: 'i1', kind: 'image', assetId: 'gone', x: 0, y: 0, width: 10, height: 10 },
      ]}],
    }).doc;
    const reloaded = loadDocument(JSON.parse(JSON.stringify(first))).doc;
    expect(coreOf(reloaded)).toEqual(coreOf(first));
  });

  it('round-trips group children and asset bytes verbatim', () => {
    const first = baseDoc();
    const reloaded = loadDocument(JSON.parse(JSON.stringify(first))).doc;
    expect(findNode(reloaded, 'r2')).toEqual(findNode(first, 'r2'));
    expect(reloaded.assets['img-1']).toEqual(first.assets['img-1']);
  });

  it('parseDocument(string) and loadDocument(object) agree', () => {
    const doc = baseDoc();
    const json = JSON.stringify(doc);
    expect(coreOf(parseDocument(json).doc)).toEqual(coreOf(loadDocument(JSON.parse(json)).doc));
  });
});

describe('schema: known bugs', () => {
  // BUG: `loadDocument` returns `diagnostics: [...doc.diagnostics, ...diagnostics]`
  // in its final `return`. Since diagnostics are part of the saved
  // Document, every open/save cycle re-appends the same findings and the array
  // grows without bound. Fix: return only the freshly computed diagnostics.
  it.fails('does not accumulate diagnostics across repeated save/load cycles', () => {
    let doc = loadDocument({
      ...minimal,
      artboards: [{ id: 'ab-1', width: 400, height: 300, nodes: [
        { id: 'i1', kind: 'image', assetId: 'gone', x: 0, y: 0, width: 10, height: 10 },
      ]}],
    }).doc;

    const first = doc.diagnostics.length;
    for (let i = 0; i < 3; i++) doc = loadDocument(JSON.parse(JSON.stringify(doc))).doc;

    expect(doc.diagnostics).toHaveLength(first);   // actual: 1 → 2 → 3 → 4
  });
});

describe('schema: buildNode', () => {
  it('fills every default from a minimal literal', () => {
    const node = buildNode({ id: 'n1', kind: 'rect', x: 1, y: 2, width: 3, height: 4 }) as any;
    expect(node).toMatchObject({ id: 'n1', kind: 'rect', x: 1, y: 2, width: 3, height: 4 });
    // the point of buildNode: fields the caller never mentioned arrive anyway
    for (const key of ['name', 'rotation', 'opacity', 'visible', 'locked', 'shadow',
                       'flipX', 'flipY', 'alt', 'effects', 'blend', 'fill', 'stroke', 'radius']) {
      expect(node, key).toHaveProperty(key);
    }
  });

  it('builds every node kind', () => {
    const kinds: Array<Record<string, unknown>> = [
      { kind: 'rect' }, { kind: 'ellipse' }, { kind: 'line' }, { kind: 'text' },
      { kind: 'path', d: 'M0 0 L1 1' }, { kind: 'image', assetId: 'a' },
      { kind: 'group' }, { kind: 'opaque', originalKind: 'video', raw: null },
    ];
    for (const extra of kinds) {
      const node = buildNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, ...extra }) as any;
      expect(node.kind, JSON.stringify(extra)).toBe(extra.kind);
    }
  });

  it('throws DocumentParseError naming the kind when the literal is not a node', () => {
    let caught: unknown;
    try { buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: -5, height: 10 }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DocumentParseError);
    expect((caught as Error).message).toContain('rect');
  });

  it('rejects an unknown kind rather than inventing a node', () => {
    expect(() => buildNode({ id: 'n', kind: 'hologram', x: 0, y: 0, width: 1, height: 1 })).toThrow(DocumentParseError);
  });

  it('produces nodes a document will accept without further massaging', () => {
    const node = buildNode({ id: 'n1', kind: 'ellipse', x: 0, y: 0, width: 10, height: 10 });
    const { doc } = loadDocument({ id: 'd', artboards: [{ id: 'a', width: 50, height: 50, nodes: [node] }] });
    expect(findNode(doc, 'n1')).toEqual(node);
  });
});

describe('schema: effects', () => {
  const withEffects = (effects: unknown[]) => buildNode({
    id: 'n', kind: 'rect', x: 0, y: 0, width: 10, height: 10, effects,
  }) as any;

  it('accepts every effect kind and fills its defaults', () => {
    const kinds = ['shadow', 'glow', 'blur', 'outline', 'echo', 'background', 'curve', 'adjust', 'duotone', 'vignette'];
    for (const kind of kinds) {
      const node = withEffects([{ kind }]);
      expect(node.effects[0].kind, kind).toBe(kind);
      expect(Object.keys(node.effects[0]).length, `${kind} should have defaulted fields`).toBeGreaterThan(1);
    }
  });

  it('keeps stacked effects in the order they were written', () => {
    const node = withEffects([{ kind: 'blur' }, { kind: 'glow' }, { kind: 'shadow' }]);
    expect(node.effects.map((e: any) => e.kind)).toEqual(['blur', 'glow', 'shadow']);
  });

  it('defaults to no effects at all, so pre-effects documents are untouched', () => {
    expect((buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1 }) as any).effects).toEqual([]);
  });

  it('rejects an unknown effect kind', () => {
    expect(() => withEffects([{ kind: 'kaleidoscope' }])).toThrow(DocumentParseError);
  });

  it('enforces each effect’s numeric bounds', () => {
    expect(() => withEffects([{ kind: 'curve', amount: 200 }])).toThrow(DocumentParseError);
    expect(() => withEffects([{ kind: 'echo', count: 99 }])).toThrow(DocumentParseError);
    expect(() => withEffects([{ kind: 'adjust', hue: 400 }])).toThrow(DocumentParseError);
    expect(() => withEffects([{ kind: 'blur', radius: -1 }])).toThrow(DocumentParseError);
  });

  it('round-trips effects through a save/load cycle', () => {
    const first = loadDocument({ id: 'd', artboards: [{ id: 'a', width: 50, height: 50, nodes: [
      buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 10, height: 10,
        effects: [{ kind: 'glow', color: '#ff0000' }, { kind: 'blur', radius: 3 }] }),
    ]}]}).doc;
    const reloaded = loadDocument(JSON.parse(JSON.stringify(first))).doc;
    expect(findNode(reloaded, 'n')).toEqual(findNode(first, 'n'));
  });
});

describe('schema: blend, flip and alt', () => {
  it('accepts every declared blend mode and rejects an invented one', () => {
    for (const blend of ['normal', 'multiply', 'screen', 'overlay', 'luminosity']) {
      expect((buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1, blend }) as any).blend).toBe(blend);
    }
    expect(() => buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1, blend: 'teleport' }))
      .toThrow(DocumentParseError);
  });

  it('carries flipX / flipY independently', () => {
    const node = buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1, flipX: true }) as any;
    expect(node.flipX).toBe(true);
    expect(node.flipY).toBe(false);
  });

  it('keeps alt text verbatim', () => {
    const node = buildNode({ id: 'n', kind: 'image', assetId: 'a', x: 0, y: 0, width: 1, height: 1, alt: 'A red barn' }) as any;
    expect(node.alt).toBe('A red barn');
  });
});

describe('schema: gradients, text fill, strokes and frames', () => {
  it('defaults a gradient to linear, so pre-radial documents render unchanged', () => {
    const node = buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1,
      fill: { kind: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } }) as any;
    expect(node.fill).toMatchObject({ type: 'linear', angle: 90, cx: 0.5, cy: 0.5, r: 0.5 });
  });

  it('accepts a radial gradient with an explicit centre and radius', () => {
    const node = buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1,
      fill: { kind: 'gradient', type: 'radial', cx: 0.25, cy: 0.75, r: 0.9,
              stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } }) as any;
    expect(node.fill).toMatchObject({ type: 'radial', cx: 0.25, cy: 0.75, r: 0.9 });
  });

  it('requires at least two gradient stops', () => {
    expect(() => buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1,
      fill: { kind: 'gradient', stops: [{ offset: 0, color: '#000000' }] } })).toThrow(DocumentParseError);
  });

  it('leaves the optional text fill absent by default, keeping color the simple path', () => {
    const plain = buildNode({ id: 't', kind: 'text', x: 0, y: 0, width: 1, height: 1 }) as any;
    expect(plain.fill).toBeUndefined();
    expect(plain.color).toBe('#111111');

    const painted = buildNode({ id: 't', kind: 'text', x: 0, y: 0, width: 1, height: 1,
      fill: { kind: 'solid', color: '#ff0000' } }) as any;
    expect(painted.fill).toMatchObject({ kind: 'solid', color: '#ff0000' });
  });

  it('defaults stroke cap, join and markers to the SVG defaults', () => {
    const node = buildNode({ id: 'n', kind: 'line', x: 0, y: 0, width: 10, height: 0 }) as any;
    expect(node.stroke).toMatchObject({ cap: 'butt', join: 'miter', markerStart: 'none', markerEnd: 'none' });
  });

  it('accepts every marker shape and rejects an unknown one', () => {
    for (const markerEnd of ['none', 'arrow', 'dot', 'bar']) {
      expect((buildNode({ id: 'n', kind: 'line', x: 0, y: 0, width: 1, height: 1,
        stroke: { width: 2, markerEnd } }) as any).stroke.markerEnd).toBe(markerEnd);
    }
    expect(() => buildNode({ id: 'n', kind: 'line', x: 0, y: 0, width: 1, height: 1,
      stroke: { width: 2, markerEnd: 'starburst' } })).toThrow(DocumentParseError);
  });

  it('defaults an image frame to a plain rect', () => {
    const node = buildNode({ id: 'i', kind: 'image', assetId: 'a', x: 0, y: 0, width: 1, height: 1 }) as any;
    expect(node).toMatchObject({ frame: 'rect', frameD: '', frameBox: [24, 24] });
  });

  it('accepts ellipse and path frames', () => {
    expect((buildNode({ id: 'i', kind: 'image', assetId: 'a', x: 0, y: 0, width: 1, height: 1,
      frame: 'ellipse' }) as any).frame).toBe('ellipse');
    const pathFramed = buildNode({ id: 'i', kind: 'image', assetId: 'a', x: 0, y: 0, width: 1, height: 1,
      frame: 'path', frameD: 'M0 0 L24 24 Z', frameBox: [48, 48] }) as any;
    expect(pathFramed).toMatchObject({ frame: 'path', frameD: 'M0 0 L24 24 Z', frameBox: [48, 48] });
  });
});
