import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import {
  buildExport, deliverExport, fileStem, parsePages, supportsTransparency,
  ExportBudgetExceededError, PageRangeError, type ExportFormat,
} from '../lib/export';

/**
 * The Export dialog.
 *
 * Every control here maps to one field of the shared `ExportOptions`, which is
 * also what `artboard export` parses from its flags — so what you can do in the
 * dialog you can do headlessly, with the same result.
 *
 * The two rules the UI must never break:
 *   - JPEG has no alpha channel. The transparency control disables itself and
 *     says why, rather than lying and exporting a white background anyway.
 *   - More than one output file becomes one zip. The host allows a single save
 *     prompt at a time (`rate_limited`), so a loop of saves would lose files.
 */

interface FormatSpec { id: ExportFormat; label: string; hint: string }

const FORMAT_LIST: FormatSpec[] = [
  { id: 'png', label: 'PNG', hint: 'Lossless raster. Supports transparency.' },
  { id: 'jpg', label: 'JPG', hint: 'Smaller photos. No transparency.' },
  { id: 'svg', label: 'SVG', hint: 'Vector, infinitely sharp, editable anywhere.' },
  { id: 'pdf', label: 'PDF', hint: 'Vector, one page per artboard, print-ready.' },
  { id: 'json', label: '.artboard.json', hint: 'The open format. The whole document, losslessly.' },
];

const SCALES = [1, 2, 3];
type PageMode = 'current' | 'all' | 'range';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch, artboard } = useEditor();
  const doc = state.doc;
  const pageCount = doc.artboards.length;

  const [format, setFormat] = useState<ExportFormat>('png');
  const [scale, setScale] = useState(1);
  const [customScale, setCustomScale] = useState('1.5');
  const [useCustom, setUseCustom] = useState(false);
  const [pageMode, setPageMode] = useState<PageMode>(pageCount > 1 ? 'current' : 'all');
  const [range, setRange] = useState(`1-${pageCount}`);
  const [transparent, setTransparent] = useState(artboard.background.kind === 'none');
  const [quality, setQuality] = useState(0.92);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { panelRef.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);

  const raster = format === 'png' || format === 'jpg';
  const wholeDocument = format === 'json';
  const effectiveScale = useCustom ? Math.min(10, Math.max(0.1, Number(customScale) || 1)) : scale;

  /** Which artboards this export covers, or the reason the range is unusable. */
  const selection = useMemo(() => {
    if (wholeDocument) return { pages: doc.artboards.map((_, i) => i), problem: null as string | null };
    if (pageMode === 'current') return { pages: [state.activeArtboard], problem: null };
    if (pageMode === 'all') return { pages: doc.artboards.map((_, i) => i), problem: null };
    try {
      return { pages: parsePages(range, pageCount), problem: null };
    } catch (e) {
      return { pages: [], problem: e instanceof Error ? e.message : 'Bad page range' };
    }
  }, [wholeDocument, pageMode, range, pageCount, state.activeArtboard, doc.artboards]);

  const stem = fileStem(doc.name);
  const fileCount = wholeDocument || format === 'pdf' ? 1 : selection.pages.length;
  const zipped = fileCount > 1;

  const outputName = zipped ? `${stem}.zip`
    : format === 'json' ? `${stem}.artboard.json`
    : `${stem}.${format}`;

  const dimensions = (() => {
    const first = doc.artboards[selection.pages[0] ?? state.activeArtboard] ?? artboard;
    const w = first.width * effectiveScale, h = first.height * effectiveScale;
    if (raster) return `${Math.round(w)} x ${Math.round(h)} px`;
    if (format === 'pdf') return `${(w * 0.75 / 72).toFixed(2)} x ${(h * 0.75 / 72).toFixed(2)} in at 96 dpi`;
    if (format === 'svg') return `viewBox ${first.width} x ${first.height}, drawn at ${Math.round(w)} x ${Math.round(h)}`;
    return 'the document, unchanged';
  })();

  const transparencyReason =
    format === 'jpg' ? 'JPEG has no alpha channel, so a JPG is always opaque.'
    : format === 'json' ? 'The document keeps whatever background you set.'
    : null;

  const run = async () => {
    if (selection.problem) { setError(selection.problem); return; }
    setBusy(true);
    setError(null);
    try {
      const { files, notes } = await buildExport(
        doc,
        {
          format,
          scale: effectiveScale,
          transparent: supportsTransparency(format) ? transparent : undefined,
          pages: selection.pages,
          quality,
        },
        stem,
      );
      const result = await deliverExport(files, stem);
      const summary = files.length > 1 ? `${files.length} files as ${stem}.zip` : files[0]!.name;
      dispatch({
        type: 'toast',
        toast: result.status === 'declined'
          ? { level: 'info', message: 'Export cancelled' }
          : { level: notes.length ? 'warn' : 'info', message: result.note ?? [`Exported ${summary}`, ...notes].join(' — ') },
      });
      setTimeout(() => dispatch({ type: 'toast', toast: null }), notes.length ? 9000 : 5000);
      onClose();
    } catch (e) {
      setError(
        e instanceof ExportBudgetExceededError || e instanceof PageRangeError ? e.message
        : e instanceof Error ? e.message
        : 'Export failed',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ex-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ex-panel" role="dialog" aria-modal="true" aria-label="Export" tabIndex={-1} ref={panelRef}>
        <header className="ex-head">
          <div>
            <div className="ex-title">Export</div>
            <div className="ex-sub">{doc.name || 'Untitled'} &middot; {pageCount} page{pageCount === 1 ? '' : 's'}</div>
          </div>
          <button className="ex-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </header>

        <div className="ex-body">
          <section className="ex-section">
            <h3>Format</h3>
            <div className="ex-formats">
              {FORMAT_LIST.map(spec => (
                <button
                  key={spec.id}
                  className={`ex-format ${format === spec.id ? 'on' : ''}`}
                  aria-pressed={format === spec.id}
                  onClick={() => setFormat(spec.id)}
                >
                  {spec.label}
                </button>
              ))}
            </div>
            <p className="ex-hint">{FORMAT_LIST.find(s => s.id === format)?.hint}</p>
          </section>

          <section className="ex-section">
            <h3>Pages</h3>
            <div className="ex-segs">
              {([['current', 'This page'], ['all', 'All pages'], ['range', 'Range']] as const).map(([id, label]) => (
                <button
                  key={id}
                  className={`ex-seg ${pageMode === id ? 'on' : ''}`}
                  disabled={wholeDocument || (pageCount === 1 && id !== 'all')}
                  aria-pressed={pageMode === id}
                  onClick={() => setPageMode(id)}
                >{label}</button>
              ))}
            </div>
            {pageMode === 'range' && !wholeDocument && (
              <input
                className="ex-field" value={range} aria-label="Page range"
                placeholder={`1-${pageCount}`}
                onChange={e => setRange(e.target.value)}
              />
            )}
            <p className="ex-hint">
              {wholeDocument
                ? 'An .artboard.json always holds every page.'
                : selection.problem
                ? selection.problem
                : `${selection.pages.length} of ${pageCount} page${pageCount === 1 ? '' : 's'}${zipped ? ' — bundled into one .zip, because the viewer allows one save at a time' : ''}.`}
            </p>
          </section>

          <section className="ex-section">
            <h3>Size</h3>
            <div className="ex-segs">
              {SCALES.map(s => (
                <button
                  key={s}
                  className={`ex-seg ${!useCustom && scale === s ? 'on' : ''}`}
                  disabled={wholeDocument}
                  aria-pressed={!useCustom && scale === s}
                  onClick={() => { setUseCustom(false); setScale(s); }}
                >{s}x</button>
              ))}
              <button
                className={`ex-seg ${useCustom ? 'on' : ''}`}
                disabled={wholeDocument}
                aria-pressed={useCustom}
                onClick={() => setUseCustom(true)}
              >Custom</button>
            </div>
            {useCustom && !wholeDocument && (
              <input
                className="ex-field" type="number" min={0.1} max={10} step={0.1} value={customScale}
                aria-label="Custom scale" onChange={e => setCustomScale(e.target.value)}
              />
            )}
            <p className="ex-hint">{dimensions}</p>
          </section>

          <section className="ex-section">
            <label className={`ex-check ${transparencyReason ? 'off' : ''}`}>
              <input
                type="checkbox"
                checked={supportsTransparency(format) && transparent}
                disabled={!!transparencyReason}
                onChange={e => setTransparent(e.target.checked)}
              />
              <span>Transparent background</span>
            </label>
            <p className="ex-hint">
              {transparencyReason ?? 'Drops the page background so the design sits on whatever is behind it.'}
            </p>
          </section>

          {format === 'jpg' && (
            <section className="ex-section">
              <h3>Quality <span className="ex-num">{Math.round(quality * 100)}</span></h3>
              <input
                className="ex-range" type="range" min={0.3} max={1} step={0.01} value={quality}
                aria-label="JPEG quality" onChange={e => setQuality(Number(e.target.value))}
              />
            </section>
          )}
        </div>

        <footer className="ex-foot">
          <div className="ex-out" title={outputName}>{outputName}</div>
          <div className="ex-actions">
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={run} disabled={busy || !!selection.problem}>
              {busy ? 'Exporting...' : 'Export'}
            </button>
          </div>
        </footer>

        {error && <div className="ex-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
