import React, { useCallback, useEffect, useRef, useState } from 'react';
import { renderArtboard } from '@artboard/render-svg';
import { hitTest, snap, type Box } from '@artboard/engine';
import type { Node } from '@artboard/schema';
import { uid, type Command } from '@artboard/commands';
import { Scene } from '../lib/scene';
import { useEditor } from '../state/store';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';
interface Drag {
  mode: 'move' | 'resize' | 'rotate' | 'pan' | 'marquee' | 'draw';
  handle?: Handle;
  startX: number; startY: number;
  origin: Record<string, Box>;
  originPan: { x: number; y: number };
  drawKind?: string;
  moved: boolean;
}

export function Canvas({ tool, onToolDone }: { tool: string; onToolDone: () => void }) {
  const { state, dispatch, run, runTransient, artboard, selected } = useEditor();
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const { scene, diagnostics } = renderArtboard(state.doc, artboard);
  const nodes = artboard.nodes as Node[];

  /* screen → artboard coordinates */
  const toArtboard = useCallback((clientX: number, clientY: number) => {
    const el = hostRef.current?.querySelector('.ab-surface') as HTMLElement | null;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left) / state.zoom, y: (clientY - r.top) / state.zoom };
  }, [state.zoom]);

  const boxOf = (n: Node): Box => ({ x: (n as any).x, y: (n as any).y, width: (n as any).width, height: (n as any).height, rotation: (n as any).rotation ?? 0 });

  const pickAt = (ax: number, ay: number): Node | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if ((n as any).locked || !(n as any).visible) continue;
      if (hitTest(boxOf(n), ax, ay)) return n;
    }
    return null;
  };

  /* ── pointer handling ─────────────────────────────────────────────────── */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.altKey || tool === 'hand') {
      dragRef.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, origin: {}, originPan: state.pan, moved: false };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const { x, y } = toArtboard(e.clientX, e.clientY);

    if (tool !== 'select') {
      dragRef.current = { mode: 'draw', startX: x, startY: y, origin: {}, originPan: state.pan, drawKind: tool, moved: false };
      setDraft({ x, y, w: 0, h: 0 });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && selected.length) {
      dragRef.current = {
        mode: handle === 'rot' ? 'rotate' : 'resize', handle,
        startX: x, startY: y, originPan: state.pan, moved: false,
        origin: Object.fromEntries(selected.map(n => [n.id, boxOf(n)])),
      };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    const hit = pickAt(x, y);
    if (!hit) {
      dispatch({ type: 'select', ids: [] });
      dragRef.current = { mode: 'marquee', startX: x, startY: y, origin: {}, originPan: state.pan, moved: false };
      setMarquee({ x, y, w: 0, h: 0 });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    const ids = e.shiftKey
      ? (state.selection.includes(hit.id) ? state.selection.filter(i => i !== hit.id) : [...state.selection, hit.id])
      : (state.selection.includes(hit.id) ? state.selection : [hit.id]);
    dispatch({ type: 'select', ids });
    const picked = nodes.filter(n => ids.includes(n.id));
    dragRef.current = {
      mode: 'move', startX: x, startY: y, originPan: state.pan, moved: false,
      origin: Object.fromEntries(picked.map(n => [n.id, boxOf(n)])),
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;

    if (d.mode === 'pan') {
      dispatch({ type: 'setPan', pan: { x: d.originPan.x + (e.clientX - d.startX), y: d.originPan.y + (e.clientY - d.startY) } });
      return;
    }
    const { x, y } = toArtboard(e.clientX, e.clientY);
    const dx = x - d.startX, dy = y - d.startY;
    const grid = e.shiftKey ? 0 : 1;

    if (d.mode === 'marquee') { setMarquee({ x: Math.min(d.startX, x), y: Math.min(d.startY, y), w: Math.abs(dx), h: Math.abs(dy) }); return; }
    if (d.mode === 'draw') { setDraft({ x: Math.min(d.startX, x), y: Math.min(d.startY, y), w: Math.abs(dx), h: Math.abs(dy) }); return; }

    if (d.mode === 'move') {
      const cmds: Command[] = Object.entries(d.origin).map(([id, b]) => ({
        type: 'updateNode', nodeId: id, patch: { x: snap(b.x + dx, grid), y: snap(b.y + dy, grid) },
      }));
      runTransient({ type: 'batch', label: 'move', commands: cmds });
      return;
    }

    if (d.mode === 'rotate') {
      const cmds: Command[] = Object.entries(d.origin).map(([id, b]) => {
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        const a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90;
        return { type: 'updateNode', nodeId: id, patch: { rotation: Math.round(e.shiftKey ? Math.round(a / 15) * 15 : a) } };
      });
      runTransient({ type: 'batch', label: 'rotate', commands: cmds });
      return;
    }

    if (d.mode === 'resize' && d.handle) {
      const h = d.handle;
      const cmds: Command[] = Object.entries(d.origin).map(([id, b]) => {
        let { x: nx, y: ny, width: nw, height: nh } = b;
        if (h.includes('e')) nw = b.width + dx;
        if (h.includes('s')) nh = b.height + dy;
        if (h.includes('w')) { nx = b.x + dx; nw = b.width - dx; }
        if (h.includes('n')) { ny = b.y + dy; nh = b.height - dy; }
        if (e.shiftKey && b.width > 0 && b.height > 0 && h.length === 2) {
          const ratio = b.width / b.height;
          if (Math.abs(nw - b.width) > Math.abs(nh - b.height)) nh = nw / ratio; else nw = nh * ratio;
          if (h.includes('n')) ny = b.y + b.height - nh;
          if (h.includes('w')) nx = b.x + b.width - nw;
        }
        return { type: 'updateNode', nodeId: id,
          patch: { x: snap(nx, grid), y: snap(ny, grid), width: Math.max(1, snap(nw, grid)), height: Math.max(1, snap(nh, grid)) } };
      });
      runTransient({ type: 'batch', label: 'resize', commands: cmds });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;

    if (d.mode === 'marquee') {
      const m = marquee; setMarquee(null);
      if (m && (m.w > 2 || m.h > 2)) {
        const ids = nodes.filter(n => { const b = boxOf(n); return !(n as any).locked && b.x < m.x + m.w && b.x + b.width > m.x && b.y < m.y + m.h && b.y + b.height > m.y; }).map(n => n.id);
        dispatch({ type: 'select', ids });
      }
      return;
    }

    if (d.mode === 'draw') {
      const dd = draft; setDraft(null); onToolDone();
      if (!dd) return;
      const w = Math.max(dd.w, d.drawKind === 'text' ? 320 : 20);
      const h = Math.max(dd.h, d.drawKind === 'text' ? 80 : 20);
      const node = makeNode(d.drawKind!, dd.x, dd.y, w, h);
      run({ type: 'addNode', artboardId: artboard.id, node });
      dispatch({ type: 'select', ids: [node.id] });
      return;
    }

    // commit the transient drag as ONE history entry
    if (d.moved && (d.mode === 'move' || d.mode === 'resize' || d.mode === 'rotate')) {
      const cmds: Command[] = Object.entries(d.origin).map(([id, b]) => {
        const now = nodes.find(n => n.id === id) as any;
        if (!now) return { type: 'batch', label: 'noop', commands: [] } as Command;
        return { type: 'updateNode', nodeId: id, patch: { x: now.x, y: now.y, width: now.width, height: now.height, rotation: now.rotation } };
      });
      // revert to origin, then commit the final state so history records exactly one step
      const revert: Command = { type: 'batch', label: 'revert', commands: Object.entries(d.origin).map(([id, b]) => ({ type: 'updateNode', nodeId: id, patch: { x: b.x, y: b.y, width: b.width, height: b.height, rotation: b.rotation } })) };
      runTransient(revert);
      run({ type: 'batch', label: d.mode, commands: cmds });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = toArtboard(e.clientX, e.clientY);
    const hit = pickAt(x, y);
    if (hit && (hit as any).kind === 'text') dispatch({ type: 'editText', id: hit.id });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      dispatch({ type: 'setZoom', zoom: state.zoom * (1 - e.deltaY / 400) });
    } else {
      dispatch({ type: 'setPan', pan: { x: state.pan.x - e.deltaX, y: state.pan.y - e.deltaY } });
    }
  };

  /* ── keyboard ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
        if (e.key === 'Escape') dispatch({ type: 'editText', id: null });
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return; }
      if (meta && e.key.toLowerCase() === 'd' && selected.length) {
        e.preventDefault();
        const copies = selected.map(n => ({ ...(n as any), id: uid('n'), x: (n as any).x + 24, y: (n as any).y + 24 }));
        run({ type: 'batch', label: 'duplicate', commands: copies.map(c => ({ type: 'addNode', artboardId: artboard.id, node: c })) });
        dispatch({ type: 'select', ids: copies.map(c => c.id) });
        return;
      }
      if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); dispatch({ type: 'select', ids: nodes.filter(n => !(n as any).locked).map(n => n.id) }); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
        e.preventDefault();
        run({ type: 'batch', label: 'delete', commands: selected.map(n => ({ type: 'removeNode', artboardId: artboard.id, nodeId: n.id })) });
        dispatch({ type: 'select', ids: [] });
        return;
      }
      if (e.key === 'Escape') { dispatch({ type: 'select', ids: [] }); return; }
      const step = e.shiftKey ? 10 : 1;
      const deltas: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const d = deltas[e.key];
      if (d && selected.length) {
        e.preventDefault();
        run({ type: 'batch', label: 'nudge', commands: selected.map(n => ({ type: 'updateNode', nodeId: n.id, patch: { x: (n as any).x + d[0], y: (n as any).y + d[1] } })) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, nodes, artboard.id, run, dispatch]);

  /* fit the artboard to the viewport on mount and whenever its size changes */
  const fitKey = `${artboard.id}:${artboard.width}x${artboard.height}`;
  const lastFit = useRef<string>('');
  useEffect(() => {
    if (lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    const z = Math.min((r.width - 96) / artboard.width, (r.height - 96) / artboard.height, 2);
    dispatch({ type: 'setZoom', zoom: z });
    dispatch({ type: 'setPan', pan: { x: 0, y: 0 } });
  }, [fitKey, artboard.width, artboard.height, dispatch]);

  /* re-fit on window resize when the artboard would overflow */
  useEffect(() => {
    const onResize = () => { lastFit.current = ''; };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const editing = state.editingTextId ? (nodes.find(n => n.id === state.editingTextId) as any) : null;

  return (
    <div className="canvas-host" ref={hostRef} onWheel={onWheel}>
      <div className="canvas-stage" style={{ transform: `translate(${state.pan.x}px, ${state.pan.y}px)` }}>
        <div
          className="ab-surface"
          style={{ width: artboard.width * state.zoom, height: artboard.height * state.zoom, cursor: tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}
        >
          <div className="ab-paper" style={{ width: artboard.width, height: artboard.height, transform: `scale(${state.zoom})` }}>
            <Scene node={scene} />
          </div>

          <svg className="ab-overlay" viewBox={`0 0 ${artboard.width} ${artboard.height}`}
               style={{ width: artboard.width * state.zoom, height: artboard.height * state.zoom }}>
            {selected.map(n => <SelectionBox key={n.id} box={boxOf(n)} zoom={state.zoom} single={selected.length === 1} />)}
            {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h}
              fill="#4f46e51a" stroke="#4f46e5" strokeWidth={1 / state.zoom} />}
            {draft && <rect x={draft.x} y={draft.y} width={draft.w} height={draft.h}
              fill="#4f46e526" stroke="#4f46e5" strokeWidth={1 / state.zoom} strokeDasharray={`${4 / state.zoom} ${3 / state.zoom}`} />}
          </svg>

          {editing && (
            <textarea
              className="text-editor"
              autoFocus
              defaultValue={editing.text}
              onBlur={e => { run({ type: 'updateNode', nodeId: editing.id, patch: { text: e.target.value } }); dispatch({ type: 'editText', id: null }); }}
              onKeyDown={e => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
              style={{
                left: editing.x * state.zoom, top: editing.y * state.zoom,
                width: editing.width * state.zoom, height: editing.height * state.zoom,
                fontFamily: editing.fontFamily, fontSize: editing.fontSize * state.zoom,
                fontWeight: editing.fontWeight, lineHeight: editing.lineHeight,
                color: editing.color, textAlign: editing.align,
                transform: editing.rotation ? `rotate(${editing.rotation}deg)` : undefined,
              }}
            />
          )}
        </div>
      </div>

      {diagnostics.length > 0 && (
        <div className="diagnostics">
          {diagnostics.slice(0, 3).map((d, i) => (
            <div key={i} className={`diag diag-${d.level}`}><b>{d.code}</b> {d.message}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionBox({ box, zoom, single }: { box: Box; zoom: number; single: boolean }) {
  const s = 1 / zoom;
  const hs = 7 * s;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const handles: Array<[Handle, number, number]> = [
    ['nw', box.x, box.y], ['n', cx, box.y], ['ne', box.x + box.width, box.y],
    ['e', box.x + box.width, cy], ['se', box.x + box.width, box.y + box.height],
    ['s', cx, box.y + box.height], ['sw', box.x, box.y + box.height], ['w', box.x, cy],
  ];
  return (
    <g transform={box.rotation ? `rotate(${box.rotation} ${cx} ${cy})` : undefined}>
      <rect x={box.x} y={box.y} width={box.width} height={box.height}
            fill="none" stroke="#4f46e5" strokeWidth={1.5 * s} pointerEvents="none" />
      {single && <>
        <line x1={cx} y1={box.y} x2={cx} y2={box.y - 26 * s} stroke="#4f46e5" strokeWidth={1.5 * s} pointerEvents="none" />
        <circle data-handle="rot" cx={cx} cy={box.y - 26 * s} r={hs} fill="#fff" stroke="#4f46e5" strokeWidth={1.5 * s} style={{ cursor: 'grab' }} />
        {handles.map(([h, x, y]) => (
          <rect key={h} data-handle={h} x={x - hs} y={y - hs} width={hs * 2} height={hs * 2}
                rx={1.5 * s} fill="#fff" stroke="#4f46e5" strokeWidth={1.5 * s}
                style={{ cursor: `${h}-resize` }} />
        ))}
      </>}
    </g>
  );
}

export function makeNode(kind: string, x: number, y: number, width: number, height: number): any {
  const base = { id: uid('n'), name: '', x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), rotation: 0, opacity: 1, visible: true, locked: false, shadow: null };
  switch (kind) {
    case 'text': return { ...base, kind: 'text', name: 'Text', text: 'Your text here', fontFamily: 'Inter', fontSize: Math.max(16, Math.round(height * 0.5)), fontWeight: 700, italic: false, lineHeight: 1.2, letterSpacing: 0, align: 'left', valign: 'top', color: '#111111', uppercase: false };
    case 'ellipse': return { ...base, kind: 'ellipse', name: 'Ellipse', fill: { kind: 'solid', color: '#f59e0b' }, stroke: { color: '#000000', width: 0, dash: [] } };
    case 'line': return { ...base, kind: 'line', name: 'Line', height: 0, stroke: { color: '#111111', width: 4, dash: [] } };
    default: return { ...base, kind: 'rect', name: 'Rectangle', fill: { kind: 'solid', color: '#4f46e5' }, stroke: { color: '#000000', width: 0, dash: [] }, radius: 0 };
  }
}
