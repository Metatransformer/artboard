import React, { useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { LeftPanel } from './components/LeftPanel';
import { Inspector } from './components/Inspector';
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
        <LeftPanel />
        <Canvas tool={tool} onToolDone={() => setTool('select')} />
        <Inspector />
      </div>
    </div>
  );
}
