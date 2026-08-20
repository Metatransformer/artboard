import React, { useEffect, useMemo, useRef } from 'react';

/**
 * The keyboard reference. Every row below was read off a real handler:
 *   App.tsx        window keydown -> tool letters, "?" for this sheet, Mod+Shift+P to present
 *   Canvas.tsx     window keydown -> edit/selection keys; pointer handlers -> drag modifiers
 *   Present.tsx    capture keydown -> presentation navigation
 * If a key is not bound in one of those places it is not in this list.
 */

/** 'Mod' renders as the Command symbol on Apple platforms and Ctrl everywhere else. */
type Combo = string[];
interface Row { label: string; combos: Combo[] }
interface Section { title: string; rows: Row[]; note?: string }

const SECTIONS: Section[] = [
  {
    title: 'Tools',
    rows: [
      { label: 'Select', combos: [['V']] },
      { label: 'Text', combos: [['T']] },
      { label: 'Rectangle', combos: [['R']] },
      { label: 'Ellipse', combos: [['O']] },
      { label: 'Line', combos: [['L']] },
      { label: 'Pan', combos: [['H']] },
    ],
    note: 'Tool letters are ignored while a field is focused or Ctrl/Command is held.',
  },
  {
    title: 'Edit',
    rows: [
      { label: 'Undo', combos: [['Mod', 'Z']] },
      { label: 'Redo', combos: [['Shift', 'Mod', 'Z']] },
      { label: 'Duplicate, offset by 24 px', combos: [['Mod', 'D']] },
      { label: 'Delete selection', combos: [['Delete'], ['Backspace']] },
      { label: 'Move selection by 1 px', combos: [['Arrows']] },
      { label: 'Move selection by 10 px', combos: [['Shift', 'Arrows']] },
      { label: 'Edit a text object', combos: [['Double-click']] },
      { label: 'Leave the text editor, keeping the edit', combos: [['Esc']] },
    ],
  },
  {
    title: 'Selection',
    rows: [
      { label: 'Select every unlocked object', combos: [['Mod', 'A']] },
      { label: 'Clear the selection', combos: [['Esc']] },
      { label: 'Add or remove one object', combos: [['Shift', 'Click']] },
      { label: 'Marquee select from empty canvas', combos: [['Drag']] },
      { label: 'Resize a corner keeping the ratio', combos: [['Shift', 'Drag']] },
      { label: 'Rotate in 15 degree steps', combos: [['Shift', 'Drag']] },
      { label: 'Move off the 1 px grid', combos: [['Shift', 'Drag']] },
      { label: 'Ignore smart guides (press Alt mid-drag)', combos: [['Alt', 'Drag']] },
    ],
  },
  {
    title: 'View',
    rows: [
      { label: 'Zoom in and out', combos: [['Mod', 'Scroll']] },
      { label: 'Pan the canvas', combos: [['Scroll']] },
      { label: 'Pan by dragging (hold Alt first)', combos: [['Alt', 'Drag']] },
      { label: 'Pan by dragging', combos: [['Middle-click', 'Drag']] },
      { label: 'Pan tool', combos: [['H']] },
      { label: 'Open or close this list', combos: [['?']] },
    ],
  },
  {
    title: 'Pages',
    rows: [
      { label: 'Start presenting', combos: [['Mod', 'Shift', 'P']] },
      { label: 'Next page', combos: [['Right'], ['Down'], ['Space'], ['Page Down'], ['Click']] },
      { label: 'Previous page', combos: [['Left'], ['Up'], ['Page Up']] },
      { label: 'First page', combos: [['Home']] },
      { label: 'Last page', combos: [['End']] },
      { label: 'Leave presentation mode', combos: [['Esc']] },
    ],
    note: 'Page keys work while presenting. In the editor, pages are switched from the page bar.',
  },
];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** navigator.platform is deprecated and userAgentData is not everywhere, so try both and fall back. */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(hint);
}

function keyLabel(key: string, apple: boolean): string {
  if (key === 'Mod') return apple ? '⌘' : 'Ctrl';
  if (key === 'Alt') return apple ? '⌥' : 'Alt';
  if (key === 'Shift') return apple ? '⇧' : 'Shift';
  return key;
}

export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  const apple = useMemo(() => isApplePlatform(), []);

  /* Take focus on open, give it back on close. */
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
    return () => {
      const back = restoreRef.current;
      restoreRef.current = null;
      back?.focus();
    };
  }, [open]);

  /* Escape closes; Tab cycles inside the panel. Capture phase, and stopped there, so the
     editor's own window keydown handlers stay quiet behind the modal. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      /* The same key that opened this closes it - the toggle in App.tsx never sees
         these events, because everything is stopped here. */
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;

      if (!(active instanceof HTMLElement) || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? lastItem : first).focus();
        return;
      }
      if (e.shiftKey && active === first) { e.preventDefault(); lastItem.focus(); }
      else if (!e.shiftKey && active === lastItem) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  return (
    <div className="sc-backdrop" onClick={() => closeRef.current()}>
      <div
        ref={panelRef}
        className="sc-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sc-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="sc-head">
          <div>
            <h2 className="sc-title" id="sc-title">Keyboard shortcuts</h2>
            <p className="sc-sub">Everything the editor listens for.</p>
          </div>
          <button className="sc-close" onClick={() => closeRef.current()} aria-label="Close keyboard shortcuts">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="sc-body">
          {SECTIONS.map(section => (
            <section className="sc-section" key={section.title}>
              <h3>{section.title}</h3>
              {section.rows.map((row, i) => (
                <div className="sc-row" key={`${section.title}-${i}`}>
                  <span className="sc-label">{row.label}</span>
                  <span className="sc-keys">
                    {row.combos.map((combo, c) => (
                      <React.Fragment key={c}>
                        {c > 0 && <span className="sc-or">or</span>}
                        {combo.map((key, k) => (
                          <React.Fragment key={k}>
                            {k > 0 && <span className="sc-plus">+</span>}
                            <kbd>{keyLabel(key, apple)}</kbd>
                          </React.Fragment>
                        ))}
                      </React.Fragment>
                    ))}
                  </span>
                </div>
              ))}
              {section.note && <p className="sc-note">{section.note}</p>}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
