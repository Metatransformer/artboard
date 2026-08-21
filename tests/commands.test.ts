import { describe, it, expect } from 'vitest';
import { buildNode, loadDocument, findNode, type Document, type Node } from '@artboard/schema';
import {
  apply, invert, commit, undo, redo, emptyHistory, MAX_HISTORY,
  StaleCommandError, StaleArtboardError, InvalidCommandError,
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
      buildNode({ id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50, radius: 4 }),
      buildNode({ id: 'e1', kind: 'ellipse', x: 200, y: 40, width: 80, height: 80 }),
      buildNode({ id: 't1', kind: 'text', x: 30, y: 300, width: 300, height: 120, text: 'Hello', fontSize: 24 }),
      buildNode({ id: 'r3', kind: 'rect', x: 400, y: 400, width: 60, height: 60 }),
      buildNode({ id: 'g1', kind: 'group', x: 0, y: 0, width: 400, height: 400, children: [
        buildNode({ id: 'r2', kind: 'rect', x: 5, y: 5, width: 20, height: 20 }),
      ]}),
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
    case 'rect': return buildNode({ ...base, kind: 'rect', radius: int(rng, 0, 20) });
    case 'ellipse': return buildNode({ ...base, kind: 'ellipse' });
    default: return buildNode({ ...base, kind: 'text', text: `t${int(rng, 0, 999)}`, fontSize: int(rng, 8, 96) });
  }
}

/**
 * Keys that exist on the node and are safe to patch (never structural).
 *
 * `x`/`y` are dropped for a group: `apply` refuses them now, because a group's
 * x/y is bounds metadata that no child draws from, and patching it moved the
 * selection handles while every child stayed put. The generator has to stop
 * producing the command that is now correctly rejected -- and `translate`,
 * which replaces it, is generated as its own kind below so the round-trip
 * invariant still covers moving a group.
 */
function patchableKeys(node: any): string[] {
  const common = node.kind === 'group'
    ? ['width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'name']
    : ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'name'];
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
    // `radius` is `min(0)` in the schema. It used to fall through to the
    // signed default and produce negative values, which `updateNode` accepted
    // and stored; the round-trip only broke much later, when grouping the node
    // re-validated it. `apply` refuses them now, so the generator has to stop
    // asking -- a property test asserting apply∘invert === identity has to
    // generate patches the schema would accept, or it is testing the refusal.
    case 'radius': return int(rng, 0, 40);
    default: return int(rng, -200, 800);
  }
}

const allNodes = (doc: Document): Node[] => {
  const out: Node[] = [];
  const rec = (ns: Node[]) => { for (const n of ns) { out.push(n); if ((n as any).kind === 'group') rec((n as any).children ?? []); } };
  rec(doc.artboards[0]!.nodes as Node[]);
  return out;
};

type Kind = 'addNode' | 'removeNode' | 'updateNode' | 'reorder' | 'setArtboard' | 'group' | 'ungroup' | 'translate';

const groupsIn = (doc: Document): Node[] =>
  (doc.artboards[0]!.nodes as Node[]).filter(n => (n as any).kind === 'group');

/** Whether a command of this type can be built against `doc` at all. */
function canMake(kind: Kind, doc: Document): boolean {
  const top = doc.artboards[0]!.nodes as Node[];
  if (kind === 'ungroup') return groupsIn(doc).length > 0;
  if (kind === 'group') return top.length >= 2;
  if (kind === 'removeNode' || kind === 'reorder' || kind === 'translate') return top.length > 0;
  return true;
}

let groupSeq = 0;

/** Build a command of the requested type that is valid against `doc` right now. */
function makeCommand(kind: Kind, rng: () => number, doc: Document): Command {
  const top = doc.artboards[0]!.nodes as Node[];
  switch (kind) {
    case 'group': {
      // a distinct, possibly non-contiguous selection of top-level nodes
      const pool = top.map(n => n.id);
      const count = int(rng, 1, Math.min(3, pool.length));
      const nodeIds: string[] = [];
      while (nodeIds.length < count) {
        const id = pick(rng, pool);
        if (!nodeIds.includes(id)) nodeIds.push(id);
      }
      return { type: 'group', artboardId: AB, nodeIds, groupId: `grp_${groupSeq++}` };
    }
    case 'ungroup':
      return { type: 'ungroup', artboardId: AB, groupId: pick(rng, groupsIn(doc)).id };
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
    case 'translate': {
      // Top-level only, and distinct: `apply` deliberately moves a matched
      // node's whole subtree and stops descending, so naming both a group and
      // its own child is not a double-move -- but it is also not what a
      // selection ever looks like, and generating it would test the guard
      // rather than the invariant.
      const pool = top.map(n => n.id);
      const nodeIds: string[] = [];
      for (let want = int(rng, 1, Math.min(3, pool.length)); nodeIds.length < want;) {
        const id = pick(rng, pool);
        if (!nodeIds.includes(id)) nodeIds.push(id);
      }
      // Integers: `apply` rounds, so a fractional delta would not invert to a
      // byte-identical document and the failure would indict the test.
      return { type: 'translate', nodeIds, dx: int(rng, -300, 300), dy: int(rng, -300, 300) };
    }
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

const KINDS: Kind[] = ['addNode', 'removeNode', 'updateNode', 'reorder', 'setArtboard', 'group', 'ungroup', 'translate'];

/** A random command of any type that is currently buildable. */
function anyCommand(rng: () => number, doc: Document): Command {
  const usable = KINDS.filter(k => canMake(k, doc));
  return makeCommand(pick(rng, usable), rng, doc);
}

/* ── the key invariant ───────────────────────────────────────────────────── */

describe('commands: apply ∘ invert is the identity', () => {
  for (const kind of KINDS) {
    it(`round-trips 100 pseudo-random ${kind} commands`, () => {
      const SEED = 0xC0FFEE;
      const rng = mulberry32(SEED);

      for (let i = 0; i < 100; i++) {
        const before = freshDoc();
        expect(canMake(kind, before), `${kind} must be buildable from the fixture`).toBe(true);
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

      const cmd = anyCommand(rng, doc);
      const undoCmd = invert(doc, cmd);
      const restored = apply(apply(doc, cmd), undoCmd);

      expect(restored, `seed=${SEED.toString(16)} i=${i} cmd=${JSON.stringify(cmd)}`).toStrictEqual(doc);
    }
  });

  it('round-trips a batch of mixed commands as one unit', () => {
    const rng = mulberry32(1234);

    for (let i = 0; i < 50; i++) {
      const before = freshDoc();
      // build the batch incrementally so each member is valid against the doc it sees
      const commands: Command[] = [];
      let staged = before;
      for (let k = 0; k < 4; k++) {
        const c = anyCommand(rng, staged);
        commands.push(c);
        staged = apply(staged, c);
      }
      const batch: Command = { type: 'batch', label: 'mixed', commands };

      expect(apply(before, batch), `i=${i} forward`).toStrictEqual(staged);
      expect(apply(apply(before, batch), invert(before, batch)), `i=${i} round trip`).toStrictEqual(before);
    }
  });

  it('inverts each batch member against the state that member actually saw', () => {
    // Deleting two non-adjacent nodes in one gesture: if every inverse were
    // captured against the starting document, the second re-insert would land
    // at a stale index and the z-order would come back wrong.
    const before = freshDoc();
    const batch: Command = { type: 'batch', label: 'delete two', commands: [
      { type: 'removeNode', artboardId: AB, nodeId: 'r1' },
      { type: 'removeNode', artboardId: AB, nodeId: 't1' },
    ]};

    const after = apply(before, batch);
    expect(topIds(after)).toEqual(['e1', 'r3', 'g1']);
    expect(topIds(apply(after, invert(before, batch)))).toEqual(topIds(before));
    expect(apply(after, invert(before, batch))).toStrictEqual(before);
  });

  it('undoes a batch in reverse order', () => {
    const before = freshDoc();
    const batch: Command = { type: 'batch', label: 'move then delete', commands: [
      { type: 'reorder', artboardId: AB, nodeId: 'r1', to: 3 },
      { type: 'removeNode', artboardId: AB, nodeId: 'e1' },
    ]};
    const undoCmd = invert(before, batch) as Extract<Command, { type: 'batch' }>;

    expect(undoCmd.commands[0]!.type).toBe('addNode');    // last change undone first
    expect(undoCmd.commands[1]!.type).toBe('reorder');
    expect(apply(apply(before, batch), undoCmd)).toStrictEqual(before);
  });

  it('applies commands immutably: the input document is never mutated', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 25; i++) {
      const doc = freshDoc();
      const snapshot = clone(doc);
      apply(doc, anyCommand(rng, doc));
      expect(doc).toStrictEqual(snapshot);
    }
  });
});

describe('commands: per-type semantics', () => {
  it('addNode inserts at the requested index and invert removes it again', () => {
    const doc = freshDoc();
    const node = buildNode({ id: 'new', kind: 'rect', x: 0, y: 0, width: 5, height: 5 });
    const cmd: Command = { type: 'addNode', artboardId: AB, node, index: 2 };

    const added = apply(doc, cmd);
    expect(topIds(added)[2]).toBe('new');
    expect(topIds(apply(added, invert(doc, cmd)))).toEqual(topIds(doc));
  });

  it('addNode without an index appends', () => {
    const doc = freshDoc();
    const node = buildNode({ id: 'new', kind: 'rect', x: 0, y: 0, width: 5, height: 5 });
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
      ({ doc, history } = commit(doc, history, anyCommand(rng, doc)));
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
        ({ doc, history } = commit(doc, history, anyCommand(rng, doc)));
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

describe('commands: group / ungroup', () => {
  it('wraps a contiguous selection where the topmost member sat', () => {
    const doc = freshDoc();                        // r1 e1 t1 r3 g1
    const grouped = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['e1', 't1'], groupId: 'G' });

    expect(topIds(grouped)).toEqual(['r1', 'G', 'r3', 'g1']);
    const g = findNode(grouped, 'G') as any;
    expect(g.kind).toBe('group');
    expect(g.children.map((c: Node) => c.id)).toEqual(['e1', 't1']);
  });

  it('keeps members in document order regardless of the order they were named', () => {
    const doc = freshDoc();
    const g = findNode(apply(doc, { type: 'group', artboardId: AB, nodeIds: ['r3', 'r1', 'e1'], groupId: 'G' }), 'G') as any;
    expect(g.children.map((c: Node) => c.id)).toEqual(['r1', 'e1', 'r3']);
  });

  it('sizes the group to the union of its members’ rotated bounds', () => {
    const doc = loadDocument({ id: 'd', artboards: [{ id: AB, width: 500, height: 500, nodes: [
      buildNode({ id: 'a', kind: 'rect', x: 0, y: 0, width: 100, height: 100 }),
      buildNode({ id: 'b', kind: 'rect', x: 200, y: 150, width: 50, height: 50 }),
    ]}]}).doc;
    const g = findNode(apply(doc, { type: 'group', artboardId: AB, nodeIds: ['a', 'b'], groupId: 'G' }), 'G') as any;

    expect(g).toMatchObject({ x: 0, y: 0, width: 250, height: 200 });
  });

  it('restores a non-contiguous selection to its exact original slots on undo', () => {
    const doc = freshDoc();                        // r1 e1 t1 r3 g1
    const cmd: Command = { type: 'group', artboardId: AB, nodeIds: ['r1', 't1'], groupId: 'G' };
    const grouped = apply(doc, cmd);

    expect(topIds(grouped)).toEqual(['e1', 'G', 'r3', 'g1']);
    expect(apply(grouped, invert(doc, cmd))).toStrictEqual(doc);
  });

  it('ungroups in place, splicing the children where the group sat', () => {
    const doc = freshDoc();
    const flat = apply(doc, { type: 'ungroup', artboardId: AB, groupId: 'g1' });
    expect(topIds(flat)).toEqual(['r1', 'e1', 't1', 'r3', 'r2']);
  });

  it('restores a group verbatim on undo, keeping its own name and opacity', () => {
    const doc = loadDocument({ id: 'd', artboards: [{ id: AB, width: 500, height: 500, nodes: [
      buildNode({ id: 'G', kind: 'group', x: 0, y: 0, width: 100, height: 100, name: 'Logo lockup', opacity: 0.6,
        children: [buildNode({ id: 'c1', kind: 'rect', x: 0, y: 0, width: 10, height: 10 })] }),
    ]}]}).doc;
    const cmd: Command = { type: 'ungroup', artboardId: AB, groupId: 'G' };

    const restored = apply(apply(doc, cmd), invert(doc, cmd));
    expect(restored).toStrictEqual(doc);
    expect((findNode(restored, 'G') as any).name).toBe('Logo lockup');
    expect((findNode(restored, 'G') as any).opacity).toBe(0.6);
  });

  it('rejects a grouping that names a missing node, a duplicate, or nothing at all', () => {
    const doc = freshDoc();
    expect(() => apply(doc, { type: 'group', artboardId: AB, nodeIds: ['ghost'], groupId: 'G' })).toThrow(StaleCommandError);
    expect(() => apply(doc, { type: 'group', artboardId: AB, nodeIds: ['r1', 'r1'], groupId: 'G' })).toThrow(StaleCommandError);
    expect(() => apply(doc, { type: 'group', artboardId: AB, nodeIds: [], groupId: 'G' })).toThrow(StaleCommandError);
  });

  it('rejects ungrouping something that is not a group', () => {
    const doc = freshDoc();
    expect(() => apply(doc, { type: 'ungroup', artboardId: AB, groupId: 'r1' })).toThrow(StaleCommandError);
    expect(() => apply(doc, { type: 'ungroup', artboardId: AB, groupId: 'ghost' })).toThrow(StaleCommandError);
    expect(() => invert(doc, { type: 'ungroup', artboardId: AB, groupId: 'r1' })).toThrow(StaleCommandError);
  });

  it('rejects an undo capture whose slots do not line up with the children', () => {
    // a two-child group, so a one-slot capture is genuinely the wrong length
    const doc = loadDocument({ id: 'd', artboards: [{ id: AB, width: 500, height: 500, nodes: [
      buildNode({ id: 'keep', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }),
      buildNode({ id: 'G', kind: 'group', x: 0, y: 0, width: 100, height: 100, children: [
        buildNode({ id: 'c1', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }),
        buildNode({ id: 'c2', kind: 'rect', x: 20, y: 20, width: 10, height: 10 }),
      ]}),
    ]}]}).doc;

    const bad: number[][] = [
      [0],          // wrong length
      [0, 1, 2],    // wrong length
      [0, 0],       // duplicate slot
      [0, 99],      // out of range
      [1.5, 2],     // not an integer
      [-1, 0],      // negative
    ];
    for (const indices of bad) {
      expect(() => apply(doc, { type: 'ungroup', artboardId: AB, groupId: 'G', indices }),
        JSON.stringify(indices)).toThrow(StaleCommandError);
    }

    // and the well-formed capture is accepted
    expect(topIds(apply(doc, { type: 'ungroup', artboardId: AB, groupId: 'G', indices: [0, 2] })))
      .toEqual(['c1', 'keep', 'c2']);
  });

  it('survives group → ungroup → undo → undo through the history stack', () => {
    let doc = freshDoc();
    const start = doc;
    let history: History = emptyHistory();

    ({ doc, history } = commit(doc, history, { type: 'group', artboardId: AB, nodeIds: ['r1', 'e1'], groupId: 'G' }));
    ({ doc, history } = commit(doc, history, { type: 'ungroup', artboardId: AB, groupId: 'G' }));
    const end = doc;

    ({ doc, history } = undo(doc, history));
    ({ doc, history } = undo(doc, history));
    expect(doc).toStrictEqual(start);

    ({ doc, history } = redo(doc, history));
    ({ doc, history } = redo(doc, history));
    expect(doc).toStrictEqual(end);
  });
});

describe('commands: silent no-ops (regression guards)', () => {
  // REGRESSION GUARD: every one of these used to succeed while changing
  // nothing. That is survivable in the editor -- a person notices the shape
  // did not move -- but the MCP server drives this same command layer with no
  // one watching, and a no-op that returns a Document is indistinguishable
  // from a write. Each of these must now be loud.

  it.each(['addNode', 'removeNode', 'reorder', 'setArtboard', 'group', 'ungroup'] as const)(
    'apply(%s) throws rather than no-op when the artboard is gone', type => {
      const doc = freshDoc();
      const cmd = {
        addNode:     { type, artboardId: 'ghost-ab', node: buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1 }), index: 0 },
        removeNode:  { type, artboardId: 'ghost-ab', nodeId: 'r1', index: 0, node: findNode(doc, 'r1') },
        reorder:     { type, artboardId: 'ghost-ab', nodeId: 'r1', to: 0 },
        setArtboard: { type, artboardId: 'ghost-ab', patch: { width: 10 } },
        group:       { type, artboardId: 'ghost-ab', nodeIds: ['r1'], groupId: 'G' },
        ungroup:     { type, artboardId: 'ghost-ab', groupId: 'g1', indices: [0] },
      }[type] as unknown as Command;

      expect(() => apply(doc, cmd)).toThrow(StaleCommandError);
    });

  it.each(['addNode', 'removeNode', 'setArtboard'] as const)(
    'invert(%s) throws rather than returning a command that will no-op', type => {
      const doc = freshDoc();
      const cmd = {
        addNode:     { type, artboardId: 'ghost-ab', node: buildNode({ id: 'n', kind: 'rect', x: 0, y: 0, width: 1, height: 1 }), index: 0 },
        removeNode:  { type, artboardId: 'ghost-ab', nodeId: 'r1', index: 0, node: findNode(doc, 'r1') },
        setArtboard: { type, artboardId: 'ghost-ab', patch: { width: 10 } },
      }[type] as unknown as Command;

      expect(() => invert(doc, cmd)).toThrow(StaleCommandError);
    });

  it('rejects an addNode that would duplicate an existing node id', () => {
    const doc = freshDoc();
    const clash = buildNode({ id: 'r1', kind: 'ellipse', x: 0, y: 0, width: 1, height: 1 });

    // Two nodes sharing an id is silent corruption, not a visible error:
    // findNode picks one of them, updateNode patches both, removeNode
    // deletes both. Nothing downstream can tell it happened.
    expect(() => apply(doc, { type: 'addNode', artboardId: AB, node: clash, index: 0 }))
      .toThrow(InvalidCommandError);
  });

  // REGRESSION GUARD: `invert()`'s `case 'reorder'` used findIndex without
  // checking the -1 result, so a missing node yielded a reorder to index -1
  // instead of the StaleCommandError every sibling case throws -- deferring
  // the failure to apply(), one step further from the cause.
  it('invert(reorder) throws StaleCommandError for a node that is gone', () => {
    const doc = freshDoc();
    expect(() => invert(doc, { type: 'reorder', artboardId: AB, nodeId: 'ghost', to: 0 }))
      .toThrow(StaleCommandError);
  });

  // REGRESSION GUARD: `invert()`'s `case 'updateNode'` copied `node[k]` for
  // every patch key, so a key the node never had came back as an explicit
  // `undefined` and undo re-added the key rather than removing it. The fix is
  // upstream of invert: a patch key the node does not have is not a valid
  // edit, so apply rejects it and there is nothing to invert.
  // REGRESSION GUARD: `updateNode` checked that the patch named a real FIELD
  // and never looked at the VALUE, so out-of-range numbers were written into
  // the document and only surfaced later, from a command that had nothing to
  // do with the one that wrote them. The first symptom was a `group` command
  // failing with `Invalid rect node: Number must be greater than or equal to
  // 0` -- pointing at the grouping, with nothing left pointing at the patch.
  it('rejects an updateNode patch whose VALUE the schema would refuse', () => {
    const doc = freshDoc();
    for (const patch of [{ radius: -50 }, { opacity: 9 }, { width: -1 }]) {
      expect(() => apply(doc, { type: 'updateNode', nodeId: 'r1', patch }), JSON.stringify(patch))
        .toThrow(InvalidCommandError);
    }
    // ...and says which command did it, not just that something is invalid.
    expect(() => apply(doc, { type: 'updateNode', nodeId: 'r1', patch: { radius: -50 } }))
      .toThrow(/Patching "r1" with \{"radius":-50\}/);
    // The document is untouched: a refused command must not half-apply.
    expect(findNode(doc, 'r1')).toStrictEqual(findNode(freshDoc(), 'r1'));
  });

  it('stores a patched value the schema accepts, unchanged', () => {
    const out = apply(freshDoc(), { type: 'updateNode', nodeId: 'r1', patch: { radius: 0, opacity: 0.25 } });
    expect(findNode(out, 'r1')).toMatchObject({ radius: 0, opacity: 0.25 });
  });

  it('rejects an updateNode patch naming a field the node does not have', () => {
    const doc = freshDoc();
    const cmd: Command = { type: 'updateNode', nodeId: 'r1', patch: { phantom: 7 } as any };

    expect(() => apply(doc, cmd)).toThrow(InvalidCommandError);
    expect('phantom' in (findNode(doc, 'r1') as any)).toBe(false);
  });

  it('rejects a setArtboard patch naming a field the artboard does not have', () => {
    const doc = freshDoc();
    expect(() => apply(doc, { type: 'setArtboard', artboardId: AB, patch: { hieght: 10 } as any }))
      .toThrow(InvalidCommandError);
  });

  it('lets undo drop a command whose artboard was deleted, but not a malformed one', () => {
    // The two failures need opposite handling, which is why they are separate
    // classes: an artboard that vanished is ordinary history rot and undo
    // should quietly discard the entry, whereas a patch naming a field that
    // does not exist is a caller bug and must not be swallowed by an undo.
    const doc = freshDoc();
    const stale: Command = { type: 'setArtboard', artboardId: 'ghost-ab', patch: { width: 10 } };
    expect(() => apply(doc, stale)).toThrow(StaleArtboardError);
    expect(new StaleArtboardError('x')).toBeInstanceOf(StaleCommandError);
    expect(new InvalidCommandError('x')).not.toBeInstanceOf(StaleCommandError);

    const history = { past: [stale], future: [] } as History;
    expect(undo(doc, history)).toEqual({ doc, history: { past: [], future: [] } });
  });

  it('accepts a patch setting an optional field the node does not yet have', () => {
    // `TextNode.fill` is optional and absent by default, so "give this text a
    // gradient" patches a key that is genuinely not on the node. Validating
    // the patch against the instance instead of the schema would reject it.
    const doc = freshDoc();
    const fill = { kind: 'gradient', type: 'linear', angle: 0,
      stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
    const cmd: Command = { type: 'updateNode', nodeId: 't1', patch: { fill } };

    expect(findNode(doc, 't1')).not.toHaveProperty('fill');
    expect(findNode(apply(doc, cmd), 't1')).toMatchObject({ fill });
  });

  it('removes the key again when that patch is undone, rather than setting it undefined', () => {
    const doc = freshDoc();
    const fill = { kind: 'solid', color: '#ff0000' };
    const cmd: Command = { type: 'updateNode', nodeId: 't1', patch: { fill } };
    const restored = apply(apply(doc, cmd), invert(doc, cmd));

    // `{...node, fill: undefined}` is a different document from one with no
    // `fill`: it survives a save/load as an extra key and breaks equality.
    expect('fill' in (findNode(restored, 't1') as any)).toBe(false);
    expect(restored.artboards).toStrictEqual(doc.artboards);
    expect(loadDocument(JSON.parse(JSON.stringify(restored))).doc.artboards).toStrictEqual(doc.artboards);
  });

  it('round-trips the same optional field through the real undo stack', () => {
    const doc = freshDoc();
    const cmd: Command = { type: 'updateNode', nodeId: 't1', patch: { fill: { kind: 'none' } } };
    const committed = commit(doc, emptyHistory(), cmd);
    const undone = undo(committed.doc, committed.history);

    expect(undone.doc.artboards).toStrictEqual(doc.artboards);
    expect(redo(undone.doc, undone.history).doc.artboards).toStrictEqual(committed.doc.artboards);
  });

  it('still applies a well-formed patch on both', () => {
    const doc = freshDoc();
    expect(findNode(apply(doc, { type: 'updateNode', nodeId: 'r1', patch: { x: 42 } }), 'r1'))
      .toMatchObject({ x: 42 });
    expect(apply(doc, { type: 'setArtboard', artboardId: AB, patch: { width: 42 } }).artboards[0])
      .toMatchObject({ width: 42 });
  });
});

describe('commands: known bugs (continued)', () => {
  // REGRESSION GUARD: `makeGroup` used to hand-write the group node field by
  // field and cast it to `Node`, which let it fall behind NodeBase — it never
  // set `alt`, `flipX` or `flipY`, so a grouped document did not survive a save
  // + reload unchanged. It now goes through `buildNode`. These two stay because
  // the failure was silent: the cast suppresses the compiler error that would
  // otherwise catch the next field the schema gains.
  it('produces a schema-complete group node', () => {
    const doc = loadDocument({ id: 'd', artboards: [{ id: AB, width: 500, height: 500, nodes: [
      buildNode({ id: 'a', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }),
      buildNode({ id: 'b', kind: 'rect', x: 50, y: 50, width: 10, height: 10 }),
    ]}]}).doc;
    const grouped = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['a', 'b'], groupId: 'G' });

    expect(findNode(grouped, 'G')).toMatchObject({ alt: '', flipX: false, flipY: false });
  });

  it('lets a grouped document survive a save/load cycle unchanged', () => {
    const doc = loadDocument({ id: 'd', artboards: [{ id: AB, width: 500, height: 500, nodes: [
      buildNode({ id: 'a', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }),
      buildNode({ id: 'b', kind: 'rect', x: 50, y: 50, width: 10, height: 10 }),
    ]}]}).doc;
    const grouped = apply(doc, { type: 'group', artboardId: AB, nodeIds: ['a', 'b'], groupId: 'G' });
    const reloaded = loadDocument(JSON.parse(JSON.stringify(grouped))).doc;

    expect(reloaded.artboards).toStrictEqual(grouped.artboards);
  });
});
