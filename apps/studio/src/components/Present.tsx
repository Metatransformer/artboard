import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderArtboard } from '@artboard/render-svg';
import { Scene } from '../lib/scene';
import { useEditor } from '../state/store';

/**
 * Presentation mode: the document with none of the editor in it.
 *
 * The page is scaled to FIT the viewport (letterboxed, never cropped) on a
 * near-black ground, and the only chrome is a counter and a pair of arrows
 * that get out of the way after a few seconds of stillness.
 *
 * Fullscreen is an enhancement, not a requirement: browsers refuse the request
 * unless it comes from a user gesture, so a refusal just leaves us in the
 * in-page overlay, which looks and behaves the same.
 */

const IDLE_MS = 2500;

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

const fsDoc = (): FsDocument => document as FsDocument;
const fullscreenElement = (): Element | null => document.fullscreenElement ?? fsDoc().webkitFullscreenElement ?? null;

/** Ask for fullscreen and accept "no" quietly - there is nothing the user could do about it. */
function enterFullscreen(el: FsElement): void {
  const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  if (!req) return;
  try { void Promise.resolve(req()).catch(() => {}); } catch { /* refused synchronously */ }
}

function leaveFullscreen(): void {
  if (!fullscreenElement()) return;
  const d = fsDoc();
  const exit = d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d);
  if (!exit) return;
  try { void Promise.resolve(exit()).catch(() => {}); } catch { /* already gone */ }
}

/** Reduced motion, tracked only while the overlay is up so nothing is bound when it is not. */
function useReducedMotion(active: boolean): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!active || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [active]);
  return reduced;
}

export function Present({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useEditor();
  const pages = state.doc.artboards;
  const count = pages.length;
  const last = Math.max(0, count - 1);

  const [index, setIndex] = useState(0);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 0 : window.innerWidth,
    h: typeof window === 'undefined' ? 0 : window.innerHeight,
  }));
  const [controlsUp, setControlsUp] = useState(true);

  const overlayRef = useRef<HTMLDivElement>(null);
  const idleRef = useRef<number | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  /* Latest-value refs: the listeners below are bound once per open, not per render. */
  const closeRef = useRef(onClose);
  const activeRef = useRef(state.activeArtboard);
  useEffect(() => { closeRef.current = onClose; activeRef.current = state.activeArtboard; });

  const reduced = useReducedMotion(open);

  const at = Math.min(Math.max(index, 0), last);
  const page = count > 0 ? pages[at] : undefined;

  /* Wrap-around is off: both ends are hard stops. */
  const step = useCallback((delta: number) => {
    setIndex(i => Math.min(last, Math.max(0, Math.min(Math.max(i, 0), last) + delta)));
  }, [last]);

  /* Start on the page the editor was showing; hand focus back where it came from. */
  useEffect(() => {
    if (!open) return;
    setIndex(activeRef.current);
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus();
    return () => {
      const back = restoreRef.current;
      restoreRef.current = null;
      back?.focus();
    };
  }, [open]);

  /* Re-measure so the fit stays correct when the window (or the fullscreen state) changes. */
  useEffect(() => {
    if (!open) return;
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  /* Keys are taken in the CAPTURE phase and stopped there: the editor's own window
     handlers are still bound underneath, and arrows must not nudge a shape mid-talk. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Spacebar':
          e.preventDefault(); step(1); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
          e.preventDefault(); step(-1); break;
        case 'Home': e.preventDefault(); setIndex(0); break;
        case 'End': e.preventDefault(); setIndex(last); break;
        case 'Escape': e.preventDefault(); closeRef.current(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, last, step]);

  /* Controls fade after a spell of stillness. With reduced motion they simply stay. */
  useEffect(() => {
    if (!open) return;
    if (reduced) { setControlsUp(true); return; }
    const clear = () => { if (idleRef.current !== null) { window.clearTimeout(idleRef.current); idleRef.current = null; } };
    const wake = () => {
      setControlsUp(true);
      clear();
      idleRef.current = window.setTimeout(() => setControlsUp(false), IDLE_MS);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('pointerdown', wake);
    return () => {
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('pointerdown', wake);
      clear();
    };
  }, [open, reduced]);

  /* Fullscreen, when the browser allows it. Leaving fullscreen by any other route
     (the browser's own Escape, F11) ends the presentation too. */
  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    let entered = false;
    const onChange = () => {
      if (el && fullscreenElement() === el) { entered = true; return; }
      if (entered) { entered = false; closeRef.current(); }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    if (el) enterFullscreen(el);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      leaveFullscreen();
    };
  }, [open]);

  const rendered = useMemo(
    () => (open && page ? renderArtboard(state.doc, page) : null),
    [open, page, state.doc],
  );

  if (!open || !page || !rendered) return null;

  const scale = Math.max(0, Math.min(viewport.w / page.width, viewport.h / page.height));

  return (
    <div
      ref={overlayRef}
      className={`pm-overlay${controlsUp ? '' : ' pm-idle'}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting ${state.doc.name || 'design'}`}
      tabIndex={-1}
      onClick={() => step(1)}
    >
      <div
        className="pm-page"
        style={{ width: Math.max(1, page.width * scale), height: Math.max(1, page.height * scale) }}
      >
        <Scene node={rendered.scene} />
      </div>

      <div className={`pm-bar${controlsUp ? ' pm-on' : ''}`} onClick={e => e.stopPropagation()}>
        <button className="pm-nav" onClick={() => step(-1)} disabled={at === 0} aria-label="Previous page">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="pm-count" aria-live="polite">{at + 1} / {count}</span>
        <button className="pm-nav" onClick={() => step(1)} disabled={at === last} aria-label="Next page">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="pm-sep" />
        <button className="pm-exit" onClick={() => closeRef.current()}>Exit</button>
      </div>
    </div>
  );
}
