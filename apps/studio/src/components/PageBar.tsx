import React from 'react';
import { uid } from '@artboard/commands';
import { useEditor } from '../state/store';

/**
 * Pages are document navigation, so they get their own strip along the bottom -
 * the one place in the app where the whole document, not the current selection,
 * is the subject. Zoom lives here too, next to what it zooms.
 */
export function PageBar() {
  const { state, dispatch, artboard } = useEditor();
  const boards = state.doc.artboards as any[];

  const addPage = () => {
    const src = boards[state.activeArtboard] ?? boards[0];
    const next = { id: uid('ab'), name: `Page ${boards.length + 1}`, width: src.width, height: src.height, background: src.background, nodes: [] };
    dispatch({ type: 'setDoc', doc: { ...state.doc, artboards: [...boards, next] } });
    dispatch({ type: 'setArtboardIndex', index: boards.length });
  };

  const removePage = (i: number) => {
    if (boards.length < 2) return;
    dispatch({ type: 'setDoc', doc: { ...state.doc, artboards: boards.filter((_, k) => k !== i) } });
    dispatch({ type: 'setArtboardIndex', index: Math.max(0, i - 1) });
  };

  return (
    <footer className="pagebar">
      <div className="pages">
        {boards.map((b, i) => (
          <button key={b.id} className={`pagechip ${i === state.activeArtboard ? 'on' : ''}`}
                  onClick={() => dispatch({ type: 'setArtboardIndex', index: i })}>
            {b.name || `Page ${i + 1}`} <small>{b.width}&times;{b.height}</small>
            {boards.length > 1 && (
              <span role="button" tabIndex={0} className="licon" title="Delete page"
                    onClick={e => { e.stopPropagation(); removePage(i); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); removePage(i); } }}>
                <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </span>
            )}
          </button>
        ))}
        <button className="pagechip" onClick={addPage} title="Add a page">+ Page</button>
      </div>

      <span className="meta">{artboard.width} &times; {artboard.height} px</span>

      <input
        className="zoomslider" type="range" min={-2} max={2} step={0.01}
        value={Math.log2(state.zoom)}
        aria-label="Zoom"
        onChange={e => dispatch({ type: 'setZoom', zoom: 2 ** Number(e.target.value) })}
      />
      <span className="meta" style={{ width: 42, textAlign: 'right' }}>{Math.round(state.zoom * 100)}%</span>
    </footer>
  );
}
