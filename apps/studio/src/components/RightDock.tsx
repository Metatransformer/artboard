import React, { useCallback, useRef, useState } from 'react';
import { Inspector } from './Inspector';
import { Layers } from './Layers';
import { useEditor } from '../state/store';

/**
 * Photoshop's right dock, not Canva's floating bar: two stacked panels that are
 * both always on screen. Properties is contextual to the selection; Layers is
 * the document's own structure. Neither can hide the other - the split is
 * draggable and each panel can collapse to its header.
 */
export function RightDock() {
  const { state, artboard } = useEditor();
  const [layersH, setLayersH] = useState(260);
  const [layersOpen, setLayersOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  const onGrab = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const host = ref.current;
    if (!host) return;
    const move = (ev: PointerEvent) => {
      const bottom = host.getBoundingClientRect().bottom;
      setLayersH(Math.max(96, Math.min(bottom - ev.clientY, host.clientHeight - 160)));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const count = (artboard.nodes as unknown[]).length;

  return (
    <aside className="dock" ref={ref} aria-label="Properties and layers">
      <div className="dockpanel grow">
        <header className="dockhead">
          <h2>Properties</h2>
        </header>
        <div className="dockbody">
          <Inspector />
        </div>
      </div>

      <div className="splitter" onPointerDown={onGrab} role="separator" aria-label="Resize layers panel" />

      <div className="dockpanel" style={{ height: layersOpen ? layersH : 34, flex: '0 0 auto' }}>
        <header className="dockhead">
          <button className="disclose" aria-expanded={layersOpen} onClick={() => setLayersOpen(v => !v)}>
            <svg viewBox="0 0 16 16" className={layersOpen ? '' : 'shut'}><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <h2>Layers</h2>
          </button>
          <span className="count">{count}</span>
        </header>
        {layersOpen && <div className="dockbody"><Layers /></div>}
      </div>
    </aside>
  );
}
