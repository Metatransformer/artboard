import React from 'react';
import { useEditor } from '../state/store';
import { EffectsPanel } from './EffectsPanel';
import { ArrangePanel } from './ArrangePanel';

const FONTS = ['Inter', 'Playfair Display', 'DM Serif Display', 'Space Grotesk', 'JetBrains Mono'];
const SWATCHES = ['#111111', '#ffffff', '#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b', '#f1f5f9', '#fbbf24'];

export function Inspector() {
  const { state, run, artboard, selected } = useEditor();
  const n = selected[0] as any;

  const patch = (p: Record<string, unknown>) => {
    if (selected.length === 1) run({ type: 'updateNode', nodeId: n.id, patch: p });
    else run({ type: 'batch', label: 'edit', commands: selected.map(s => ({ type: 'updateNode', nodeId: s.id, patch: p })) });
  };
  const abPatch = (p: Record<string, unknown>) => run({ type: 'setArtboard', artboardId: artboard.id, patch: p });

  if (!n) {
    const bg = artboard.background as any;
    return (
      <div className="props">
        <Section title="Page">
          <Row label="Size">
            <Num value={artboard.width} onChange={v => abPatch({ width: Math.max(1, v) })} />
            <Num value={artboard.height} onChange={v => abPatch({ height: Math.max(1, v) })} />
          </Row>
          <Row label="Background">
            <ColorField
              value={bg?.kind === 'solid' ? bg.color : '#ffffff'}
              onChange={c => abPatch({ background: { kind: 'solid', color: c } })}
            />
          </Row>
          <div className="swatches">
            {SWATCHES.map(c => (
              <button key={c} className="swatch" style={{ background: c }} title={c}
                      onClick={() => abPatch({ background: { kind: 'solid', color: c } })} />
            ))}
          </div>
          <button className="btn btn-ghost full" onClick={() => abPatch({ background: { kind: 'gradient', angle: 135, stops: [{ offset: 0, color: '#6366f1' }, { offset: 1, color: '#ec4899' }] } })}>
            Apply gradient
          </button>
        </Section>
        <div className="hint">Select an element to edit it. Double-click text to type.</div>
      </div>
    );
  }

  const multi = selected.length > 1;
  return (
    <div className="props">
      <Section title={multi ? `${selected.length} selected` : (n.name || n.kind)}>
        <Row label="Position">
          <Num value={n.x} onChange={v => patch({ x: v })} prefix="X" />
          <Num value={n.y} onChange={v => patch({ y: v })} prefix="Y" />
        </Row>
        <Row label="Size">
          <Num value={n.width} onChange={v => patch({ width: Math.max(1, v) })} prefix="W" />
          <Num value={n.height} onChange={v => patch({ height: Math.max(0, v) })} prefix="H" />
        </Row>
        <Row label="Rotate">
          <Num value={n.rotation ?? 0} onChange={v => patch({ rotation: v })} suffix="deg" />
        </Row>
        <Row label={`Opacity  ${Math.round((n.opacity ?? 1) * 100)}%`}>
          <Slider min={0} max={1} step={0.01} value={n.opacity ?? 1} onChange={v => patch({ opacity: v })} />
        </Row>
      </Section>

      {n.kind === 'text' && (
        <Section title="Type">
          <select className="field" value={n.fontFamily} onChange={e => patch({ fontFamily: e.target.value })}>
            {FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <Row label="Size / weight">
            <Num value={n.fontSize} onChange={v => patch({ fontSize: Math.max(1, v) })} />
            <select className="field" value={n.fontWeight} onChange={e => patch({ fontWeight: Number(e.target.value) })}>
              {[300, 400, 500, 600, 700, 800, 900].map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </Row>
          <Row label="Leading / tracking">
            <Num value={n.lineHeight} step={0.05} onChange={v => patch({ lineHeight: Math.max(0.5, v) })} />
            <Num value={n.letterSpacing} step={0.5} onChange={v => patch({ letterSpacing: v })} />
          </Row>
          <div className="seg">
            {(['left', 'center', 'right'] as const).map(a => (
              <button key={a} className={`seg-btn ${n.align === a ? 'on' : ''}`} onClick={() => patch({ align: a })}>{a[0]!.toUpperCase()}</button>
            ))}
            <button className={`seg-btn ${n.italic ? 'on' : ''}`} style={{ fontStyle: 'italic' }} onClick={() => patch({ italic: !n.italic })}>I</button>
            <button className={`seg-btn ${n.uppercase ? 'on' : ''}`} onClick={() => patch({ uppercase: !n.uppercase })}>AA</button>
          </div>
          <Row label="Colour"><ColorField value={n.color} onChange={c => patch({ color: c })} /></Row>
          <div className="swatches">
            {SWATCHES.map(c => <button key={c} className="swatch" style={{ background: c }} onClick={() => patch({ color: c })} />)}
          </div>
        </Section>
      )}

      {(n.kind === 'rect' || n.kind === 'ellipse' || n.kind === 'path') && (
        <Section title="Fill">
          <Row label="Colour">
            <ColorField value={n.fill?.kind === 'solid' ? n.fill.color : '#4f46e5'}
                        onChange={c => patch({ fill: { kind: 'solid', color: c } })} />
          </Row>
          <div className="swatches">
            {SWATCHES.map(c => <button key={c} className="swatch" style={{ background: c }} onClick={() => patch({ fill: { kind: 'solid', color: c } })} />)}
          </div>
          <button className="btn btn-ghost full" onClick={() => patch({ fill: { kind: 'gradient', angle: 135, stops: [{ offset: 0, color: '#6366f1' }, { offset: 1, color: '#ec4899' }] } })}>Gradient</button>
          {n.kind === 'rect' && <Row label="Corner"><Num value={n.radius ?? 0} onChange={v => patch({ radius: Math.max(0, v) })} /></Row>}
        </Section>
      )}

      {n.kind !== 'text' && (
        <Section title="Stroke">
          <Row label="Width">
            <Num value={n.stroke?.width ?? 0} onChange={v => patch({ stroke: { ...(n.stroke ?? { color: '#000000', dash: [] }), width: Math.max(0, v) } })} />
            <ColorField value={n.stroke?.color ?? '#000000'} onChange={c => patch({ stroke: { ...(n.stroke ?? { width: 1, dash: [] }), color: c } })} />
          </Row>
        </Section>
      )}

      <EffectsPanel />

      <ArrangePanel />
    </div>
  );
}

/* ── field primitives ───────────────────────────────────────────────────── */
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="section"><h3>{title}</h3>{children}</div>
);
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="row"><label>{label}</label><div className="row-fields">{children}</div></div>
);

function Num({ value, onChange, step = 1, prefix, suffix }: { value: number; onChange: (v: number) => void; step?: number; prefix?: string; suffix?: string }) {
  return (
    <div className="num">
      {prefix && <span className="affix">{prefix}</span>}
      <input className="field" type="number" step={step} value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
             onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v); }} />
      {suffix && <span className="affix">{suffix}</span>}
    </div>
  );
}
const Slider = ({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) => (
  <input className="slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} />
);
function ColorField({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="colorfield">
      <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'} onChange={e => onChange(e.target.value)} />
      <input className="field mono" value={value} onChange={e => { const v = e.target.value; if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) onChange(v); }} />
    </div>
  );
}
