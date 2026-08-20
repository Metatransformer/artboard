import React, { useEffect, useRef, useState } from 'react';
import { parseDocument } from '@artboard/schema';
import { PRESET_SIZES } from '@artboard/templates';
import { useEditor, blankDocument } from '../state/store';
import { ExportDialog } from './ExportDialog';

const TOOLS = [
  { id: 'select', label: 'Select', key: 'V', icon: 'M4 3l14 7-6 1.5L10 18z' },
  { id: 'text', label: 'Text', key: 'T', icon: 'M5 5h14M12 5v14' },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: 'M4 5h16v14H4z' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: 'M12 4a8 7 0 100 14 8 7 0 100-14' },
  { id: 'line', label: 'Line', key: 'L', icon: 'M4 19L20 5' },
  { id: 'hand', label: 'Pan', key: 'H', icon: 'M8 13V6a1.5 1.5 0 013 0v5m0-1a1.5 1.5 0 013 0v1m0 0a1.5 1.5 0 013 0v4a6 6 0 01-6 6h-1a6 6 0 01-6-6v-3' },
];

export function Toolbar({ tool, setTool, onPresent, onShortcuts }:
  { tool: string; setTool: (t: string) => void; onPresent: () => void; onShortcuts: () => void }) {
  const { state, dispatch, run, artboard } = useEditor();
  const [open, setOpen] = useState<'resize' | null>(null);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!barRef.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [open]);

  const openFile = async (f: File) => {
    try {
      const { doc, readOnly, diagnostics } = parseDocument(await f.text());
      dispatch({ type: 'setDoc', doc, readOnly });
      if (diagnostics.length) dispatch({ type: 'toast', toast: { level: 'warn', message: `${diagnostics[0]!.code}: ${diagnostics[0]!.message}` } });
    } catch (e) {
      dispatch({ type: 'toast', toast: { level: 'error', message: e instanceof Error ? `${e.name}: ${e.message}` : 'Could not open that file' } });
    }
    setTimeout(() => dispatch({ type: 'toast', toast: null }), 5000);
  };

  const fit = () => {
    const host = document.querySelector('.canvas-host');
    if (!host) return;
    const r = host.getBoundingClientRect();
    dispatch({ type: 'setZoom', zoom: Math.min((r.width - 120) / artboard.width, (r.height - 120) / artboard.height) });
    dispatch({ type: 'setPan', pan: { x: 0, y: 0 } });
  };

  return (
    <header className="toolbar" ref={barRef}>
      <div className="brand">
        <svg viewBox="0 0 24 24" className="logo"><rect x="2" y="2" width="20" height="20" rx="5" fill="url(#lg)" /><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6366f1" /><stop offset="1" stopColor="#ec4899" /></linearGradient></defs><path d="M7 16l4-8 3 5 1.5-2L18 16z" fill="#fff" /></svg>
        <div><b>Artboard</b><small>MIT &middot; local-first</small></div>
      </div>

      <div className="tools">
        {TOOLS.map(t => (
          <button key={t.id} className={`tool ${tool === t.id ? 'on' : ''}`} title={`${t.label} (${t.key})`} aria-label={t.label} onClick={() => setTool(t.id)}>
            <svg viewBox="0 0 24 24"><path d={t.icon} fill={t.id === 'select' || t.id === 'rect' || t.id === 'ellipse' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ))}
      </div>

      <div className="spacer" />
      <input
        className="docname" value={state.doc.name ?? ''} aria-label="Design name"
        onChange={e => dispatch({ type: 'renameDoc', name: e.target.value })}
      />
      <div className="spacer" />

      <div className="pop">
        <button className="btn" aria-expanded={open === 'resize'} onClick={() => setOpen(open === 'resize' ? null : 'resize')}>Resize</button>
        {open === 'resize' && (
          <div className="pop-menu">
            <h4>Resize this page</h4>
            <div className="customsize">
              <input className="field" type="number" min={1} value={artboard.width} aria-label="Width"
                     onChange={e => run({ type: 'setArtboard', artboardId: artboard.id, patch: { width: Math.max(1, Number(e.target.value) || 1) } })} />
              <span className="meta">&times;</span>
              <input className="field" type="number" min={1} value={artboard.height} aria-label="Height"
                     onChange={e => run({ type: 'setArtboard', artboardId: artboard.id, patch: { height: Math.max(1, Number(e.target.value) || 1) } })} />
            </div>
            <h4>Presets</h4>
            <div className="sizelist">
              {(PRESET_SIZES as any[]).map(p => (
                <button key={p.name} className="sizerow"
                        onClick={() => { run({ type: 'setArtboard', artboardId: artboard.id, patch: { width: p.width, height: p.height } }); setOpen(null); }}>
                  <span>{p.name}</span><small>{p.width} &times; {p.height}</small>
                </button>
              ))}
            </div>
            <h4>Start over</h4>
            <button className="sizerow" onClick={() => { dispatch({ type: 'setDoc', doc: blankDocument(artboard.width, artboard.height, 'Untitled') }); setOpen(null); }}>
              <span>New blank design</span><small>{artboard.width} &times; {artboard.height}</small>
            </button>
          </div>
        )}
      </div>

      <div className="group">
        <button className="tool" title="Undo (Cmd Z)" aria-label="Undo" disabled={!state.history.past.length} onClick={() => dispatch({ type: 'undo' })}>
          <svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h9a7 7 0 010 14H8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="tool" title="Redo (Shift Cmd Z)" aria-label="Redo" disabled={!state.history.future.length} onClick={() => dispatch({ type: 'redo' })}>
          <svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5m5 5h-9a7 7 0 000 14h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="tool" title="Fit to view" aria-label="Fit to view" onClick={fit}>
          <svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>

      <button className="btn" onClick={onShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
      <button className="btn" onClick={onPresent} title="Present (Cmd Shift P)">Present</button>

      <input ref={fileRef} type="file" accept=".json,application/json" hidden
             onChange={e => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
      <button className="btn" onClick={() => fileRef.current?.click()}>Open</button>

      <button className="btn btn-primary" aria-haspopup="dialog" onClick={() => setExporting(true)}>Export</button>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}

      {state.readOnly && <span className="ro">read-only</span>}
      {state.toast && <div className={`toast toast-${state.toast.level}`}>{state.toast.message}</div>}
    </header>
  );
}
