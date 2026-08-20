import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION, DocumentParseError, parseDocument, loadDocument, findNode, walk,
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
    expect(doc.artboards[0]!.background).toEqual({ kind: 'solid', color: '#ffffff' });
  });

  it('applies shape fill/stroke defaults', () => {
    const { doc } = loadDocument({
      ...minimal,
      artboards: [{ id: 'ab-1', width: 400, height: 300, nodes: [
        { id: 'r1', kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
      ]}],
    });
    const r = findNode(doc, 'r1') as any;
    expect(r.fill).toEqual({ kind: 'solid', color: '#4f46e5' });
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
  // BUG: loadDocument returns `diagnostics: [...doc.diagnostics, ...fresh]`
  // (packages/schema/src/index.ts:192). Since diagnostics are part of the saved
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
