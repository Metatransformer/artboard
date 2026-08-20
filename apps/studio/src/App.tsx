import React, { useCallback, useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { LeftRail } from './components/LeftRail';
import { RightDock } from './components/RightDock';
import { PageBar } from './components/PageBar';
import { Canvas } from './components/Canvas';
import { Present } from './components/Present';
import { Shortcuts } from './components/Shortcuts';
import { useEditor, blankDocument } from './state/store';
import { useDesktopBridge, isDesktop, type DesktopCommand } from './lib/desktop';

export function App() {
  const { state, dispatch, artboard } = useEditor();
  const [tool, setTool] = useState('select');
  const [present, setPresent] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);

  /** Scale the artboard to sit inside the canvas host with a margin. */
  const fit = useCallback(() => {
    const host = document.querySelector('.canvas-host')?.getBoundingClientRect();
    if (!host) return;
    const z = Math.min((host.width - 96) / artboard.width, (host.height - 96) / artboard.height);
    dispatch({ type: 'setZoom', zoom: z });
    dispatch({ type: 'setPan', pan: { x: 0, y: 0 } });
  }, [artboard.width, artboard.height, dispatch]);

  const onCommand = useCallback((c: DesktopCommand) => {
    switch (c) {
      case 'doc:new': dispatch({ type: 'setDoc', doc: blankDocument(1080, 1080, 'Untitled') }); return;
      case 'edit:undo': dispatch({ type: 'undo' }); return;
      case 'edit:redo': dispatch({ type: 'redo' }); return;
      case 'edit:selectAll': dispatch({ type: 'select', ids: artboard.nodes.map(n => n.id) }); return;
      case 'edit:deselect': dispatch({ type: 'select', ids: [] }); return;
      case 'view:zoomIn': dispatch({ type: 'setZoom', zoom: state.zoom * 1.25 }); return;
      case 'view:zoomOut': dispatch({ type: 'setZoom', zoom: state.zoom / 1.25 }); return;
      case 'view:zoom100': dispatch({ type: 'setZoom', zoom: 1 }); return;
      case 'view:fit': fit(); return;
      case 'view:present': setPresent(true); return;
      case 'view:shortcuts': setShortcuts(true); return;
      default: break;
    }
    // Clipboard verbs live in the editor's own keyboard layer, which owns the
    // payload format and the undo coalescing. Replaying the accelerator is how
    // the menu reaches them without the menu needing to know any of that.
    const keys: Partial<Record<DesktopCommand, string>> = {
      'edit:cut': 'x', 'edit:copy': 'c', 'edit:paste': 'v',
      'edit:duplicate': 'd', 'edit:delete': 'Delete',
    };
    const key = keys[c];
    if (key) {
      const meta = key !== 'Delete';
      window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: meta, ctrlKey: meta, bubbles: true }));
    }
  }, [artboard.nodes, dispatch, fit, state.zoom]);

  useDesktopBridge({
    setDocument: doc => dispatch({ type: 'setDoc', doc }),
    serialize: () => JSON.stringify(state.doc, null, 2),
    command: onCommand,
    onError: message => dispatch({ type: 'toast', toast: { level: 'error', message } }),
  }, state.history.past.length > 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      // Present and the cheatsheet are reachable from anywhere, so they are
      // checked before the modifier guard that protects the tool hotkeys.
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); setShortcuts(v => !v); return; }
      if (e.key.toLowerCase() === 'p' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); setPresent(true); return; }
      if (e.metaKey || e.ctrlKey) return;
      const map: Record<string, string> = { v: 'select', t: 'text', r: 'rect', o: 'ellipse', l: 'line', h: 'hand' };
      const next = map[e.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app${isDesktop() ? ' app-desktop' : ''}`}>
      <Toolbar tool={tool} setTool={setTool} onPresent={() => setPresent(true)} onShortcuts={() => setShortcuts(true)} />
      <div className="workspace">
        <LeftRail />
        <Canvas tool={tool} onToolDone={() => setTool('select')} />
        <RightDock />
      </div>
      <PageBar />
      <Present open={present} onClose={() => setPresent(false)} />
      <Shortcuts open={shortcuts} onClose={() => setShortcuts(false)} />
    </div>
  );
}
