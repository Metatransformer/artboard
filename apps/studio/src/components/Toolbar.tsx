import React, { useRef, useState } from 'react';
import { parseDocument } from '@artboard/schema';
import { useEditor } from '../state/store';
import { exportRaster, exportSvg, saveFile, ExportBudgetExceededError } from '../lib/export';

const TOOLS = [
  { id: 'select', label: 'Select', key: 'V', icon: 'M4 3l14 7-6 1.5L10 18z' },
  { id: 'text', label: 'Text', key: 'T', icon: 'M5 5h14M12 5v14' },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: 'M4 5h16v14H4z' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: 'M12 4a8 7 0 100 14 8 7 0 100-14' },
  { id: 'line', label: 'Line', key: 'L', icon: 'M4 19L20 5' },
  { id: 'hand', label: 'Pan', key: 'H', icon: 'M8 13V6a1.5 1.5 0 013 0v5m0-1a1.5 1.5 0 013 0v1m0 0a1.5 1.5 0 013 0v4a6 6 0 01-6 6h-1a6 6 0 01-6-6v-3' },
];

export function Toolbar({ tool, setTool }: { tool: string; setTool: (t: string) => void }) {
  const { state, dispatch, artboard } = useEditor();
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const safeName = (state.doc.name || 'design').replace(/[^\w-]+/g, '-').toLowerCase();

  const doExport = async (kind: 'png' | 'jpg' | 'svg' | 'json') => {
    setBusy(kind);
    try {
      const r =
        kind === 'svg'
          ? await saveFile(exportSvg(state.doc, state.activeArtboard), `${safeName}.svg`, 'image/svg+xml')
          : kind === 'json'
          ? await saveFile(JSON.stringify(state.doc, null, 2), `${safeName}.artboard.json`, 'application/json')
          : await saveFile(
              await exportRaster(state.doc, state.activeArtboard, 2, kind === 'png' ? 'image/png' : 'image/jpeg'),
              `${safeName}.${kind}`,
              kind === 'png' ? 'image/png' : 'image/jpeg',
            );
      dispatch({
        type: 'toast',
        toast:
          r.status === 'declined'
            ? { level: 'info', message: 'Export cancelled' }
            : { level: 'info', message: r.note ?? `Exported ${kind.toUpperCase()}` },
      });
    } catch (e) {
      const msg = e instanceof ExportBudgetExceededError ? e.message
        : e instanceof Error ? `${e.name}: ${e.message}` : 'Export failed';
      dispatch({ type: 'toast', toast: { level: 'error', message: msg } });
    } finally {
      setBusy(null);
      setTimeout(() => dispatch({ type: 'toast', toast: null }), 5000);
    }
  };

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

  return (
    <header className="toolbar">
      <div className="brand">
        <svg viewBox="0 0 24 24" className="logo"><rect x="2" y="2" width="20" height="20" rx="5" fill="url(#lg)" /><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6366f1" /><stop offset="1" stopColor="#ec4899" /></linearGradient></defs><path d="M7 16l4-8 3 5 1.5-2L18 16z" fill="#fff" /></svg>
        <div><b>Artboard</b><small>MIT · local-first</small></div>
      </div>

      <div className="tools">
        {TOOLS.map(t => (
          <button key={t.id} className={`tool ${tool === t.id ? 'on' : ''}`} title={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
            <svg viewBox="0 0 24 24"><path d={t.icon} fill={t.id === 'select' || t.id === 'rect' || t.id === 'ellipse' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ))}
      </div>

      <div className="spacer" />

      <div className="group">
        <button className="tool" title="Undo (⌘Z)" disabled={!state.history.past.length} onClick={() => dispatch({ type: 'undo' })}>
          <svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h9a7 7 0 010 14H8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="tool" title="Redo (⇧⌘Z)" disabled={!state.history.future.length} onClick={() => dispatch({ type: 'redo' })}>
          <svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5m5 5h-9a7 7 0 000 14h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>

      <div className="group zoom">
        <button className="tool" onClick={() => dispatch({ type: 'setZoom', zoom: state.zoom / 1.25 })}>&minus;</button>
        <button className="zoomlabel" onClick={() => { dispatch({ type: 'setZoom', zoom: 1 }); dispatch({ type: 'setPan', pan: { x: 0, y: 0 } }); }}>{Math.round(state.zoom * 100)}%</button>
        <button className="tool" onClick={() => dispatch({ type: 'setZoom', zoom: state.zoom * 1.25 })}>+</button>
        <button className="tool" title="Fit to view" onClick={() => {
          const host = document.querySelector('.canvas-host');
          if (!host) return;
          const r = host.getBoundingClientRect();
          dispatch({ type: 'setZoom', zoom: Math.min((r.width - 120) / artboard.width, (r.height - 120) / artboard.height) });
          dispatch({ type: 'setPan', pan: { x: 0, y: 0 } });
        }}>Fit</button>
      </div>

      <input ref={fileRef} type="file" accept=".json,application/json" hidden
             onChange={e => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
      <button className="btn" onClick={() => fileRef.current?.click()}>Open</button>

      <div className="exportmenu">
        <button className="btn btn-primary" disabled={!!busy}>{busy ? 'Exporting…' : 'Export'}</button>
        <div className="menu">
          <button onClick={() => doExport('png')}>PNG <small>2× raster</small></button>
          <button onClick={() => doExport('jpg')}>JPG <small>2× raster</small></button>
          <button onClick={() => doExport('svg')}>SVG <small>vector, infinite</small></button>
          <button onClick={() => doExport('json')}>.artboard.json <small>the open format</small></button>
        </div>
      </div>

      {state.readOnly && <span className="ro">read-only</span>}
      {state.toast && <div className={`toast toast-${state.toast.level}`}>{state.toast.message}</div>}
    </header>
  );
}
