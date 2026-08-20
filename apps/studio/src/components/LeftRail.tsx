import React, { useMemo, useRef, useState } from 'react';
import { uid } from '@artboard/commands';
import { buildNode } from '@artboard/schema';
import { renderArtboard, serialize } from '@artboard/render-svg';
import { TEMPLATES, CATEGORIES } from '@artboard/templates';
import { useEditor, documentFromTemplate } from '../state/store';
import { makeNode } from './Canvas';
import { BrandPanel } from './BrandPanel';
import { ProjectsPanel } from './ProjectsPanel';

/**
 * The left rail holds CONTENT SOURCES only - things you bring *into* the
 * document. Mutually-exclusive tabs are correct here, because you can only
 * browse one library at a time. Document state (layers) and selection
 * properties live in the right dock, so they stay visible while you browse.
 */
type Section = 'projects' | 'design' | 'elements' | 'text' | 'uploads' | 'brand';

const RAIL: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: 'projects', label: 'Projects', icon: <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.5h9A1.5 1.5 0 0121 10v8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /> },
  { id: 'design', label: 'Design', icon: <><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></> },
  { id: 'elements', label: 'Elements', icon: <><circle cx="8" cy="8" r="5" /><rect x="11.5" y="11.5" width="9.5" height="9.5" rx="1.6" /></> },
  { id: 'text', label: 'Text', icon: <path d="M4 6.5V4h16v2.5M12 4v16M8.5 20h7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /> },
  { id: 'uploads', label: 'Uploads', icon: <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /> },
  { id: 'brand', label: 'Brand', icon: <><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.9" /><path d="M12 3.5A8.5 8.5 0 0112 20.5z" /></> },
];

export function LeftRail() {
  const [open, setOpen] = useState<Section | null>('design');

  return (
    <>
      <nav className="rail" aria-label="Content libraries">
        {RAIL.map(r => (
          <button
            key={r.id}
            className={`railbtn ${open === r.id ? 'on' : ''}`}
            aria-pressed={open === r.id}
            onClick={() => setOpen(open === r.id ? null : r.id)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">{r.icon}</svg>
            <span>{r.label}</span>
          </button>
        ))}
      </nav>

      {open && (
        <aside className={`drawer drawer-${open}`} aria-label={`${open} library`}>
          <header className="drawer-head">
            <h2>{RAIL.find(r => r.id === open)!.label}</h2>
            <button className="tool sm" title="Close panel" aria-label="Close panel" onClick={() => setOpen(null)}>
              <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </header>
          <div className="drawer-body">
            {open === 'projects' && <ProjectsPanel />}
            {open === 'design' && <Designs />}
            {open === 'elements' && <Elements />}
            {open === 'text' && <TextLibrary />}
            {open === 'uploads' && <Uploads />}
            {open === 'brand' && <BrandPanel />}
          </div>
        </aside>
      )}
    </>
  );
}

/* ── Design (templates) ─────────────────────────────────────────────────── */

function Designs() {
  const { dispatch } = useEditor();
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  const list = useMemo(() => (TEMPLATES as any[]).filter(t =>
    (cat === 'All' || t.category === cat) && (q === '' || t.name.toLowerCase().includes(q.toLowerCase()))), [cat, q]);

  return (
    <>
      <input className="field search" placeholder="Search designs" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chips">
        {['All', ...(CATEGORIES as string[])].map(c => (
          <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      {list.length === 0 ? <div className="hint">Nothing matches that search.</div> : (
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
      const ab = doc.artboards[0];
      if (!ab) return '';
      return serialize(renderArtboard(doc, ab).scene, 0);
    } catch { return ''; }
  }, [template]);
  const ab = template.artboards?.[0] ?? template;
  return <span className="thumb" style={{ paddingTop: `${(ab.height / ab.width) * 100}%` }} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ── Elements ───────────────────────────────────────────────────────────── */

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

function useInsert() {
  const { run, dispatch, artboard } = useEditor();
  const centre = (w: number, h: number) => ({ x: Math.round((artboard.width - w) / 2), y: Math.round((artboard.height - h) / 2) });
  const add = (node: any) => { run({ type: 'addNode', artboardId: artboard.id, node }); dispatch({ type: 'select', ids: [node.id] }); };
  return { add, centre, artboard, run, dispatch };
}

function Elements() {
  const { add, centre, artboard } = useInsert();
  const sq = () => { const s = Math.round(artboard.width * 0.3); return { s, c: centre(s, s) }; };

  return (
    <>
      <h4>Shapes</h4>
      <div className="egrid">
        <button className="ecard" title="Rectangle" onClick={() => { const { s, c } = sq(); add(makeNode('rect', c.x, c.y, s, s)); }}>
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" /></svg>
        </button>
        <button className="ecard" title="Rounded rectangle" onClick={() => { const { s, c } = sq(); add({ ...makeNode('rect', c.x, c.y, s, s), radius: Math.round(s * 0.18) }); }}>
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="6" fill="currentColor" /></svg>
        </button>
        <button className="ecard" title="Circle" onClick={() => { const { s, c } = sq(); add(makeNode('ellipse', c.x, c.y, s, s)); }}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" /></svg>
        </button>
        <button className="ecard" title="Line" onClick={() => { const w = Math.round(artboard.width * 0.5); const c = centre(w, 0); add(makeNode('line', c.x, Math.round(artboard.height / 2), w, 0)); }}>
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

      <h4>Lines &amp; dividers</h4>
      <div className="stack">
        {[{ n: 'Rule', w: 4 }, { n: 'Thick rule', w: 12 }].map(l => (
          <button key={l.n} className="btn full" onClick={() => {
            const w = Math.round(artboard.width * 0.5); const c = centre(w, 0);
            add({ ...makeNode('line', c.x, Math.round(artboard.height / 2), w, 0), stroke: { color: '#111111', width: l.w, dash: [] } });
          }}>{l.n}</button>
        ))}
      </div>
    </>
  );
}

/* ── Text ───────────────────────────────────────────────────────────────── */

const FONTS = ['Inter', 'Playfair Display', 'DM Serif Display', 'Space Grotesk', 'JetBrains Mono'];

function TextLibrary() {
  const { add, centre, artboard } = useInsert();
  const addText = (scale: number, weight: number, text: string, font = 'Inter') => {
    const size = Math.round(artboard.width * scale);
    const w = Math.round(artboard.width * 0.72), h = Math.round(size * 1.4);
    const c = centre(w, h);
    add({ ...makeNode('text', c.x, c.y, w, h), text, fontSize: size, fontWeight: weight, fontFamily: font, align: 'center' });
  };

  return (
    <>
      <h4>Add text</h4>
      <div className="stack">
        <button className="btn full tall" style={{ fontSize: 21, fontWeight: 800 }} onClick={() => addText(0.11, 800, 'Add a heading')}>Add a heading</button>
        <button className="btn full tall" style={{ fontSize: 16, fontWeight: 600 }} onClick={() => addText(0.055, 600, 'Add a subheading')}>Add a subheading</button>
        <button className="btn full tall" style={{ fontSize: 13.5 }} onClick={() => addText(0.032, 400, 'Add a little bit of body text')}>Add body text</button>
      </div>

      <h4>Font styles</h4>
      <div className="stack">
        {FONTS.map(f => (
          <button key={f} className="btn full tall" style={{ fontFamily: `'${f}', sans-serif`, fontSize: 16 }}
                  onClick={() => addText(0.075, f === 'Inter' ? 700 : 400, f, f)}>
            {f}
          </button>
        ))}
      </div>
    </>
  );
}

/* ── Uploads ────────────────────────────────────────────────────────────── */

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_PIXELS = 40_000_000;

function Uploads() {
  const { state, run, dispatch, artboard } = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const assets = Object.values(state.doc.assets ?? {}) as any[];

  const ingest = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is over the 12 MB limit.`);
        const data = await readDataUrl(file);
        const { width, height } = await probe(data);
        if (width * height > MAX_UPLOAD_PIXELS) throw new Error(`${file.name} is ${(width * height / 1e6).toFixed(0)} MP; the limit is 40 MP.`);
        const asset = { id: uid('asset'), mime: file.type, width, height, data };
        run({ type: 'addAsset', asset });
        place(asset);
      } catch (e) {
        dispatch({ type: 'toast', toast: { level: 'error', message: e instanceof Error ? e.message : 'Could not read that image' } });
        setTimeout(() => dispatch({ type: 'toast', toast: null }), 5000);
      }
    }
  };

  const place = (asset: any) => {
    const w = Math.round(artboard.width * 0.6);
    const h = Math.round(w * (asset.height / asset.width));
    const node = buildNode({
      id: uid('n'), kind: 'image', name: 'Image',
      x: Math.round((artboard.width - w) / 2), y: Math.round((artboard.height - h) / 2),
      width: w, height: h, assetId: asset.id, fit: 'cover',
    });
    run({ type: 'addNode', artboardId: artboard.id, node });
    dispatch({ type: 'select', ids: [node.id] });
  };

  return (
    <>
      <div
        className={`dropzone ${drag ? 'over' : ''}`}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) ingest(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
      >
        <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <b>Drop an image</b>
        <small>or click to browse. PNG, JPG, SVG, WebP.</small>
      </div>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden
             onChange={e => { if (e.target.files?.length) ingest(e.target.files); e.target.value = ''; }} />

      <p className="hint tight">Images are embedded in the document as data URIs, so a <code>.artboard.json</code> file is always self-contained - it never points at your filesystem.</p>

      {assets.length > 0 && (
        <>
          <h4>In this document</h4>
          <div className="ugrid">
            {assets.map(a => (
              <button key={a.id} className="ucard" title="Place on the page" onClick={() => place(a)}>
                <img src={a.data} alt="" />
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** Read the header only - we never decode a bitmap just to learn its size. */
function probe(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => rej(new Error('That file is not a readable image.'));
    img.src = dataUrl;
  });
}
