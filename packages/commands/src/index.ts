import type { Document, Node } from '@artboard/schema';

/** Immutable command layer. apply(doc, cmd) -> newDoc. invert(cmd) -> undo cmd. */

export class StaleCommandError extends Error {
  constructor(public nodeId: string) { super(`Command targets a node that no longer exists (${nodeId}).`); this.name = 'StaleCommandError'; }
}

export type Command =
  | { type: 'addNode'; artboardId: string; node: Node; index?: number }
  | { type: 'removeNode'; artboardId: string; nodeId: string; node?: Node; index?: number }
  | { type: 'updateNode'; nodeId: string; patch: Record<string, unknown>; before?: Record<string, unknown> }
  | { type: 'reorder'; artboardId: string; nodeId: string; to: number; from?: number }
  | { type: 'setArtboard'; artboardId: string; patch: Record<string, unknown>; before?: Record<string, unknown> }
  | { type: 'addAsset'; asset: { id: string; mime: string; width: number; height: number; data: string } }
  | { type: 'batch'; label: string; commands: Command[] };

export function apply(doc: Document, cmd: Command): Document {
  switch (cmd.type) {
    case 'batch':
      return cmd.commands.reduce((d, c) => apply(d, c), doc);

    case 'addNode':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = [...ab.nodes];
        nodes.splice(cmd.index ?? nodes.length, 0, cmd.node);
        return { ...ab, nodes };
      });

    case 'removeNode':
      return mapArtboard(doc, cmd.artboardId, ab => ({ ...ab, nodes: ab.nodes.filter((n: Node) => n.id !== cmd.nodeId) }));

    case 'updateNode': {
      let hit = false;
      const next = mapNodes(doc, n => {
        if (n.id !== cmd.nodeId) return n;
        hit = true;
        return { ...n, ...cmd.patch } as Node;
      });
      if (!hit) throw new StaleCommandError(cmd.nodeId);
      return next;
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

    case 'setArtboard':
      return mapArtboard(doc, cmd.artboardId, ab => ({ ...ab, ...cmd.patch }));

    case 'addAsset':
      return { ...doc, assets: { ...doc.assets, [cmd.asset.id]: cmd.asset } };
  }
}

/** Produce the command that undoes `cmd`, captured against the doc BEFORE it was applied. */
export function invert(doc: Document, cmd: Command): Command {
  switch (cmd.type) {
    case 'batch':
      return { type: 'batch', label: `Undo ${cmd.label}`, commands: [...cmd.commands].reverse().map(c => invert(doc, c)) };

    case 'addNode':
      return { type: 'removeNode', artboardId: cmd.artboardId, nodeId: cmd.node.id };

    case 'removeNode': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      const index = ab ? ab.nodes.findIndex((n: Node) => n.id === cmd.nodeId) : 0;
      const node = ab?.nodes[index];
      if (!node) throw new StaleCommandError(cmd.nodeId);
      return { type: 'addNode', artboardId: cmd.artboardId, node: node as Node, index };
    }

    case 'updateNode': {
      const node = findAny(doc, cmd.nodeId);
      if (!node) throw new StaleCommandError(cmd.nodeId);
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) before[k] = (node as any)[k];
      return { type: 'updateNode', nodeId: cmd.nodeId, patch: before };
    }

    case 'reorder': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      const from = ab ? ab.nodes.findIndex((n: Node) => n.id === cmd.nodeId) : 0;
      return { type: 'reorder', artboardId: cmd.artboardId, nodeId: cmd.nodeId, to: from };
    }

    case 'setArtboard': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) before[k] = (ab as any)?.[k];
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
function mapArtboard(doc: Document, id: string, fn: (ab: any) => any): Document {
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

export const uid = (prefix = 'n'): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
