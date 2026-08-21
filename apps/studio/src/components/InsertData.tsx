import React, { useState } from 'react';
import { uid, type Command } from '@artboard/commands';
import { buildNode } from '@artboard/schema';
import { buildChart, SAMPLE_DATA, type ChartKind, type ChartSpec } from '@artboard/charts';
import { qrNode, barcodeNode, type EcLevel, type Symbology } from '@artboard/codes';
import { useEditor } from '../state/store';

/**
 * Insert surfaces for the two generator packages: `@artboard/charts` and
 * `@artboard/codes`.
 *
 * PHASE 1 IS INSERT-ONLY, and that is a real limitation rather than an
 * oversight. `buildChart`, `qrNode` and `barcodeNode` each return a plain
 * `Node[]` with no link back to the spec that produced it, and there is nowhere
 * on `NodeBase` to stash one — so a chart cannot be re-opened and re-edited
 * after it lands. Changing that is a schema change with golden and
 * forward-compat consequences. What you get instead is real nodes: move,
 * resize, restyle, group, export, exactly like anything else on the canvas.
 * The panels say so out loud; see the `.hint` under each.
 */

/* ── insertion ──────────────────────────────────────────────────────────── */

/**
 * Adds generated nodes as ONE group, in ONE undo step.
 *
 * Every node is re-minted through `buildNode` with a fresh id. Two reasons, and
 * both have teeth: the generators number their nodes from zero (`qr-0`,
 * `chart-bar-bar-0`), so inserting a second QR would collide with the first and
 * `addNode`'s duplicate-id guard would reject the whole batch; and `buildNode`
 * fills whatever the schema has grown since the generator package last looked,
 * which is what makes the inserted nodes survive save -> reload unchanged.
 *
 * The grouping goes through the real `group` command rather than a hand-built
 * group node, so the bounds are computed by the same code path that `Ctrl G`
 * uses and undo/redo inverts it properly.
 */
function useInsertGroup() {
  const { run, dispatch, artboard } = useEditor();

  return (label: string, groupName: string, generated: unknown[]) => {
    const stamp = uid('n');
    let seq = 0;
    const remint = (list: unknown[]): any[] => list.map((raw) => {
      const n = raw as Record<string, unknown>;
      return buildNode({
        ...n,
        id: `${stamp}-${seq++}`,
        ...(n.kind === 'group' ? { children: remint((n.children ?? []) as unknown[]) } : {}),
      });
    });

    const nodes = remint(generated);
    if (nodes.length === 0) return;
    const groupId = `${stamp}-g`;
    const commands: Command[] = nodes.map((node) => ({ type: 'addNode', artboardId: artboard.id, node }));
    commands.push({ type: 'group', artboardId: artboard.id, nodeIds: nodes.map((n) => n.id), groupId });
    // `makeGroup` names every group "Group"; a canvas of them is unreadable in
    // the layers panel, so the batch renames this one before it closes.
    commands.push({ type: 'updateNode', nodeId: groupId, patch: { name: groupName } });

    run({ type: 'batch', label, commands });
    dispatch({ type: 'select', ids: [groupId] });
  };
}

/**
 * Generators throw on input they cannot encode -- `CodeError` when a payload
 * will not fit a version-10 symbol, `ChartDataError` on ragged or non-numeric
 * data -- and both carry a message written for a person. Show it. The two
 * failure modes that are NOT acceptable are an unhandled throw in the console
 * and a silent no-op, which is the same bug wearing a different hat.
 */
function useToast() {
  const { dispatch } = useEditor();
  return (message: string, level: 'info' | 'warn' | 'error' = 'error') => {
    dispatch({ type: 'toast', toast: { level, message } });
    setTimeout(() => dispatch({ type: 'toast', toast: null }), 6000);
  };
}

/* ── chart ──────────────────────────────────────────────────────────────── */

const CHART_KINDS: Array<{ id: ChartKind; label: string }> = [
  { id: 'bar', label: 'Bar' },
  { id: 'column', label: 'Column' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'pie', label: 'Pie' },
  { id: 'donut', label: 'Donut' },
  { id: 'stacked-bar', label: 'Stacked' },
];

/** `SAMPLE_DATA` is the package's own demo set, so the box is never empty. */
function sampleText(kind: ChartKind): string {
  const spec = SAMPLE_DATA[kind];
  return spec.labels
    .map((label, i) => [label, ...spec.series.map((s) => s.values[i] ?? '')].join(','))
    .join('\n');
}

/**
 * `label,value` per line, extra columns becoming extra series. Deliberately
 * NOT a spreadsheet: a textarea is the cheapest thing that can express two
 * series, and pasting a column out of one is the actual use case.
 *
 * An empty cell becomes NaN rather than 0, so a stray trailing comma is
 * reported by `buildChart` instead of quietly inventing a data point.
 */
function parseRows(text: string, seriesNames: string[]): Pick<ChartSpec, 'labels' | 'series'> {
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const cells = rows.map((r) => r.split(',').map((c) => c.trim()));
  const labels = cells.map((c) => c[0] ?? '');
  const width = Math.max(1, ...cells.map((c) => c.length - 1));
  const series = Array.from({ length: width }, (_, i) => ({
    name: seriesNames[i]?.trim() || `Series ${i + 1}`,
    values: cells.map((c) => (c[i + 1] === undefined || c[i + 1] === '' ? NaN : Number(c[i + 1]))),
  }));
  return { labels, series };
}

export function ChartInsert() {
  const { artboard } = useEditor();
  const insert = useInsertGroup();
  const toast = useToast();
  const [kind, setKind] = useState<ChartKind>('column');
  const [data, setData] = useState(() => sampleText('column'));
  const [title, setTitle] = useState('');
  const [names, setNames] = useState('');

  const pick = (k: ChartKind) => {
    // Swapping kind reloads the sample only while the box still holds a sample,
    // so a chart type change never eats data somebody typed.
    setData((d) => (CHART_KINDS.some((c) => d === sampleText(c.id)) ? sampleText(k) : d));
    setKind(k);
  };

  const go = () => {
    const width = Math.round(artboard.width * 0.72);
    const height = Math.round(width * 0.66);
    try {
      const { labels, series } = parseRows(data, names.split(','));
      const nodes = buildChart({
        kind, labels, series, width, height,
        x: Math.round((artboard.width - width) / 2),
        y: Math.round((artboard.height - height) / 2),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      insert('Insert chart', title.trim() || `${kind} chart`, nodes);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That data could not be charted.');
    }
  };

  return (
    <div className="stack">
      <div className="chips">
        {CHART_KINDS.map((c) => (
          <button key={c.id} className={`chip ${kind === c.id ? 'on' : ''}`} onClick={() => pick(c.id)}>{c.label}</button>
        ))}
      </div>
      <textarea
        className="field mono ta" rows={6} spellCheck={false}
        aria-label="Chart data, one label and value per line"
        value={data} onChange={(e) => setData(e.target.value)}
      />
      <input className="field" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="field" placeholder="Series names, comma separated (optional)" value={names} onChange={(e) => setNames(e.target.value)} />
      <button className="btn full btn-primary" onClick={go}>Insert chart</button>
      <p className="hint tight">
        One <code>label,value</code> per line. Extra columns become extra series.
        Inserted as artwork: move and restyle it freely, but the data is not editable afterwards -- to change it, insert a new chart.
      </p>
    </div>
  );
}

/* ── QR ─────────────────────────────────────────────────────────────────── */

const EC_LEVELS: Array<{ id: EcLevel; label: string; hint: string }> = [
  { id: 'L', label: 'L', hint: 'Low - most data, least damage tolerance' },
  { id: 'M', label: 'M', hint: 'Medium - the usual choice' },
  { id: 'Q', label: 'Q', hint: 'Quartile' },
  { id: 'H', label: 'H', hint: 'High - survives a logo over the middle' },
];

export function QrInsert() {
  const { artboard } = useEditor();
  const insert = useInsertGroup();
  const toast = useToast();
  const [text, setText] = useState('https://example.com');
  const [ec, setEc] = useState<EcLevel>('M');
  const [quiet, setQuiet] = useState(true);

  const go = () => {
    if (text.trim() === '') { toast('A QR code needs something to encode.', 'warn'); return; }
    const size = Math.round(artboard.width * 0.34);
    try {
      const nodes = qrNode({
        text, ec, size,
        x: Math.round((artboard.width - size) / 2),
        y: Math.round((artboard.height - size) / 2),
        ...(quiet ? { light: '#ffffff' } : {}),
      });
      insert('Insert QR code', 'QR code', nodes);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That text could not be encoded.');
    }
  };

  return (
    <div className="stack">
      <input className="field" placeholder="Text or URL" aria-label="QR payload"
             value={text} onChange={(e) => setText(e.target.value)} />
      <div className="chips">
        {EC_LEVELS.map((l) => (
          <button key={l.id} className={`chip ${ec === l.id ? 'on' : ''}`} title={l.hint} onClick={() => setEc(l.id)}>{l.label}</button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
        White backing plate
      </label>
      <button className="btn full btn-primary" onClick={go}>Insert QR code</button>
      <p className="hint tight">
        Error correction trades capacity for damage tolerance. A code placed on a dark background needs the backing plate to scan.
        Inserted as artwork -- the payload is not editable afterwards.
      </p>
    </div>
  );
}

/* ── barcode ────────────────────────────────────────────────────────────── */

const SYMBOLOGIES: Array<{ id: Symbology; label: string; placeholder: string; hint: string }> = [
  { id: 'code128', label: 'Code 128', placeholder: 'ABC-1234', hint: 'Any printable ASCII' },
  { id: 'ean13', label: 'EAN-13', placeholder: '590123412345', hint: '12 digits (the 13th is computed) or 13' },
];

export function BarcodeInsert() {
  const { artboard } = useEditor();
  const insert = useInsertGroup();
  const toast = useToast();
  const [symbology, setSymbology] = useState<Symbology>('code128');
  const [text, setText] = useState('ABC-1234');
  const [showText, setShowText] = useState(true);
  const sym = SYMBOLOGIES.find((s) => s.id === symbology)!;

  const go = () => {
    if (text.trim() === '') { toast('A barcode needs something to encode.', 'warn'); return; }
    const width = Math.round(artboard.width * 0.6);
    const height = Math.round(width * 0.4);
    try {
      const nodes = barcodeNode({
        text: text.trim(), symbology, width, height, showText,
        x: Math.round((artboard.width - width) / 2),
        y: Math.round((artboard.height - height) / 2),
      });
      insert('Insert barcode', `${sym.label} barcode`, nodes);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That text could not be encoded.');
    }
  };

  return (
    <div className="stack">
      <div className="chips">
        {SYMBOLOGIES.map((s) => (
          <button key={s.id} className={`chip ${symbology === s.id ? 'on' : ''}`}
                  onClick={() => { setSymbology(s.id); setText(s.placeholder); }}>{s.label}</button>
        ))}
      </div>
      <input className="field mono" placeholder={sym.placeholder} aria-label="Barcode payload"
             value={text} onChange={(e) => setText(e.target.value)} />
      <label className="check">
        <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} />
        Human-readable line
      </label>
      <button className="btn full btn-primary" onClick={go}>Insert barcode</button>
      <p className="hint tight">
        {sym.hint}. Quiet zones are included inside the width, so it stays scannable placed flush against other content.
        Inserted as artwork -- the payload is not editable afterwards.
      </p>
    </div>
  );
}
