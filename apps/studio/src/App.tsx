import React, { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { LeftRail } from './components/LeftRail';
import { RightDock } from './components/RightDock';
import { PageBar } from './components/PageBar';
import { Canvas } from './components/Canvas';
import { Present } from './components/Present';
import { Shortcuts } from './components/Shortcuts';

export function App() {
  const [tool, setTool] = useState('select');
  const [present, setPresent] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);

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
    <div className="app">
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
