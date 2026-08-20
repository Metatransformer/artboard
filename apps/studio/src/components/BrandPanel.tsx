import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import {
  BUILTIN_PALETTES, getBrand, saveBrand, vaultId,
  type BrandAsset, type BrandKit, type Palette,
} from '../lib/vault';

/**
 * The brand kit: palettes, fonts and logos that outlive a single document.
 *
 * Everything here is *the user's*, so it lives in the vault rather than the
 * document, and every mutation writes through immediately - there is no "save
 * brand kit" button to forget. The vault may quietly fall back to a memory
 * backend; when it does we say so instead of pretending the write landed.
 */

const FONT_CHOICES: string[] = ['Inter', 'Playfair Display', 'DM Serif Display', 'Space Grotesk', 'JetBrains Mono'];
const NEW_PALETTE_COLORS: string[] = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0f1117'];
const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const MAX_LOGO_PIXELS = 40_000_000;
const MAX_EXTRACTED = 8;
const EMPTY_KIT: BrandKit = { palettes: [], fonts: [], logos: [] };

/* ── colour helpers ─────────────────────────────────────────────────────── */

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Accepts `#rgb` / `#rrggbb` (hash optional) and returns `#rrggbb`; null if it is not a colour. */
function normalizeHex(raw: string): string | null {
  const m = HEX_RE.exec(raw.trim());
  const body = m?.[1];
  if (!body) return null;
  const full = body.length === 3 ? [...body].map(c => c + c).join('') : body;
  return `#${full.toLowerCase()}`;
}

/** The document allows `#rrggbbaa`; a palette swatch is opaque, so drop the alpha. */
function toSwatchHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed.slice(0, 7).toLowerCase();
  return normalizeHex(trimmed);
}

/**
 * Every colour actually used on the page, in paint order, deduped
 * case-insensitively. Zero-width strokes are skipped - otherwise the default
 * `#000000` on every shape would swamp the result.
 */
function extractColors(ab: unknown): string[] {
  const board = ab as any;
  const seen = new Set<string>();
  const out: string[] = [];
  const take = (raw: unknown) => {
    if (out.length >= MAX_EXTRACTED) return;
    const hex = toSwatchHex(raw);
    if (!hex || seen.has(hex)) return;
    seen.add(hex);
    out.push(hex);
  };
  const takeFill = (fill: any) => {
    if (!fill || typeof fill !== 'object') return;
    if (fill.kind === 'solid') take(fill.color);
    else if (fill.kind === 'gradient') for (const stop of fill.stops ?? []) take(stop?.color);
  };
  const visit = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (!n) continue;
      takeFill(n.fill);
      if (n.kind === 'text') take(n.color);
      if (n.stroke && typeof n.stroke.width === 'number' && n.stroke.width > 0) take(n.stroke.color);
      if (n.kind === 'group') visit(n.children ?? []);
    }
  };
  takeFill(board?.background);
  visit(board?.nodes ?? []);
  return out;
}

/** Text is coloured by `color` and a line by its stroke; everything else by `fill`. */
function colorPatch(node: any, color: string): Record<string, unknown> {
  if (node?.kind === 'text') return { color };
  if (node?.kind === 'line') return { stroke: { ...(node.stroke ?? { width: 2, dash: [] }), color } };
  return { fill: { kind: 'solid', color } };
}

/* ── file helpers (logo upload) ─────────────────────────────────────────── */

function readDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error(`Could not read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

function probe(dataUrl: string, name: string): Promise<{ width: number; height: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    // An SVG with no intrinsic size reports 0; give it a sane box rather than 1px.
    img.onload = () => res({ width: img.naturalWidth || 300, height: img.naturalHeight || 300 });
    img.onerror = () => rej(new Error(`${name} is not a readable image.`));
    img.src = dataUrl;
  });
}

/* ── panel ──────────────────────────────────────────────────────────────── */

export function BrandPanel() {
  const { state, dispatch, run, artboard, selected } = useEditor();

  const [kit, setKit] = useState<BrandKit>(EMPTY_KIT);
  const kitRef = useRef<BrandKit>(EMPTY_KIT);
  const [warning, setWarning] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [fontPick, setFontPick] = useState('');
  const [confirmLogo, setConfirmLogo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toastRef = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    getBrand()
      .then(k => { if (!live) return; kitRef.current = k; setKit(k); })
      .catch(() => { if (live) setWarning('Could not read your saved brand kit, so this one starts empty.'); });
    return () => { live = false; };
  }, []);

  useEffect(() => () => { if (toastRef.current !== null) window.clearTimeout(toastRef.current); }, []);

  const say = useCallback((level: 'info' | 'warn' | 'error', message: string) => {
    dispatch({ type: 'toast', toast: { level, message } });
    if (toastRef.current !== null) window.clearTimeout(toastRef.current);
    toastRef.current = window.setTimeout(() => dispatch({ type: 'toast', toast: null }), 5000);
  }, [dispatch]);

  /** Single write path: update in memory first, then let the vault catch up. */
  const mutate = useCallback((fn: (k: BrandKit) => BrandKit) => {
    const next = fn(kitRef.current);
    kitRef.current = next;
    setKit(next);
    saveBrand(next).catch(() =>
      setWarning('Could not save your brand kit in this browser. Changes will be lost when you close the tab.'));
  }, []);

  /* ── colours ─────────────────────────────────────────────────────────── */

  const applyColor = useCallback((color: string) => {
    if (selected.length === 0) {
      run({ type: 'setArtboard', artboardId: artboard.id, patch: { background: { kind: 'solid', color } } });
      return;
    }
    run({
      type: 'batch',
      label: 'Apply brand colour',
      commands: selected.map(n => ({ type: 'updateNode' as const, nodeId: n.id, patch: colorPatch(n, color) })),
    });
  }, [selected, run, artboard.id]);

  const extracted = useMemo(() => extractColors(artboard), [artboard]);

  const addPalette = (name: string, colors: string[]) => {
    const palette: Palette = { id: vaultId('pal'), name: name.trim() || 'Untitled palette', colors };
    mutate(k => ({ ...k, palettes: [...k.palettes, palette] }));
  };

  const setColors = (id: string, colors: string[]) =>
    mutate(k => ({ ...k, palettes: k.palettes.map(p => (p.id === id ? { ...p, colors } : p)) }));

  const renamePalette = (id: string, name: string) =>
    mutate(k => ({ ...k, palettes: k.palettes.map(p => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) }));

  const deletePalette = (id: string) =>
    mutate(k => ({ ...k, palettes: k.palettes.filter(p => p.id !== id) }));

  /* ── fonts ───────────────────────────────────────────────────────────── */

  const textIds = useMemo(() => selected.filter(n => (n as any).kind === 'text').map(n => n.id as string), [selected]);
  const available = FONT_CHOICES.filter(f => !kit.fonts.includes(f));
  const pick = available.includes(fontPick) ? fontPick : (available[0] ?? '');

  const applyFont = (font: string) => {
    if (textIds.length === 0) { say('warn', 'Select a text item first - brand fonts only apply to text.'); return; }
    run({
      type: 'batch',
      label: 'Apply brand font',
      commands: textIds.map(id => ({ type: 'updateNode' as const, nodeId: id, patch: { fontFamily: font } })),
    });
  };

  /* ── logos ───────────────────────────────────────────────────────────── */

  const ingest = async (files: FileList | File[]) => {
    const accepted: BrandAsset[] = [];
    for (const file of Array.from(files)) {
      try {
        if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
        if (file.size > MAX_LOGO_BYTES) throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is 8 MB.`);
        const data = await readDataUrl(file);
        const { width, height } = await probe(data, file.name);
        if (width * height > MAX_LOGO_PIXELS) {
          throw new Error(`${file.name} is ${(width * height / 1e6).toFixed(0)} MP; the limit is 40 MP.`);
        }
        accepted.push({ id: vaultId('logo'), name: file.name, mime: file.type, width, height, data });
      } catch (e) {
        say('error', e instanceof Error ? e.message : `Could not read ${file.name}.`);
      }
    }
    if (accepted.length) mutate(k => ({ ...k, logos: [...k.logos, ...accepted] }));
  };

  const placeLogo = (logo: BrandAsset) => {
    // The same logo dropped twice should not embed the same bytes twice.
    const existing = Object.values(state.doc.assets ?? {}).find(a => a.data === logo.data);
    const asset = existing ?? { id: vaultId('asset'), mime: logo.mime, width: logo.width, height: logo.height, data: logo.data };
    const w = Math.max(1, Math.round(artboard.width * 0.3));
    const h = Math.max(1, Math.round(w * (logo.height / (logo.width || 1))));
    const node = {
      id: vaultId('n'), kind: 'image' as const, name: 'Logo',
      x: Math.round((artboard.width - w) / 2), y: Math.round((artboard.height - h) / 2),
      width: w, height: h, rotation: 0, opacity: 1, visible: true, locked: false, shadow: null,
      effects: [], blend: 'normal' as const,
      assetId: asset.id, fit: 'contain' as const, radius: 0,
    };
    if (!existing) run({ type: 'addAsset', asset });
    run({ type: 'addNode', artboardId: artboard.id, node });
    dispatch({ type: 'select', ids: [node.id] });
  };

  /* ── render ──────────────────────────────────────────────────────────── */

  const target = selected.length
    ? `A colour fills ${selected.length} selected item${selected.length > 1 ? 's' : ''}.`
    : 'Nothing is selected, so a colour sets the page background.';

  return (
    <div className="bk">
      {warning && <p className="bk-warn" role="status">{warning}</p>}
      <p className="bk-target">{target}</p>

      <h4>Your palettes</h4>
      {kit.palettes.length === 0 && !creating && (
        <p className="bk-empty">No palettes yet. Make one, or duplicate a built-in below.</p>
      )}
      <div className="stack">
        {kit.palettes.map(p => (
          <PaletteCard
            key={p.id}
            palette={p}
            editable
            onApply={applyColor}
            onDuplicate={() => addPalette(`${p.name} copy`, [...p.colors])}
            onRename={name => renamePalette(p.id, name)}
            onDelete={() => deletePalette(p.id)}
            onColors={colors => setColors(p.id, colors)}
          />
        ))}
        {creating ? (
          <form
            className="bk-new"
            onSubmit={e => { e.preventDefault(); addPalette(newName, [...NEW_PALETTE_COLORS]); setNewName(''); setCreating(false); }}
          >
            <input
              className="field" autoFocus value={newName} aria-label="New palette name"
              placeholder="Palette name" onChange={e => setNewName(e.target.value)}
            />
            <button className="bk-mini go" type="submit" title="Create this palette">Create</button>
            <button className="bk-mini" type="button" title="Cancel the new palette"
                    onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
          </form>
        ) : (
          <button className="btn full" title="Create a new palette" onClick={() => setCreating(true)}>New palette</button>
        )}
      </div>

      <h4>From this design</h4>
      {extracted.length === 0 ? (
        <p className="bk-empty">This page has no colours to collect yet.</p>
      ) : (
        <div className="bk-pal">
          <div className="bk-row">
            {extracted.map((c, i) => (
              <button
                key={`${c}-${i}`} className="bk-sw" style={{ background: c }}
                title={`Apply ${c}`} aria-label={`Apply ${c}`} onClick={() => applyColor(c)}
              />
            ))}
          </div>
          <button
            className="btn full" title="Save these colours as a palette"
            onClick={() => addPalette('From this design', [...extracted])}
          >
            Save as palette
          </button>
        </div>
      )}

      <h4>Built-in palettes</h4>
      <div className="stack">
        {BUILTIN_PALETTES.map(p => (
          <PaletteCard
            key={p.id}
            palette={p}
            editable={false}
            onApply={applyColor}
            onDuplicate={() => addPalette(`${p.name} copy`, [...p.colors])}
          />
        ))}
      </div>

      <h4>Brand fonts</h4>
      <p className="bk-target">
        {textIds.length
          ? `A font applies to ${textIds.length} selected text item${textIds.length > 1 ? 's' : ''}.`
          : 'Select a text item to apply a brand font.'}
      </p>
      <div className="stack">
        {kit.fonts.map(f => (
          <div key={f} className="bk-font">
            <button
              className="bk-font-name" style={{ fontFamily: `'${f}', sans-serif` }}
              title={`Apply ${f} to selected text`} onClick={() => applyFont(f)}
            >
              {f}
            </button>
            <button
              className="bk-mini danger" title={`Remove ${f} from your brand fonts`}
              onClick={() => mutate(k => ({ ...k, fonts: k.fonts.filter(x => x !== f) }))}
            >
              Remove
            </button>
          </div>
        ))}
        {available.length === 0 ? (
          <p className="bk-empty">All five bundled faces are in your brand fonts.</p>
        ) : (
          <div className="bk-addfont">
            <select className="field" aria-label="Font to add" value={pick} onChange={e => setFontPick(e.target.value)}>
              {available.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <button className="bk-mini go" title="Add this font to your brand fonts"
                    onClick={() => { if (pick) mutate(k => ({ ...k, fonts: [...k.fonts, pick] })); }}>
              Add
            </button>
          </div>
        )}
      </div>

      <h4>Brand logos</h4>
      <div className="stack">
        <button className="btn full" title="Upload a logo image" onClick={() => fileRef.current?.click()}>Upload a logo</button>
        <input
          ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="Logo image files"
          onChange={e => { if (e.target.files?.length) void ingest(e.target.files); e.target.value = ''; }}
        />
      </div>
      {kit.logos.length === 0 ? (
        <p className="bk-empty">No logos yet. PNG, JPG, SVG or WebP, up to 8 MB.</p>
      ) : (
        <div className="bk-logos">
          {kit.logos.map(l => (
            <div key={l.id} className="bk-logo">
              <button className="bk-logo-btn" title={`Add ${l.name} to this page`} onClick={() => placeLogo(l)}>
                <img src={l.data} alt={l.name} />
              </button>
              {confirmLogo === l.id ? (
                <div className="bk-logo-confirm">
                  <button
                    className="bk-mini danger" title={`Delete ${l.name}`}
                    onClick={() => { mutate(k => ({ ...k, logos: k.logos.filter(x => x.id !== l.id) })); setConfirmLogo(null); }}
                  >
                    Really delete?
                  </button>
                  <button className="bk-mini" title={`Keep ${l.name}`} onClick={() => setConfirmLogo(null)}>Keep</button>
                </div>
              ) : (
                <button
                  className="bk-logo-del" title={`Delete ${l.name}`} aria-label={`Delete ${l.name}`}
                  onClick={() => setConfirmLogo(l.id)}
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── one palette ────────────────────────────────────────────────────────── */

interface PaletteCardProps {
  palette: Palette;
  /** Built-ins are read-only: they can be copied, never renamed, edited or deleted. */
  editable: boolean;
  onApply: (color: string) => void;
  onDuplicate: () => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  onColors?: (colors: string[]) => void;
}

function PaletteCard({ palette, editable, onApply, onDuplicate, onRename, onDelete, onColors }: PaletteCardProps) {
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [hex, setHex] = useState('');
  const [hexError, setHexError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(palette.name);
  const [confirming, setConfirming] = useState(false);

  const colors = palette.colors;
  const current = active === null ? null : colors[active] ?? null;

  const open = (i: number) => {
    setActive(i);
    setHex(colors[i] ?? '');
    setHexError(null);
  };

  const replace = (i: number, color: string) => onColors?.(colors.map((c, n) => (n === i ? color : c)));

  const onHexInput = (raw: string) => {
    setHex(raw);
    if (active === null) return;
    const normalized = normalizeHex(raw);
    if (!normalized) { setHexError('Use a colour like #4f46e5 or #f0c.'); return; }
    setHexError(null);
    replace(active, normalized);
  };

  const move = (dir: -1 | 1) => {
    if (active === null) return;
    const to = active + dir;
    const from = colors[active];
    const swap = colors[to];
    if (from === undefined || swap === undefined) return;
    const next = [...colors];
    next[active] = swap;
    next[to] = from;
    onColors?.(next);
    setActive(to);
  };

  const remove = () => {
    if (active === null || colors.length <= 1) return;
    onColors?.(colors.filter((_, i) => i !== active));
    setActive(null);
  };

  return (
    <div className={`bk-pal ${palette.builtIn ? 'builtin' : ''}`}>
      {renaming ? (
        <form
          className="bk-pal-head"
          onSubmit={e => { e.preventDefault(); onRename?.(draft); setRenaming(false); }}
        >
          <input
            className="field" autoFocus value={draft} aria-label="Palette name"
            onChange={e => setDraft(e.target.value)}
          />
          <button className="bk-mini go" type="submit" title="Save this name">Save</button>
          <button className="bk-mini" type="button" title="Cancel the rename"
                  onClick={() => { setDraft(palette.name); setRenaming(false); }}>Cancel</button>
        </form>
      ) : (
        <div className="bk-pal-head">
          <span className="bk-pal-name" title={palette.name}>{palette.name}</span>
          {palette.builtIn && <span className="bk-tag">Built in</span>}
          <span className="bk-pal-acts">
            {editable && (
              <button
                className={`bk-mini ${editing ? 'on' : ''}`}
                title={editing ? 'Stop editing this palette' : 'Edit the swatches in this palette'}
                onClick={() => { setEditing(!editing); setActive(null); setConfirming(false); }}
              >
                {editing ? 'Done' : 'Edit'}
              </button>
            )}
            <button className="bk-mini" title={`Duplicate ${palette.name}`} onClick={onDuplicate}>Duplicate</button>
            {editable && (
              <button className="bk-mini" title={`Rename ${palette.name}`}
                      onClick={() => { setDraft(palette.name); setRenaming(true); }}>Rename</button>
            )}
            {editable && (confirming ? (
              <>
                <button className="bk-mini danger" title={`Delete ${palette.name}`}
                        onClick={() => { setConfirming(false); onDelete?.(); }}>Really delete?</button>
                <button className="bk-mini" title={`Keep ${palette.name}`} onClick={() => setConfirming(false)}>Keep</button>
              </>
            ) : (
              <button className="bk-mini" title={`Delete ${palette.name}`} onClick={() => setConfirming(true)}>Delete</button>
            ))}
          </span>
        </div>
      )}

      <div className="bk-row">
        {colors.map((c, i) => (
          <button
            key={`${c}-${i}`}
            className={`bk-sw ${editing && active === i ? 'on' : ''}`}
            style={{ background: c }}
            title={editing ? `Edit swatch ${i + 1}, ${c}` : `Apply ${c}`}
            aria-label={editing ? `Edit swatch ${i + 1}, ${c}` : `Apply ${c}`}
            onClick={() => (editing ? open(i) : onApply(c))}
          />
        ))}
        {editing && (
          <button className="bk-add" title="Add a swatch" aria-label="Add a swatch"
                  onClick={() => onColors?.([...colors, colors[colors.length - 1] ?? '#ffffff'])}>+</button>
        )}
      </div>

      {editing && active !== null && current !== null && (
        <div className="bk-edit">
          <div className="bk-edit-row">
            <input
              type="color" aria-label={`Swatch ${active + 1} colour`}
              value={normalizeHex(current) ?? '#000000'}
              onChange={e => { setHex(e.target.value); setHexError(null); replace(active, e.target.value); }}
            />
            <input
              className="field mono" value={hex} spellCheck={false} placeholder="#4f46e5"
              aria-label={`Swatch ${active + 1} hex value`} onChange={e => onHexInput(e.target.value)}
            />
          </div>
          <div className="bk-edit-row">
            <button className="bk-mini" title="Move this swatch left" aria-label="Move this swatch left"
                    disabled={active === 0} onClick={() => move(-1)}>&larr;</button>
            <button className="bk-mini" title="Move this swatch right" aria-label="Move this swatch right"
                    disabled={active === colors.length - 1} onClick={() => move(1)}>&rarr;</button>
            <button className="bk-mini danger" title="Remove this swatch"
                    disabled={colors.length <= 1} onClick={remove}>Remove</button>
            <button className="bk-mini" title="Close the swatch editor" onClick={() => setActive(null)}>Close</button>
          </div>
          {hexError && <p className="bk-err" role="alert">{hexError}</p>}
        </div>
      )}
    </div>
  );
}
