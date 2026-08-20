import React, { useEffect, useRef, useState } from 'react';
import { BlendMode, type Effect } from '@artboard/schema';
import type { Command } from '@artboard/commands';
import { useEditor } from '../state/store';

/**
 * Effects panel: the stackable `effects: Effect[]` list on the selected
 * node(s), plus its blend mode.
 *
 * Two rules drive the shape of this file:
 *  - Effects are DATA. Everything written here is a plain schema object with
 *    every field present, so a preset can be recognised again by deep equality
 *    and the renderer never sees a half-populated effect.
 *  - Order is visible. The stack is drawn top-to-bottom in array order with
 *    move up / move down, because `compileEffects` walks the array in order.
 *
 * Slider drags preview through `runTransient` and land ONE history entry on
 * pointer-up: the transient value is reverted first so `invert()` captures the
 * pre-drag state, exactly as Canvas.tsx does for move/resize/rotate.
 */

type Kind = Effect['kind'];
type OfKind<K extends Kind> = Extract<Effect, { kind: K }>;

const DEFAULTS: { [K in Kind]: OfKind<K> } = {
  shadow: { kind: 'shadow', x: 8, y: 8, blur: 10, spread: 0, color: '#000000', opacity: 0.35 },
  glow: { kind: 'glow', blur: 14, color: '#6366f1', opacity: 0.75 },
  blur: { kind: 'blur', radius: 6 },
  outline: { kind: 'outline', width: 6, color: '#000000' },
  echo: { kind: 'echo', dx: 10, dy: 10, count: 2, color: '#000000', opacity: 0.4 },
  background: { kind: 'background', color: '#111111', padding: 16, radius: 8, opacity: 1 },
  curve: { kind: 'curve', amount: 50 },
  adjust: { kind: 'adjust', brightness: 0, contrast: 0, saturation: 0, hue: 0, sepia: 0, invert: 0 },
  duotone: { kind: 'duotone', dark: '#1e1b4b', light: '#f8fafc' },
  vignette: { kind: 'vignette', amount: 45, color: '#000000' },
};

const TITLES: Record<Kind, string> = {
  shadow: 'Shadow', glow: 'Glow', blur: 'Blur', outline: 'Outline', echo: 'Echo',
  background: 'Background plate', curve: 'Curve', adjust: 'Adjust',
  duotone: 'Duotone', vignette: 'Vignette',
};

/** Order of the add menu. `curve` sits last: it is offered but not yet rendered. */
const ADD_ORDER: Kind[] = [
  'shadow', 'glow', 'blur', 'outline', 'echo', 'background', 'adjust', 'duotone', 'vignette', 'curve',
];

interface Preset {
  id: string;
  name: string;
  effects: Effect[];
  tile?: React.CSSProperties;
  glyph?: React.CSSProperties;
}

const PRESETS: Preset[] = [
  { id: 'none', name: 'None', effects: [] },
  {
    id: 'shadow', name: 'Shadow',
    effects: [{ ...DEFAULTS.shadow }],
    glyph: { textShadow: '3px 3px 4px rgba(0,0,0,.45)' },
  },
  {
    id: 'lift', name: 'Lift',
    effects: [{ kind: 'shadow', x: 0, y: 10, blur: 26, spread: 0, color: '#000000', opacity: 0.28 }],
    glyph: { textShadow: '0 5px 7px rgba(0,0,0,.45)' },
  },
  {
    id: 'outline', name: 'Outline',
    effects: [{ ...DEFAULTS.outline }],
    glyph: { color: '#ffffff', WebkitTextStroke: '1.5px #111111' },
  },
  {
    id: 'echo', name: 'Echo',
    effects: [{ ...DEFAULTS.echo }],
    glyph: { textShadow: '3px 3px 0 rgba(17,17,17,.45), 6px 6px 0 rgba(17,17,17,.26)' },
  },
  {
    id: 'glitch', name: 'Glitch',
    effects: [
      { kind: 'echo', dx: -6, dy: 0, count: 1, color: '#ff0055', opacity: 0.85 },
      { kind: 'echo', dx: 6, dy: 0, count: 1, color: '#00e5ff', opacity: 0.85 },
    ],
    glyph: { textShadow: '-2px 0 #ff0055, 2px 0 #00e5ff' },
  },
  {
    id: 'neon', name: 'Neon',
    effects: [
      { kind: 'glow', blur: 18, color: '#22d3ee', opacity: 0.95 },
      { kind: 'glow', blur: 6, color: '#ffffff', opacity: 0.9 },
    ],
    tile: { background: '#0b0d12' },
    glyph: { color: '#ffffff', textShadow: '0 0 7px #22d3ee, 0 0 2px #ffffff' },
  },
  {
    id: 'background', name: 'Background',
    effects: [{ ...DEFAULTS.background }],
    glyph: { color: '#ffffff', background: '#111111', padding: '2px 6px', borderRadius: 4 },
  },
];

/* ── equality ───────────────────────────────────────────────────────────── */

function sameEffect(a: Effect, b: Effect): boolean {
  if (a.kind !== b.kind) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  return keys.every(k => Object.is(ra[k], rb[k]));
}

function sameStack(a: readonly Effect[], b: readonly Effect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const o = b[i];
    return o !== undefined && sameEffect(e, o);
  });
}

/* ── reading the selection ──────────────────────────────────────────────── */

const idOf = (n: unknown): string => String((n as { id?: unknown }).id ?? '');
const effectsOf = (n: unknown): Effect[] => {
  const e = (n as { effects?: unknown }).effects;
  return Array.isArray(e) ? (e as Effect[]) : [];
};
const blendOf = (n: unknown): BlendMode => {
  const b = (n as { blend?: unknown }).blend;
  return typeof b === 'string' && (BlendMode.options as readonly string[]).includes(b) ? (b as BlendMode) : 'normal';
};

const clone = (fx: Effect): Effect => ({ ...fx } as Effect);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const summarise = (list: readonly Effect[]) =>
  list.length === 0 ? 'no effects' : list.map(f => TITLES[f.kind]).join(', ');

/* ── panel ──────────────────────────────────────────────────────────────── */

export function EffectsPanel() {
  const { run, dispatch, selected } = useEditor();
  const [open, setOpen] = useState<number[]>([]);
  /** Live slider/colour drag: `origin` is the pre-drag stack, `latest` the previewed one. */
  const dragRef = useRef<{ origin: Effect[]; latest: Effect[] } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);

  if (selected.length === 0) return null;

  const stacks = selected.map(effectsOf);
  const effects = stacks[0] ?? [];
  const mixed = stacks.some(s => !sameStack(s, effects));

  const cmdFor = (next: readonly Effect[]): Command => {
    const cmds: Command[] = selected.map(s => ({
      type: 'updateNode', nodeId: idOf(s), patch: { effects: next.map(clone) },
    }));
    return cmds.length === 1 ? cmds[0]! : { type: 'batch', label: 'effects', commands: cmds };
  };

  /** Preview a drag without touching history. */
  const preview = (next: Effect[]) => {
    const d = dragRef.current;
    if (d) d.latest = next;
    else dragRef.current = { origin: effects, latest: next };
    dispatch({ type: 'runTransient', cmd: cmdFor(next) });
  };

  /** End a drag: revert the preview, then commit the final value as one step. */
  const settle = () => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || sameStack(d.origin, d.latest)) return;
    dispatch({ type: 'runTransient', cmd: cmdFor(d.origin) });
    run(cmdFor(d.latest));
  };

  /** A discrete edit (add / remove / reorder / preset / hex typed in). */
  const write = (next: readonly Effect[]) => { settle(); run(cmdFor(next)); };

  /** Colour pickers stream values with no pointer-up of their own; settle on a timer too. */
  const previewSoon = (next: Effect[]) => {
    preview(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(settle, 400);
  };

  const replaceAt = (index: number, fx: Effect): Effect[] => {
    const next = effects.slice();
    next[index] = fx;
    return next;
  };

  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    const a = effects[index];
    const b = effects[to];
    if (!a || !b) return;
    const next = effects.slice();
    next[index] = b;
    next[to] = a;
    setOpen(o => o.map(x => (x === index ? to : x === to ? index : x)));
    write(next);
  };

  const removeAt = (index: number) => {
    setOpen(o => o.filter(x => x !== index).map(x => (x > index ? x - 1 : x)));
    write(effects.filter((_, i) => i !== index));
  };

  const addKind = (kind: Kind) => {
    setOpen(o => [...o, effects.length]);
    write([...effects, { ...DEFAULTS[kind] } as Effect]);
  };

  const applyPreset = (p: Preset) => {
    setOpen([]);
    write(p.effects);
  };

  const applyFirstToAll = () => {
    settle();
    run({
      type: 'batch', label: 'effects',
      commands: selected.map(s => ({ type: 'updateNode', nodeId: idOf(s), patch: { effects: effects.map(clone) } })),
    });
  };

  const blends = new Set(selected.map(blendOf));
  const blendValue = blends.size === 1 ? [...blends][0]! : '';
  const setBlend = (value: string) => {
    if (!(BlendMode.options as readonly string[]).includes(value)) return;
    settle();
    const cmds: Command[] = selected.map(s => ({ type: 'updateNode', nodeId: idOf(s), patch: { blend: value } }));
    run(cmds.length === 1 ? cmds[0]! : { type: 'batch', label: 'blend', commands: cmds });
  };

  return (
    <>
      <div className="section">
        <h3>Effects</h3>

        {mixed ? (
          <div className="fx-mixed">
            <p>Effects differ across the {selected.length} selected items.</p>
            <small>First item: {summarise(effects)}.</small>
            <button className="btn full" onClick={applyFirstToAll}>
              Apply the first item&rsquo;s effects to all {selected.length}
            </button>
          </div>
        ) : (
          <>
            <div className="fx-presets">
              {PRESETS.map(p => {
                const on = sameStack(effects, p.effects);
                return (
                  <button
                    key={p.id}
                    className={`fx-preset ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    title={p.name}
                    onClick={() => applyPreset(p)}
                  >
                    <span className="fx-preset-art" style={p.tile}>
                      <span className="fx-preset-glyph" style={p.glyph}>Ag</span>
                    </span>
                    <span className="fx-preset-name">{p.name}</span>
                  </button>
                );
              })}
            </div>

            {effects.length === 0
              ? <div className="fx-empty">No effects on this element. Pick a preset or add one below.</div>
              : (
                <div className="fx-stack">
                  {effects.map((fx, i) => (
                    <EffectRow
                      key={`${fx.kind}-${i}`}
                      fx={fx}
                      index={i}
                      count={effects.length}
                      open={open.includes(i)}
                      onToggle={() => setOpen(o => (o.includes(i) ? o.filter(x => x !== i) : [...o, i]))}
                      onMove={dir => move(i, dir)}
                      onRemove={() => removeAt(i)}
                      onPreview={next => preview(replaceAt(i, next))}
                      onPreviewSoon={next => previewSoon(replaceAt(i, next))}
                      onWrite={next => write(replaceAt(i, next))}
                      onSettle={settle}
                    />
                  ))}
                </div>
              )}

            <div className="fx-add">
              <select
                className="field"
                value=""
                aria-label="Add effect"
                onChange={e => { const v = e.target.value; if (v) addKind(v as Kind); }}
              >
                <option value="">Add effect…</option>
                {ADD_ORDER.map(k => (
                  <option key={k} value={k} disabled={k === 'curve'} title={k === 'curve' ? 'Coming soon' : undefined}>
                    {TITLES[k]}{k === 'curve' ? ' (coming soon)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h3>Blend</h3>
        <select className="field" value={blendValue} aria-label="Blend mode" onChange={e => setBlend(e.target.value)}>
          {blendValue === '' && <option value="">Mixed</option>}
          {BlendMode.options.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
    </>
  );
}

/* ── one row of the stack ───────────────────────────────────────────────── */

interface RowProps {
  fx: Effect;
  index: number;
  count: number;
  open: boolean;
  onToggle: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  /** Live preview, ended by a pointer-up / key-up / blur. */
  onPreview: (next: Effect) => void;
  /** Live preview that also settles on a short timer (colour inputs). */
  onPreviewSoon: (next: Effect) => void;
  /** One discrete, immediately committed change. */
  onWrite: (next: Effect) => void;
  onSettle: () => void;
}

function EffectRow(p: RowProps) {
  const { fx, index, count, open, onToggle, onMove, onRemove, onSettle } = p;
  const bodyId = `fx-body-${index}`;

  return (
    <div className={`fx-item ${open ? 'open' : ''}`}>
      <div className="fx-head">
        <button className="fx-toggle" onClick={onToggle} aria-expanded={open} aria-controls={bodyId}>
          <Chevron />
          <span className="fx-order">{index + 1}</span>
          <span className="fx-name">{TITLES[fx.kind]}</span>
        </button>
        <button className="fx-icon" aria-label={`Move ${TITLES[fx.kind]} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp />
        </button>
        <button className="fx-icon" aria-label={`Move ${TITLES[fx.kind]} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown />
        </button>
        <button className="fx-icon danger" aria-label={`Remove ${TITLES[fx.kind]}`} onClick={onRemove}>
          <Cross />
        </button>
      </div>
      {open && (
        <div className="fx-body" id={bodyId}>
          <Controls {...p} onSettle={onSettle} />
        </div>
      )}
    </div>
  );
}

function Controls({ fx, onPreview, onPreviewSoon, onWrite, onSettle }: RowProps) {
  const range = (label: string, value: number, min: number, max: number, display: string, next: (v: number) => Effect, step = 1) => (
    <FxRange
      label={label} value={value} min={min} max={max} step={step} display={display}
      onInput={v => onPreview(next(v))} onDone={onSettle}
    />
  );

  switch (fx.kind) {
    case 'shadow':
      return (
        <>
          {range('Offset X', fx.x, -100, 100, `${fx.x} px`, v => ({ ...fx, x: v }))}
          {range('Offset Y', fx.y, -100, 100, `${fx.y} px`, v => ({ ...fx, y: v }))}
          {range('Blur', fx.blur, 0, 100, `${fx.blur} px`, v => ({ ...fx, blur: v }))}
          {range('Spread', fx.spread, -20, 20, `${fx.spread} px`, v => ({ ...fx, spread: v }))}
          {range('Opacity', fx.opacity, 0, 1, pct(fx.opacity), v => ({ ...fx, opacity: v }), 0.01)}
          <FxColor label="Shadow colour" value={fx.color}
                   onInput={c => onPreviewSoon({ ...fx, color: c })} onWrite={c => onWrite({ ...fx, color: c })} onDone={onSettle} />
        </>
      );

    case 'glow':
      return (
        <>
          {range('Blur', fx.blur, 0, 80, `${fx.blur} px`, v => ({ ...fx, blur: v }))}
          {range('Opacity', fx.opacity, 0, 1, pct(fx.opacity), v => ({ ...fx, opacity: v }), 0.01)}
          <FxColor label="Glow colour" value={fx.color}
                   onInput={c => onPreviewSoon({ ...fx, color: c })} onWrite={c => onWrite({ ...fx, color: c })} onDone={onSettle} />
        </>
      );

    case 'blur':
      return range('Radius', fx.radius, 0, 50, `${fx.radius} px`, v => ({ ...fx, radius: v }));

    case 'outline':
      return (
        <>
          {range('Width', fx.width, 0, 40, `${fx.width} px`, v => ({ ...fx, width: v }))}
          <FxColor label="Outline colour" value={fx.color}
                   onInput={c => onPreviewSoon({ ...fx, color: c })} onWrite={c => onWrite({ ...fx, color: c })} onDone={onSettle} />
        </>
      );

    case 'echo':
      return (
        <>
          {range('Offset X', fx.dx, -60, 60, `${fx.dx} px`, v => ({ ...fx, dx: v }))}
          {range('Offset Y', fx.dy, -60, 60, `${fx.dy} px`, v => ({ ...fx, dy: v }))}
          {range('Copies', fx.count, 1, 8, String(fx.count), v => ({ ...fx, count: Math.round(v) }))}
          {range('Opacity', fx.opacity, 0, 1, pct(fx.opacity), v => ({ ...fx, opacity: v }), 0.01)}
          <FxColor label="Echo colour" value={fx.color}
                   onInput={c => onPreviewSoon({ ...fx, color: c })} onWrite={c => onWrite({ ...fx, color: c })} onDone={onSettle} />
        </>
      );

    case 'background':
      return (
        <>
          {range('Padding', fx.padding, 0, 120, `${fx.padding} px`, v => ({ ...fx, padding: v }))}
          {range('Corner radius', fx.radius, 0, 120, `${fx.radius} px`, v => ({ ...fx, radius: v }))}
          {range('Opacity', fx.opacity, 0, 1, pct(fx.opacity), v => ({ ...fx, opacity: v }), 0.01)}
          <FxColor label="Plate colour" value={fx.color}
                   onInput={c => onPreviewSoon({ ...fx, color: c })} onWrite={c => onWrite({ ...fx, color: c })} onDone={onSettle} />
        </>
      );

    case 'curve':
      return (
        <>
          <div className="fx-note">Curve is not rendered yet, so this control is disabled.</div>
          <FxRange label="Amount" value={fx.amount} min={-100} max={100} step={1}
                   display={`${fx.amount}%`} disabled title="Coming soon"
                   onInput={() => {}} onDone={() => {}} />
        </>
      );

    case 'adjust':
      return (
        <>
          {range('Brightness', fx.brightness, -100, 100, `${fx.brightness}%`, v => ({ ...fx, brightness: v }))}
          {range('Contrast', fx.contrast, -100, 100, `${fx.contrast}%`, v => ({ ...fx, contrast: v }))}
          {range('Saturation', fx.saturation, -100, 100, `${fx.saturation}%`, v => ({ ...fx, saturation: v }))}
          {range('Hue', fx.hue, -180, 180, `${fx.hue} deg`, v => ({ ...fx, hue: v }))}
          {range('Sepia', fx.sepia, 0, 100, `${fx.sepia}%`, v => ({ ...fx, sepia: v }))}
          {range('Invert', fx.invert, 0, 100, `${fx.invert}%`, v => ({ ...fx, invert: v }))}
        </>
      );

    case 'duotone':
      return (
        <>
          <FxColor label="Dark tone" value={fx.dark}
                   onInput={c => onPreviewSoon({ ...fx, dark: c })} onWrite={c => onWrite({ ...fx, dark: c })} onDone={onSettle} />
          <FxColor label="Light tone" value={fx.light}
                   onInput={c => onPreviewSoon({ ...fx, light: c })} onWrite={c => onWrite({ ...fx, light: c })} onDone={onSettle} />
        </>
      );

    case 'vignette':
      return (
        <>
          {range('Amount', fx.amount, 0, 100, `${fx.amount}%`, v => ({ ...fx, amount: v }))}
          <FxColor label="Vignette colour" value={fx.color}
                   onInput={c => onPreviewSoon({ ...fx, color: c })} onWrite={c => onWrite({ ...fx, color: c })} onDone={onSettle} />
        </>
      );
  }
}

/* ── field primitives (same class names as Inspector.tsx) ───────────────── */

function FxRange({ label, value, min, max, step, display, disabled, title, onInput, onDone }: {
  label: string; value: number; min: number; max: number; step: number; display: string;
  disabled?: boolean; title?: string;
  onInput: (v: number) => void; onDone: () => void;
}) {
  const armed = useRef(false);
  const end = () => { if (!armed.current) return; armed.current = false; onDone(); };
  return (
    <div className="row">
      <label>{label}<span className="fx-value">{display}</span></label>
      <div className="row-fields">
        <input
          className="slider" type="range" min={min} max={max} step={step} value={value}
          disabled={disabled} title={title} aria-label={`${label} (${display})`}
          onChange={e => {
            const v = parseFloat(e.target.value);
            if (!Number.isFinite(v)) return;
            armed.current = true;
            onInput(v);
          }}
          onPointerDown={() => window.addEventListener('pointerup', end, { once: true })}
          onKeyUp={end}
          onBlur={end}
        />
      </div>
    </div>
  );
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function FxColor({ label, value, onInput, onWrite, onDone }: {
  label: string; value: string;
  /** Streamed while the native picker is open. */
  onInput: (c: string) => void;
  /** One committed change, from the hex box. */
  onWrite: (c: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="row">
      <label>{label}</label>
      <div className="row-fields">
        <div className="colorfield">
          <input
            type="color" aria-label={label}
            value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
            onChange={e => onInput(e.target.value)}
            onBlur={onDone}
          />
          <input
            className="field mono" aria-label={`${label} hex value`} value={draft}
            onChange={e => { setDraft(e.target.value); if (HEX.test(e.target.value)) onWrite(e.target.value); }}
            onBlur={() => { if (!HEX.test(draft)) setDraft(value); }}
          />
        </div>
      </div>
    </div>
  );
}

/* ── icons ──────────────────────────────────────────────────────────────── */

const svg = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const Chevron = () => <svg className="fx-chev" {...svg} aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>;
const ArrowUp = () => <svg {...svg} aria-hidden="true"><path d="M8 12.5V4M4 7.5L8 3.5l4 4" /></svg>;
const ArrowDown = () => <svg {...svg} aria-hidden="true"><path d="M8 3.5V12M4 8.5l4 4 4-4" /></svg>;
const Cross = () => <svg {...svg} aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
