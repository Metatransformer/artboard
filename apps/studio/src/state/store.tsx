import React, { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { Document, loadDocument, type Node, type Artboard } from '@artboard/schema';
import { apply, commit, invert, redo, undo, uid, emptyHistory, type Command, type History } from '@artboard/commands';

export interface EditorState {
  doc: Document;
  history: History;
  selection: string[];
  activeArtboard: number;
  zoom: number;
  pan: { x: number; y: number };
  editingTextId: string | null;
  readOnly: boolean;
  toast: { level: 'info' | 'warn' | 'error'; message: string } | null;
}

type Action =
  | { type: 'run'; cmd: Command }
  | { type: 'runTransient'; cmd: Command }      // during a drag; no history entry
  | { type: 'undo' } | { type: 'redo' }
  | { type: 'select'; ids: string[] }
  | { type: 'setDoc'; doc: Document; readOnly?: boolean }
  | { type: 'setArtboardIndex'; index: number }
  | { type: 'setZoom'; zoom: number }
  | { type: 'setPan'; pan: { x: number; y: number } }
  | { type: 'editText'; id: string | null }
  | { type: 'toast'; toast: EditorState['toast'] };

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'run': {
      if (state.readOnly) return { ...state, toast: { level: 'warn', message: 'This document is read-only.' } };
      try {
        const { doc, history } = commit(state.doc, state.history, action.cmd);
        return { ...state, doc, history };
      } catch (e) {
        return { ...state, toast: { level: 'error', message: e instanceof Error ? `${e.name}: ${e.message}` : 'Command failed' } };
      }
    }
    case 'runTransient':
      if (state.readOnly) return state;
      try { return { ...state, doc: apply(state.doc, action.cmd) }; } catch { return state; }
    case 'undo': { const r = undo(state.doc, state.history); return { ...state, ...r, editingTextId: null }; }
    case 'redo': { const r = redo(state.doc, state.history); return { ...state, ...r, editingTextId: null }; }
    case 'select': return { ...state, selection: action.ids, editingTextId: null };
    case 'setDoc':
      return { ...state, doc: action.doc, history: emptyHistory(), selection: [], activeArtboard: 0,
               readOnly: action.readOnly ?? false, editingTextId: null };
    case 'setArtboardIndex': return { ...state, activeArtboard: action.index, selection: [], editingTextId: null };
    case 'setZoom': return { ...state, zoom: Math.min(8, Math.max(0.05, action.zoom)) };
    case 'setPan': return { ...state, pan: action.pan };
    case 'editText': return { ...state, editingTextId: action.id };
    case 'toast': return { ...state, toast: action.toast };
  }
}

const Ctx = createContext<{
  state: EditorState;
  dispatch: React.Dispatch<Action>;
  run: (cmd: Command) => void;
  runTransient: (cmd: Command) => void;
  artboard: Artboard;
  selected: Node[];
} | null>(null);

export function EditorProvider({ initial, children }: { initial: Document; children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    doc: initial, history: emptyHistory(), selection: [], activeArtboard: 0,
    zoom: 1, pan: { x: 0, y: 0 }, editingTextId: null, readOnly: false, toast: null,
  });

  const run = useCallback((cmd: Command) => dispatch({ type: 'run', cmd }), []);
  const runTransient = useCallback((cmd: Command) => dispatch({ type: 'runTransient', cmd }), []);

  const artboard = state.doc.artboards[state.activeArtboard] ?? state.doc.artboards[0]!;
  const selected = useMemo(
    () => (artboard.nodes as Node[]).filter(n => state.selection.includes(n.id)),
    [artboard.nodes, state.selection],
  );

  return <Ctx.Provider value={{ state, dispatch, run, runTransient, artboard, selected }}>{children}</Ctx.Provider>;
}

export function useEditor() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEditor must be used inside <EditorProvider>');
  return v;
}

/* ── document factories ─────────────────────────────────────────────────── */
export function blankDocument(width = 1080, height = 1080, name = 'Untitled'): Document {
  return loadDocument({
    version: 1, id: uid('doc'), name,
    artboards: [{ id: uid('ab'), name: 'Artboard 1', width, height,
      background: { kind: 'solid', color: '#ffffff' }, nodes: [] }],
    assets: {}, diagnostics: [],
  }).doc;
}

export function documentFromTemplate(t: { id: string; name: string; build: () => any }): Document {
  const built = t.build();
  const stamp = uid('t');
  const reid = (nodes: any[]): any[] => nodes.map(n => ({
    ...n, id: `${stamp}-${n.id}`,
    ...(n.kind === 'group' ? { children: reid(n.children ?? []) } : {}),
  }));
  return loadDocument({
    version: 1, id: uid('doc'), name: t.name,
    artboards: [{ id: uid('ab'), name: t.name, width: built.width, height: built.height,
      background: built.background, nodes: reid(built.nodes) }],
    assets: {}, diagnostics: [],
  }).doc;
}

export { invert };
