import React, { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { LeftRail } from './components/LeftRail';
import { RightDock } from './components/RightDock';
import { PageBar } from './components/PageBar';
import { Canvas } from './components/Canvas';

export function App() {
  const [tool, setTool] = useState('select');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || e.metaKey || e.ctrlKey) return;
      const map: Record<string, string> = { v: 'select', t: 'text', r: 'rect', o: 'ellipse', l: 'line', h: 'hand' };
      const next = map[e.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar tool={tool} setTool={setTool} />
      <div className="workspace">
        <LeftRail />
        <Canvas tool={tool} onToolDone={() => setTool('select')} />
        <RightDock />
      </div>
      <PageBar />
    </div>
  );
}
