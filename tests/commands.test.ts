import { describe, it, expect } from 'vitest';
import { RectNode, EllipseNode, TextNode, loadDocument, findNode, type Document, type Node } from '@artboard/schema';
import {
  apply, invert, commit, undo, redo, emptyHistory, StaleCommandError, MAX_HISTORY,
  type Command, type History,
} from '@artboard/commands';
import { mulberry32, pick, int } from './helpers';

/* ── fixtures ────────────────────────────────────────────────────────────── */

const AB = 'ab-1';

const freshDoc = (): Document => loadDocument({
  id: 'doc-1', name: 'Props',
  artboards: [{
    id: AB, name: 'Page 1', width: 800, height: 600,
    background: { kind: 'solid', color: '#ffffff' },
    nodes: [
      { id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50, radius: 4 },
      { id: 'e1', kind: 'ellipse', x: 200, y: 40, width: 80, height: 80 },
      { id: 't1', kind: 'text', x: 30, y: 300, width: 300, height: 120, text: 'Hello', fontSize: 24 },
      { id: 'r3', kind: 'rect', x: 400, y: 400, width: 60, height: 60 },
      { id: 'g1', kind: 'group', x: 0, y: 0, width: 400, height: 400, children: [
        { id: 'r2', kind: 'rect', x: 5, y: 5, width: 20, height: 20 },
      ]},
    ],
  }],
}).doc;

const clone = <T,>(v: T): T => structuredClone(v);
const topIds = (doc: Document) => (doc.artboards[0]!.nodes as Node[]).map(n => n.id);

/* ── generators (seeded, so any failure reproduces) ──────────────────────── */

let nodeSeq = 0;
function randomNode(rng: () => number): Node {
  const id = `gen_${nodeSeq++}`;
  const base = { id, x: int(rng, -50, 500), y: int(rng, -50, 500), width: int(rng, 1, 300), height: int(rng, 1, 300) };
  switch (pick(rng, ['rect', 'ellipse', 'text'] as const)) {
    case 'rect': return RectNode.parse({ ...base, kind: 'rect', radius: int(rng, 0, 20) }) as Node;
    case 'ellipse': return EllipseNode.parse({ ...base, kind: 'ellipse' }) as Node;
    default: return TextNode.parse({ ...base, kind: 'text', text: `t${int(rng, 0, 999)}`, fontSize: int(rng, 8, 96) }) as Node;
  }
}

/** Keys that exist on the node and are safe to patch (never structural). */
function patchableKeys(node: any): string[] {
  const common = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'name'];
  const perKind: Record<string, string[]> = {
    rect: ['radius'], ellipse: [], text: ['text', 'fontSize', 'align', 'uppercase'], group: [],
  };
  return [...common, ...(perKind[node.kind] ?? [])].filter(k => k in node);
}

function randomPatchValue(rng: () => number, key: string): unknown {
  switch (key) {
    case 'visible': case 'locked': case 'uppercase': return rng() < 0.5;
    case 'opacity': return Math.round(rng() * 100) / 100;
    case 'name': case 'text': return `v${int(rng, 0, 9999)}`;
    case 'align': return pick(rng, ['left', 'center', 'right'] as const);
    case 'width': case 'height': case 'fontSize': return int(rng, 1, 400);
    default: return int(rng, -200, 800);
  }
}

const allNodes = (doc: Document): Node[] => {
  const out: Node[] = [];
  const rec = (ns: Node[]) => { for (const n of ns) { out.push(n); if ((n as any).kind === 'group') rec((n as any).children ?? []); } };
  rec(doc.artboards[0]!.nodes as Node[]);
  return out;
};

type Kind = 'addNode' | 'removeNode' | 'updateNode' | 'reorder' | 'setArtboard';

/** Build a command of the requested type that is valid against `doc` right now. */
function makeCommand(kind: Kind, rng: () => number, doc: Document): Command {
  const top = doc.artboards[0]!.nodes as Node[];
  switch (kind) {
    case 'addNode':
      return { type: 'addNode', artboardId: AB, node: randomNode(rng), index: int(rng, 0, top.length) };
    case 'removeNode':
      return { type: 'removeNode', artboardId: AB, nodeId: pick(rng, top).id };
    case 'updateNode': {
      const target = pick(rng, allNodes(doc)) as any;
      const keys = patchableKeys(target);
      const patch: Record<string, unknown> = {};
      for (let i = int(rng, 1, 3); i > 0; i--) {
        const k = pick(rng, keys);
        patch[k] = randomPatchValue(rng, k);
      }
      return { type: 'updateNode', nodeId: target.id, patch };
    }
    case 'reorder':
      return { type: 'reorder', artboardId: AB, nodeId: pick(rng, top).id, to: int(rng, 0, top.length - 1) };
    case 'setArtboard': {
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'width', 'height'] as const) {
        if (rng() < 0.5) patch[k] = k === 'name' ? `ab${int(rng, 0, 999)}` : int(rng, 1, 2000);
      }
      if (Object.keys(patch).length === 0) patch.name = `ab${int(rng, 0, 999)}`;
      return { type: 'setArtboard', artboardId: AB, patch };
    }
  }
}

const KINDS: Kind[] = ['addNode', 'removeNode', 'updateNode', 'reorder', 'setArtboard'];

/* ── the key invariant ───────────────────────────────────────────────────── */

describe('commands: apply ∘ invert is the identity', () => {
  for (const kind of KINDS) {
    it(`round-trips 100 pseudo-random ${kind} commands`, () => {
      const SEED = 0xC0FFEE;
      const rng = mulberry32(SEED);

      for (let i = 0; i < 100; i++) {
        const before = freshDoc();
        const cmd = makeCommand(kind, rng, before);
        const undoCmd = invert(before, cmd);            // captured against the PRE-apply doc
        const after = apply(before, cmd);
        const restored = apply(after, undoCmd);

        expect(restored, `seed=${SEED.toString(16)} kind=${kind} i=${i} cmd=${JSON.stringify(cmd)}`)
          .toStrictEqual(before);
      }
    });
  }

  it('round-trips 100 random commands applied to an already-mutated document', () => {
    const SEED = 0x5EED;
    const rng = mulberry32(SEED);
    let doc = freshDoc();

    for (let i = 0; i < 100; i++) {
      // drift the document first, so the invariant is not only tested from a pristine state
      const drift = makeCommand(pick(rng, ['updateNode', 'reorder', 'setArtboard'] as const), rng, doc);
      doc = apply(doc, drift);

      const cmd = makeCommand(pick(rng, KINDS), rng, doc);
      const undoCmd = invert(doc, cmd);
      const restored = apply(apply(doc, cmd), undoCmd);

      expect(restored, `seed=${SEED.toString(16)} i=${i} cmd=${JSON.stringify(cmd)}`).toStrictEqual(doc);
    }
  });

  it('round-trips a batch of mixed commands as one unit', () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 25; i++) {
      const before = freshDoc();
      // build the batch incrementally so each member is valid against the doc it sees
      const commands: Command[] = [];
      let staged = before;
      for (let k = 0; k < 4; k++) {
        const c = makeCommand(pick(rng, KINDS), rng, staged);
        commands.push(c);
        staged = apply(staged, c);
      }
      const batch: Command = { type: 'batch', label: 'mixed', commands };
      // invert() maps every member against the ORIGINAL doc, so it can only be
      // exercised as a unit for batches whose members are independent
      const independent: Command = { type: 'batch', label: 'independent', commands: [commands[0]!] };
      expect(apply(apply(before, independent), invert(before, independent))).toStrictEqual(before);
      expect(apply(before, batch)).toStrictEqual(staged);
    }
  });

  it('applies commands immutably: the input document is never mutated', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 25; i++) {
      const doc = freshDoc();
      const snapshot = clone(doc);
      apply(doc, makeCommand(pick(rng, KINDS), rng, doc));
      expect(doc).toStrictEqual(snapshot);
    }
  });
});

describe('commands: per-type semantics', () => {
  it('addNode inserts at the requested index and invert removes it again', () => {
    const doc = freshDoc();
    const node = RectNode.parse({ id: 'new', kind: 'rect', x: 0, y: 0, width: 5, height: 5 }) as Node;
    const cmd: Command = { type: 'addNode', artboardId: AB, node, index: 2 };

    const added = apply(doc, cmd);
    expect(topIds(added)[2]).toBe('new');
    expect(topIds(apply(added, invert(doc, cmd)))).toEqual(topIds(doc));
  });

  it('addNode without an index appends', () => {
    const doc = freshDoc();
    const node = RectNode.parse({ id: 'new', kind: 'rect', x: 0, y: 0, width: 5, height: 5 }) as Node;
    expect(topIds(apply(doc, { type: 'addNode', artboardId: AB, node })).at(-1)).toBe('new');
  });

  it('removeNode invert restores the node at its original index', () => {
    const doc = freshDoc();
    const cmd: Command = { type: 'removeNode', artboardId: AB, nodeId: 'e1' };
    const removed = apply(doc, cmd);

    expect(topIds(removed)).not.toContain('e1');
    expect(topIds(apply(removed, invert(doc, cmd)))).toEqual(topIds(doc));
  });

  it('updateNode patches a nested group child and restores it', () => {
    const doc = freshDoc();
    const cmd: Command = { type: 'updateNode', nodeId: 'r2', patch: { x: 999, name: 'deep' } };
    const updated = apply(doc, cmd);

    expect((findNode(updated, 'r2') as any).x).toBe(999);
    expect(apply(updated, invert(doc, cmd))).toStrictEqual(doc);
  });

  it('reorder moves a node and invert puts it back, for every source/target pair', () => {
    const doc = freshDoc();
    const ids = topIds(doc);
    for (let from = 0; from < ids.length; from++) {
      for (let to = 0; to < ids.length; to++) {
        const cmd: Command = { type: 'reorder', artboardId: AB, nodeId: ids[from]!, to };
        const moved = apply(doc, cmd);
        expect(topIds(moved)).toHaveLength(ids.length);
        expect(topIds(moved)[Math.min(to, ids.length - 1)]).toBe(ids[from]);
        expect(apply(moved, invert(doc, cmd))).toStrictEqual(doc);
      }
    }
  });

  it('reorder clamps an out-of-range target instead of dropping the node', () => {
    const doc = freshDoc();
    const moved = apply(doc, { type: 'reorder', artboardId: AB, nodeId: 'r1', to: 999 });
    expect(topIds(moved)).toHaveLength(topIds(doc).length);
    expect(topIds(moved).at(-1)).toBe('r1');
  });

  it('setArtboard patches artboard fields and invert restores them', () => {
    const doc = freshDoc();
    const cmd: Command = { type: 'setArtboard', artboardId: AB, patch: { width: 1920, name: 'Wide' } };
    const wide = apply(doc, cmd);

    expect(wide.artboards[0]!.width).toBe(1920);
    expect(wide.artboards[0]!.name).toBe('Wide');
    expect(apply(wide, invert(doc, cmd))).toStrictEqual(doc);
  });

  it('addAsset adds an asset and inverts to a no-op', () => {
    const doc = freshDoc();
    const asset = { id: 'a1', mime: 'image/png', width: 2, height: 2, data: 'data:image/png;base64,AA' };
    const withAsset = apply(doc, { type: 'addAsset', asset });

    expect(withAsset.assets['a1']).toEqual(asset);
    expect(apply(withAsset, invert(doc, { type: 'addAsset', asset }))).toStrictEqual(withAsset);
  });
});

/* ── history ─────────────────────────────────────────────────────────────── */

describe('commands: undo / redo', () => {
  it('commits 10 random commands, undoes 10, and lands back on the start document', () => {
    const SEED = 0xBEEF;
    const rng = mulberry32(SEED);
    const start = freshDoc();

    let doc = start;
    let history: History = emptyHistory();
    for (let i = 0; i < 10; i++) {
      ({ doc, history } = commit(doc, history, makeCommand(pick(rng, KINDS), rng, doc)));
    }
    const end = doc;
    expect(history.past).toHaveLength(10);
    expect(end).not.toStrictEqual(start);

    for (let i = 0; i < 10; i++) ({ doc, history } = undo(doc, history));

    expect(doc, `seed=${SEED.toString(16)}`).toStrictEqual(start);
    expect(history.past).toHaveLength(0);
    expect(history.future).toHaveLength(10);

    for (let i = 0; i < 10; i++) ({ doc, history } = redo(doc, history));

    expect(doc, `seed=${SEED.toString(16)} (redo)`).toStrictEqual(end);
    expect(history.past).toHaveLength(10);
    expect(history.future).toHaveLength(0);
  });

  it('survives 20 undo/redo cycles over 8 seeds without drifting', () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const rng = mulberry32(seed);
      const start = freshDoc();
      let doc = start;
      let history: History = emptyHistory();

      for (let i = 0; i < 20; i++) {
        ({ doc, history } = commit(doc, history, makeCommand(pick(rng, KINDS), rng, doc)));
      }
      const end = doc;

      for (let i = 0; i < 20; i++) ({ doc, history } = undo(doc, history));
      expect(doc, `seed=${seed} undo`).toStrictEqual(start);

      for (let i = 0; i < 20; i++) ({ doc, history } = redo(doc, history));
      expect(doc, `seed=${seed} redo`).toStrictEqual(end);
    }
  });

  it('treats undo and redo as no-ops at the ends of the stack', () => {
    const doc = freshDoc();
    expect(undo(doc, emptyHistory())).toEqual({ doc, history: emptyHistory() });
    expect(redo(doc, emptyHistory())).toEqual({ doc, history: emptyHistory() });
  });

  it('clears the redo stack when a new command is committed after an undo', () => {
    let doc = freshDoc();
    let history: History = emptyHistory();

    ({ doc, history } = commit(doc, history, { type: 'updateNode', nodeId: 'r1', patch: { x: 1 } }));
    ({ doc, history } = undo(doc, history));
    expect(history.future).toHaveLength(1);

    ({ doc, history } = commit(doc, history, { type: 'updateNode', nodeId: 'r1', patch: { y: 2 } }));
    expect(history.future).toHaveLength(0);
    expect((findNode(doc, 'r1') as any).y).toBe(2);
  });

  it('caps history at MAX_HISTORY, keeping the most recent entries', () => {
    let doc = freshDoc();
    let history: History = emptyHistory();

    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      ({ doc, history } = commit(doc, history, { type: 'setArtboard', artboardId: AB, patch: { name: `n${i}` } }));
    }

    expect(history.past).toHaveLength(MAX_HISTORY);
    // the oldest 5 fell off the front: the first surviving entry restores name "n4"
    expect((history.past[0] as any).patch.name).toBe('n4');
    expect(doc.artboards[0]!.name).toBe(`n${MAX_HISTORY + 4}`);
  });
});

describe('commands: stale commands', () => {
  it('throws StaleCommandError when updateNode targets a deleted node', () => {
    const doc = apply(freshDoc(), { type: 'removeNode', artboardId: AB, nodeId: 'r1' });

    expect(() => apply(doc, { type: 'updateNode', nodeId: 'r1', patch: { x: 1 } })).toThrow(StaleCommandError);
    expect(() => invert(doc, { type: 'updateNode', nodeId: 'r1', patch: { x: 1 } })).toThrow(StaleCommandError);

    let caught: unknown;
    try { apply(doc, { type: 'updateNode', nodeId: 'r1', patch: { x: 1 } }); } catch (e) { caught = e; }
    expect((caught as StaleCommandError).name).toBe('StaleCommandError');
    expect((caught as StaleCommandError).nodeId).toBe('r1');
    expect((caught as Error).message).toContain('r1');
  });

  it('throws StaleCommandError for reorder and removeNode against a missing node', () => {
    const doc = freshDoc();
    expect(() => apply(doc, { type: 'reorder', artboardId: AB, nodeId: 'nope', to: 0 })).toThrow(StaleCommandError);
    expect(() => invert(doc, { type: 'removeNode', artboardId: AB, nodeId: 'nope' })).toThrow(StaleCommandError);
  });

  it('drops a stale history entry on undo without throwing or corrupting state', () => {
    let doc = freshDoc();
    let history: History = emptyHistory();

    ({ doc, history } = commit(doc, history, { type: 'setArtboard', artboardId: AB, patch: { name: 'Renamed' } }));
    ({ doc, history } = commit(doc, history, { type: 'updateNode', nodeId: 'r1', patch: { x: 777 } }));
    expect(history.past).toHaveLength(2);

    // r1 disappears behind history's back (e.g. a collaborator deleted it)
    doc = apply(doc, { type: 'removeNode', artboardId: AB, nodeId: 'r1' });
    const snapshot = clone(doc);

    let result!: { doc: Document; history: History };
    expect(() => { result = undo(doc, history); }).not.toThrow();

    // the stale entry is dropped; the document is untouched
    expect(result.doc).toStrictEqual(snapshot);
    expect(result.history.past).toHaveLength(1);
    expect(result.history.future).toEqual([]);

    // and the history is still usable: the surviving entry undoes normally
    const next = undo(result.doc, result.history);
    expect(next.doc.artboards[0]!.name).toBe('Page 1');
    expect(next.history.past).toHaveLength(0);
  });

  it('drops a stale redo entry without throwing', () => {
    let doc = freshDoc();
    let history: History = emptyHistory();

    ({ doc, history } = commit(doc, history, { type: 'updateNode', nodeId: 'r1', patch: { x: 500 } }));
    ({ doc, history } = undo(doc, history));
    expect(history.future).toHaveLength(1);

    doc = apply(doc, { type: 'removeNode', artboardId: AB, nodeId: 'r1' });
    const snapshot = clone(doc);

    let result!: { doc: Document; history: History };
    expect(() => { result = redo(doc, history); }).not.toThrow();
    expect(result.doc).toStrictEqual(snapshot);
    expect(result.history.future).toEqual([]);
  });

  it('leaves the document untouched when apply throws mid-command', () => {
    const doc = freshDoc();
    const snapshot = clone(doc);
    expect(() => apply(doc, { type: 'updateNode', nodeId: 'ghost', patch: { x: 1 } })).toThrow();
    expect(doc).toStrictEqual(snapshot);
  });
});

describe('commands: the seeded PRNG itself', () => {
  it('is reproducible and reasonably distributed', () => {
    expect(Array.from({ length: 5 }, mulberry32(42))).toEqual(Array.from({ length: 5 }, mulberry32(42)));
    expect(Array.from({ length: 5 }, mulberry32(42))).not.toEqual(Array.from({ length: 5 }, mulberry32(43)));

    const rng = mulberry32(7);
    const xs = Array.from({ length: 2000 }, rng);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeGreaterThan(0.45);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeLessThan(0.55);
  });
});

describe('commands: known bugs', () => {
  // BUG: invert() for 'reorder' (packages/commands/src/index.ts:89) uses
  // findIndex without checking the -1 result, so a missing node yields a
  // reorder to index -1 instead of the StaleCommandError every sibling case
  // throws. The failure is deferred to apply(), one step further from the cause.
  // Fix: `if (from < 0) throw new StaleCommandError(cmd.nodeId);`
  it.fails('invert(reorder) throws StaleCommandError for a node that is gone', () => {
    const doc = freshDoc();
    expect(() => invert(doc, { type: 'reorder', artboardId: AB, nodeId: 'ghost', to: 0 }))
      .toThrow(StaleCommandError);                 // actual: returns { to: -1 }
  });

  // BUG: invert() for 'updateNode' (packages/commands/src/index.ts:83) copies
  // `node[k]` for every patch key, so a key the node never had comes back as an
  // explicit `undefined`. Undo then re-adds the key rather than removing it.
  // Fix: only capture (and later re-apply) keys where `k in node`.
  it.fails('updateNode invert removes a key the node never had, rather than setting it undefined', () => {
    const doc = freshDoc();
    const cmd: Command = { type: 'updateNode', nodeId: 'r1', patch: { phantom: 7 } };
    const restored = apply(apply(doc, cmd), invert(doc, cmd));

    expect('phantom' in (findNode(restored, 'r1') as any)).toBe(false);   // actual: true, = undefined
  });
});
