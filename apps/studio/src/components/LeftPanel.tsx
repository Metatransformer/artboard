import React, { useMemo, useState } from 'react';
import type { Node } from '@artboard/schema';
import { uid } from '@artboard/commands';
import { renderArtboard, serialize } from '@artboard/render-svg';
import { TEMPLATES, CATEGORIES, PRESET_SIZES } from '@artboard/templates';
import { useEditor, documentFromTemplate, blankDocument } from '../state/store';
import { makeNode } from './Canvas';

type Tab = 'templates' | 'elements' | 'layers' | 'size';

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>('templates');
  return (
    <aside className="panel panel-left">
      <div className="tabs">
        {(['templates', 'elements', 'layers', 'size'] as Tab[]).map(t => (
          <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'templates' && <Templates />}
        {tab === 'elements' && <Elements />}
        {tab === 'layers' && <Layers />}
        {tab === 'size' && <Sizes />}
      </div>
    </aside>
  );
}

function Templates() {
  const { dispatch } = useEditor();
  const [cat, setCat] = useState<string>('All');
  const [q, setQ] = useState('');
  const list = useMemo(() => (TEMPLATES as any[]).filter(t =>
    (cat === 'All' || t.category === cat) && (q === '' || t.name.toLowerCase().includes(q.toLowerCase()))), [cat, q]);

  if (!TEMPLATES || TEMPLATES.length === 0) return <div className="hint">No templates loaded.</div>;

  return (
    <>
      <input className="field search" placeholder="Search templates" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chips">
        {['All', ...(CATEGORIES as string[])].map(c => (
          <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      {list.length === 0 ? <div className="hint">Nothing matches “{q}”. Try a different search.</div> : (
        <div className="tgrid">
          {list.map(t => (
            <button key={t.id} className="tcard" title={t.name}
                    onClick={() => dispatch({ type: 'setDoc', doc: documentFromTemplate(t) })}>
              <TemplateThumb template={t} />
              <span>{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function TemplateThumb({ template }: { template: any }) {
  const html = useMemo(() => {
    try {
      const doc = documentFromTemplate(template);
      const { scene } = renderArtboard(doc, doc.artboards[0]!);
      return serialize(scene);
    } catch { return ''; }
  }, [template]);
  const ratio = template.height / template.width;
  return <div className="thumb" style={{ paddingBottom: `${ratio * 100}%` }} dangerouslySetInnerHTML={{ __html: html }} />;
}

const SHAPES: Array<{ name: string; d: string; vb: [number, number] }> = [
  { name: 'Star', d: 'M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z', vb: [24, 24] },
  { name: 'Heart', d: 'M12 21s-8-4.9-8-10.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 3.6C20 16.1 12 21 12 21z', vb: [24, 24] },
  { name: 'Bolt', d: 'M13 2L4 14h6l-1 8 9-12h-6z', vb: [24, 24] },
  { name: 'Check', d: 'M20 6L9 17l-5-5', vb: [24, 24] },
  { name: 'Arrow', d: 'M4 12h14m-5-6l6 6-6 6', vb: [24, 24] },
  { name: 'Blob', d: 'M45 8c12 0 22 9 22 21s-6 25-19 28S18 52 15 40 20 12 33 9z', vb: [80, 70] },
  { name: 'Triangle', d: 'M12 3l9 17H3z', vb: [24, 24] },
  { name: 'Badge', d: 'M12 1l3 3h4v4l3 3-3 3v4h-4l-3 3-3-3H5v-4l-3-3 3-3V4h4z', vb: [24, 24] },
];

function Elements() {
  const { run, dispatch, artboard } = useEditor();
  const add = (node: any) => { run({ type: 'addNode', artboardId: artboard.id, node }); dispatch({ type: 'select', ids: [node.id] }); };
  const centre = (w: number, h: number) => ({ x: Math.round((artboard.width - w) / 2), y: Math.round((artboard.height - h) / 2) });

  const addText = (size: number, weight: number, text: string) => {
    const w = Math.round(artboard.width * 0.72), h = Math.round(size * 1.4);
    const c = centre(w, h);
    add({ ...makeNode('text', c.x, c.y, w, h), text, fontSize: size, fontWeight: weight, align: 'center' });
  };

  return (
    <>
      <h4>Text</h4>
      <div className="stack">
        <button className="btn full" style={{ fontSize: 20, fontWeight: 800 }} onClick={() => addText(Math.round(artboard.width * 0.11), 800, 'Add a headline')}>Add a headline</button>
        <button className="btn full" style={{ fontSize: 15, fontWeight: 600 }} onClick={() => addText(Math.round(artboard.width * 0.055), 600, 'Add a subheading')}>Add a subheading</button>
        <button className="btn full" style={{ fontSize: 13 }} onClick={() => addText(Math.round(artboard.width * 0.032), 400, 'Add a little bit of body text')}>Add body text</button>
      </div>

      <h4>Shapes</h4>
      <div className="egrid">
        <button className="ecard" onClick={() => { const s = Math.round(artboard.width * 0.3); const c = centre(s, s); add(makeNode('rect', c.x, c.y, s, s)); }}>
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" /></svg>
        </button>
        <button className="ecard" onClick={() => { const s = Math.round(artboard.width * 0.3); const c = centre(s, s); add({ ...makeNode('rect', c.x, c.y, s, s), radius: Math.round(s * 0.18) }); }}>
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="6" fill="currentColor" /></svg>
        </button>
        <button className="ecard" onClick={() => { const s = Math.round(artboard.width * 0.3); const c = centre(s, s); add(makeNode('ellipse', c.x, c.y, s, s)); }}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" /></svg>
        </button>
        <button className="ecard" onClick={() => { const w = Math.round(artboard.width * 0.5); const c = centre(w, 0); add(makeNode('line', c.x, Math.round(artboard.height / 2), w, 0)); }}>
          <svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="2.5" /></svg>
        </button>
        {SHAPES.map(s => (
          <button key={s.name} className="ecard" title={s.name} onClick={() => {
            const size = Math.round(artboard.width * 0.28); const c = centre(size, size);
            add({ ...makeNode('rect', c.x, c.y, size, size), kind: 'path', name: s.name, d: s.d, viewBox: s.vb, fill: { kind: 'solid', color: '#4f46e5' }, stroke: { color: '#000000', width: 0, dash: [] } });
          }}>
            <svg viewBox={`0 0 ${s.vb[0]} ${s.vb[1]}`}><path d={s.d} fill="currentColor" /></svg>
          </button>
        ))}
      </div>
    </>
  );
}

function Layers() {
  const { state, dispatch, run, artboard } = useEditor();
  const nodes = artboard.nodes as Node[];
  if (nodes.length === 0) return <div className="hint">No layers yet. Add something from Elements, or start from a template.</div>;
  return (
    <div className="layers">
      {[...nodes].reverse().map((n, ri) => {
        const idx = nodes.length - 1 - ri;
        const a = n as any;
        const on = state.selection.includes(n.id);
        return (
          <div key={n.id} className={`layer ${on ? 'on' : ''}`} onClick={e => dispatch({ type: 'select', ids: e.shiftKey ? [...state.selection, n.id] : [n.id] })}>
            <span className="lkind">{a.kind}</span>
            <span className="lname">{a.name || (a.kind === 'text' ? a.text.slice(0, 24) : a.kind)}</span>
            <button className="licon" title={a.visible ? 'Hide' : 'Show'} onClick={e => { e.stopPropagation(); run({ type: 'updateNode', nodeId: n.id, patch: { visible: !a.visible } }); }}>{a.visible ? '👁' : '—'}</button>
            <button className="licon" title={a.locked ? 'Unlock' : 'Lock'} onClick={e => { e.stopPropagation(); run({ type: 'updateNode', nodeId: n.id, patch: { locked: !a.locked } }); }}>{a.locked ? '🔒' : '🔓'}</button>
            <button className="licon" title="Up" onClick={e => { e.stopPropagation(); run({ type: 'reorder', artboardId: artboard.id, nodeId: n.id, to: idx + 1 }); }}>↑</button>
            <button className="licon" title="Delete" onClick={e => { e.stopPropagation(); run({ type: 'removeNode', artboardId: artboard.id, nodeId: n.id }); }}>✕</button>
          </div>
        );
      })}
    </div>
  );
}

function Sizes() {
  const { run, dispatch, artboard } = useEditor();
  const presets = (PRESET_SIZES as any[]) ?? [];
  return (
    <>
      <div className="hint">Resize the current artboard, or start a blank one.</div>
      <div className="stack">
        {presets.map(p => (
          <div key={p.name} className="sizerow">
            <button className="btn grow" onClick={() => run({ type: 'setArtboard', artboardId: artboard.id, patch: { width: p.width, height: p.height } })}>
              <b>{p.name}</b><small>{p.width} × {p.height}</small>
            </button>
            <button className="btn btn-ghost" title="New blank document at this size"
                    onClick={() => dispatch({ type: 'setDoc', doc: blankDocument(p.width, p.height, p.name) })}>New</button>
          </div>
        ))}
      </div>
    </>
  );
}
