import { buildNode, nodeFields, artboardFields, type Document, type Node } from '@artboard/schema';
import { aabb } from '@artboard/engine';

/** Immutable command layer. apply(doc, cmd) -> newDoc. invert(cmd) -> undo cmd. */

export class StaleCommandError extends Error {
  constructor(public nodeId: string) { super(`Command targets a node that no longer exists (${nodeId}).`); this.name = 'StaleCommandError'; }
}

/**
 * The artboard itself is gone. Extends StaleCommandError on purpose: undo and
 * redo drop a stale entry rather than exploding, and an artboard that vanished
 * is the same kind of staleness as a node that did.
 */
export class StaleArtboardError extends StaleCommandError {
  constructor(public artboardId: string) {
    super(artboardId);
    this.message = `Command targets an artboard that no longer exists (${artboardId}).`;
    this.name = 'StaleArtboardError';
  }
}

/**
 * The command is malformed against this document — a patch naming a field the
 * target does not have, or an id that is already taken. Deliberately NOT a
 * StaleCommandError: nothing here is stale, the command is wrong, and undo must
 * not quietly swallow it. `invert` never produces one of these.
 */
export class InvalidCommandError extends Error {
  constructor(detail: string) { super(detail); this.name = 'InvalidCommandError'; }
}

export type Command =
  | { type: 'addNode'; artboardId: string; node: Node; index?: number }
  | { type: 'removeNode'; artboardId: string; nodeId: string; node?: Node; index?: number }
  | { type: 'updateNode'; nodeId: string; patch: Record<string, unknown>; before?: Record<string, unknown> }
  | { type: 'reorder'; artboardId: string; nodeId: string; to: number; from?: number }
  | { type: 'setArtboard'; artboardId: string; patch: Record<string, unknown>; before?: Record<string, unknown> }
  | { type: 'addAsset'; asset: { id: string; mime: string; width: number; height: number; data: string } }
  | { type: 'batch'; label: string; commands: Command[] }
  /**
   * Wrap `nodeIds` in a new group node. `node` and `index` are the undo
   * capture: when present the group node is restored verbatim at that index
   * (so a group's own name/opacity/effects survive an ungroup + undo) instead
   * of being synthesised from the members' bounds.
   */
  | { type: 'group'; artboardId: string; nodeIds: string[]; groupId: string; node?: Node; index?: number }
  /**
   * Replace a group with its children. `indices` is the undo capture: the slot
   * each child occupied before it was grouped, which is what lets `group`'s
   * inverse restore a non-contiguous selection to its exact original order.
   */
  | { type: 'ungroup'; artboardId: string; groupId: string; indices?: number[] };

export function apply(doc: Document, cmd: Command): Document {
  switch (cmd.type) {
    case 'batch':
      return cmd.commands.reduce((d, c) => apply(d, c), doc);

    case 'addNode':
      // A duplicate id is silent corruption rather than a no-op: findNode picks
      // whichever it sees last, updateNode patches both, removeNode deletes
      // both. Cheap to refuse, impossible to unpick later.
      if (findAny(doc, cmd.node.id)) {
        throw new InvalidCommandError(`A node with id "${cmd.node.id}" is already in the document.`);
      }
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = [...ab.nodes];
        nodes.splice(cmd.index ?? nodes.length, 0, cmd.node);
        return { ...ab, nodes };
      });

    case 'removeNode':
      // Throws on a node that is not there, like `updateNode`, `reorder` and
      // `group` do — and like this command's own `invert` already did. A filter
      // that quietly matches nothing reports a successful delete to whatever
      // asked for it, which is survivable in the editor (the user can see the
      // node is still on screen) and not survivable for an unattended caller.
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = (ab.nodes as Node[]).filter((n: Node) => n.id !== cmd.nodeId);
        if (nodes.length === ab.nodes.length) throw new StaleCommandError(cmd.nodeId);
        return { ...ab, nodes };
      });

    case 'updateNode': {
      // A key the node does not have is not an edit: the schema strips unknown
      // keys on the next parse, so the caller is told the change landed and
      // nothing about the document differs. A misspelled field name has to be
      // loud, or an unattended writer will keep sending it.
      const target = findAny(doc, cmd.nodeId);
      if (!target) throw new StaleCommandError(cmd.nodeId);
      // Ask the schema which fields exist, not the node in hand: an optional
      // field is absent from the instance and still perfectly settable --
      // `TextNode.fill` is exactly that, and `k in node` would reject the
      // command that puts a gradient on a piece of text.
      const fields = nodeFields((target as any).kind);
      const unknown = fields ? Object.keys(cmd.patch).filter(k => !fields.has(k)) : [];
      if (unknown.length) {
        throw new InvalidCommandError(
          `Node "${cmd.nodeId}" (${(target as any).kind}) has no field ${unknown.map(k => `"${k}"`).join(', ')}.`);
      }
      return mapNodes(doc, n => (n.id === cmd.nodeId ? patchNode(n, cmd.patch) : n));
    }

    case 'reorder':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = [...ab.nodes];
        const from = nodes.findIndex((n: Node) => n.id === cmd.nodeId);
        if (from < 0) throw new StaleCommandError(cmd.nodeId);
        const [moved] = nodes.splice(from, 1);
        nodes.splice(Math.max(0, Math.min(nodes.length, cmd.to)), 0, moved!);
        return { ...ab, nodes };
      });

    case 'group':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = ab.nodes as Node[];
        const ids = cmd.nodeIds;
        if (ids.length === 0 || new Set(ids).size !== ids.length) throw new StaleCommandError(cmd.groupId);
        const picked = ids.map(id => {
          const index = nodes.findIndex((n: Node) => n.id === id);
          if (index < 0) throw new StaleCommandError(id);
          return { index, node: nodes[index]! };
        }).sort((a, b) => a.index - b.index);

        const topmost = picked[picked.length - 1]!.index;
        const taken = new Set(ids);
        const rest = nodes.filter((n: Node) => !taken.has(n.id));
        // The group lands where the topmost member sat, once the members below
        // it have been lifted out.
        const at = clampIndex(cmd.index ?? topmost - (picked.length - 1), rest.length);
        const group = cmd.node ?? makeGroup(cmd.groupId, picked.map(p => p.node));
        const next = [...rest];
        next.splice(at, 0, group);
        return { ...ab, nodes: next };
      });

    case 'ungroup':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = ab.nodes as Node[];
        const gi = nodes.findIndex((n: Node) => n.id === cmd.groupId);
        const group = gi < 0 ? undefined : nodes[gi];
        if (!group || (group as any).kind !== 'group') throw new StaleCommandError(cmd.groupId);
        const children = (((group as any).children ?? []) as Node[]);
        const rest = nodes.filter((_: Node, i: number) => i !== gi);

        if (!cmd.indices) {
          const next = [...rest];
          next.splice(gi, 0, ...children);
          return { ...ab, nodes: next };
        }

        // Undo of `group`: every child goes back to the exact slot it came from.
        const total = rest.length + children.length;
        if (cmd.indices.length !== children.length) throw new StaleCommandError(cmd.groupId);
        const slots: Array<Node | undefined> = new Array(total).fill(undefined);
        cmd.indices.forEach((slot, i) => {
          if (!Number.isInteger(slot) || slot < 0 || slot >= total || slots[slot] !== undefined) {
            throw new StaleCommandError(cmd.groupId);
          }
          slots[slot] = children[i]!;
        });
        let cursor = 0;
        const next = slots.map(s => s ?? rest[cursor++]!);
        return { ...ab, nodes: next };
      });

    case 'setArtboard':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const fields = artboardFields();
        const unknown = Object.keys(cmd.patch).filter(k => !fields.has(k));
        if (unknown.length) {
          throw new InvalidCommandError(
            `Artboard "${cmd.artboardId}" has no field ${unknown.map(k => `"${k}"`).join(', ')}.`);
        }
        return { ...ab, ...cmd.patch };
      });

    case 'addAsset':
      return { ...doc, assets: { ...doc.assets, [cmd.asset.id]: cmd.asset } };
  }
}

/** Produce the command that undoes `cmd`, captured against the doc BEFORE it was applied. */
export function invert(doc: Document, cmd: Command): Command {
  switch (cmd.type) {
    case 'batch': {
      /*
       * Each child is inverted against the document as it stood immediately
       * BEFORE that child ran, not against the batch's starting document.
       *
       * That distinction is the whole correctness of a batch. The inverse of
       * `removeNode` is `addNode` at an INDEX, and the inverse of `reorder` is
       * another index — and indices shift as earlier children of the same batch
       * are applied. Capturing every inverse against the starting document made
       * deleting two non-adjacent nodes in one gesture come back in the wrong
       * z-order on undo. So: walk forward capturing inverses against the live
       * state, then reverse the list, because undo runs the last thing first.
       */
      const inverses: Command[] = [];
      let d = doc;
      for (const c of cmd.commands) { inverses.push(invert(d, c)); d = apply(d, c); }
      inverses.reverse();
      return { type: 'batch', label: `Undo ${cmd.label}`, commands: inverses };
    }

    case 'addNode':
      if (!doc.artboards.some(a => a.id === cmd.artboardId)) throw new StaleArtboardError(cmd.artboardId);
      return { type: 'removeNode', artboardId: cmd.artboardId, nodeId: cmd.node.id };

    case 'removeNode': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      const index = ab.nodes.findIndex((n: Node) => n.id === cmd.nodeId);
      const node = ab.nodes[index];
      if (!node) throw new StaleCommandError(cmd.nodeId);
      return { type: 'addNode', artboardId: cmd.artboardId, node: node as Node, index };
    }

    case 'updateNode': {
      const node = findAny(doc, cmd.nodeId);
      if (!node) throw new StaleCommandError(cmd.nodeId);
      // A key the node does not currently have is captured as `undefined`,
      // which `patchNode` reads as "remove it again". Recording the absence
      // any other way makes undo *add* the key back as an explicit undefined,
      // so a document stops matching itself across a set + undo.
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) before[k] = (node as any)[k];
      return { type: 'updateNode', nodeId: cmd.nodeId, patch: before };
    }

    case 'reorder': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      // An unchecked findIndex made this return a reorder to index -1, so the
      // failure surfaced later inside apply, one step from its cause — while
      // every sibling case threw here.
      const from = (ab.nodes as Node[]).findIndex((n: Node) => n.id === cmd.nodeId);
      if (from < 0) throw new StaleCommandError(cmd.nodeId);
      return { type: 'reorder', artboardId: cmd.artboardId, nodeId: cmd.nodeId, to: from };
    }

    case 'group': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleCommandError(cmd.groupId);
      const indices = cmd.nodeIds.map(id => {
        const i = (ab.nodes as Node[]).findIndex((n: Node) => n.id === id);
        if (i < 0) throw new StaleCommandError(id);
        return i;
      }).sort((a, b) => a - b);
      // `makeGroup` keeps the members in document order, so `indices` (ascending)
      // lines up index-for-index with the group's children.
      return { type: 'ungroup', artboardId: cmd.artboardId, groupId: cmd.groupId, indices };
    }

    case 'ungroup': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      const index = ab ? (ab.nodes as Node[]).findIndex((n: Node) => n.id === cmd.groupId) : -1;
      const group = ab && index >= 0 ? (ab.nodes as Node[])[index] : undefined;
      if (!group || (group as any).kind !== 'group') throw new StaleCommandError(cmd.groupId);
      const children = (((group as any).children ?? []) as Node[]);
      return {
        type: 'group', artboardId: cmd.artboardId, groupId: cmd.groupId,
        nodeIds: children.map(c => c.id), node: group, index,
      };
    }

    case 'setArtboard': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) before[k] = (ab as any)[k];
      return { type: 'setArtboard', artboardId: cmd.artboardId, patch: before };
    }

    case 'addAsset':
      return { type: 'batch', label: 'noop', commands: [] };
  }
}

/* ── history ────────────────────────────────────────────────────────────── */
export interface History { past: Command[]; future: Command[]; }
export const emptyHistory = (): History => ({ past: [], future: [] });
export const MAX_HISTORY = 500;

export function commit(doc: Document, history: History, cmd: Command): { doc: Document; history: History } {
  const undoCmd = invert(doc, cmd);
  const next = apply(doc, cmd);
  const past = [...history.past, undoCmd].slice(-MAX_HISTORY);
  return { doc: next, history: { past, future: [] } };
}

export function undo(doc: Document, history: History): { doc: Document; history: History } {
  const cmd = history.past[history.past.length - 1];
  if (!cmd) return { doc, history };
  try {
    const redoCmd = invert(doc, cmd);
    return { doc: apply(doc, cmd), history: { past: history.past.slice(0, -1), future: [...history.future, redoCmd] } };
  } catch (e) {
    if (e instanceof StaleCommandError) return { doc, history: { past: history.past.slice(0, -1), future: [] } };
    throw e;
  }
}

export function redo(doc: Document, history: History): { doc: Document; history: History } {
  const cmd = history.future[history.future.length - 1];
  if (!cmd) return { doc, history };
  try {
    const undoCmd = invert(doc, cmd);
    return { doc: apply(doc, cmd), history: { past: [...history.past, undoCmd], future: history.future.slice(0, -1) } };
  } catch (e) {
    if (e instanceof StaleCommandError) return { doc, history: { ...history, future: [] } };
    throw e;
  }
}

/* ── helpers ────────────────────────────────────────────────────────────── */
/**
 * Every artboard-scoped command routes through here, so an id that matches
 * nothing used to be a silent success for all six of them: addNode, removeNode,
 * reorder, group, ungroup and setArtboard each returned the document untouched
 * and reported that the edit had happened. Survivable in the editor, where the
 * artboard id comes from the thing you clicked; not survivable for an
 * unattended caller that only sees the return value.
 */
/**
 * Apply a patch to a node. An `undefined` value removes the field rather than
 * setting it: that is the only way undo can restore a node that legitimately
 * did not have an optional field, and `{...n, fill: undefined}` is not the
 * same document as one with no `fill` at all.
 */
function patchNode(n: Node, patch: Record<string, unknown>): Node {
  const next: Record<string, unknown> = { ...(n as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as Node;
}

function mapArtboard(doc: Document, id: string, fn: (ab: any) => any): Document {
  if (!doc.artboards.some(ab => ab.id === id)) throw new StaleArtboardError(id);
  return { ...doc, artboards: doc.artboards.map(ab => (ab.id === id ? fn(ab) : ab)) };
}
function mapNodes(doc: Document, fn: (n: Node) => Node): Document {
  const rec = (nodes: Node[]): Node[] => nodes.map(n => {
    const mapped = fn(n);
    if ((mapped as any).kind === 'group') return { ...(mapped as any), children: rec((mapped as any).children ?? []) };
    return mapped;
  });
  return { ...doc, artboards: doc.artboards.map(ab => ({ ...ab, nodes: rec(ab.nodes as Node[]) })) };
}
function findAny(doc: Document, id: string): Node | null {
  let found: Node | null = null;
  const rec = (nodes: Node[]) => { for (const n of nodes) { if (n.id === id) found = n; if ((n as any).kind === 'group') rec((n as any).children ?? []); } };
  for (const ab of doc.artboards) rec(ab.nodes as Node[]);
  return found;
}

const clampIndex = (i: number, max: number): number => Math.max(0, Math.min(max, i));

/** A fresh group whose box is the union of its members' rotated bounds. */
function makeGroup(id: string, members: Node[]): Node {
  const boxes = members.map(m => aabb({
    x: (m as any).x, y: (m as any).y,
    width: (m as any).width, height: (m as any).height,
    rotation: (m as any).rotation ?? 0,
  }));
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.width));
  const maxY = Math.max(...boxes.map(b => b.y + b.height));
  // Through `buildNode`, never a hand-written literal cast to `Node`: the cast
  // silences the compiler exactly when the schema grows a field this forgot, so
  // the group a user makes stops matching the group a reload parses and the
  // document no longer survives save/load unchanged. Zod fills every default.
  return buildNode({
    id, name: 'Group', kind: 'group',
    x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    // Children stay in artboard space - render-svg's `case 'group'` draws each
    // child with its own absolute x/y and adds no translate of its own.
    children: members,
  });
}

export const uid = (prefix = 'n'): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
