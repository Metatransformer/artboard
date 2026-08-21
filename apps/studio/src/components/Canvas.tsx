import React, { useCallback, useEffect, useRef, useState } from 'react';
import { renderArtboard } from '@artboard/render-svg';
import { hitTest, snap, type Box } from '@artboard/engine';
import type { Node } from '@artboard/schema';
import { uid, unscalableDescendant, type Command } from '@artboard/commands';
import { Scene } from '../lib/scene';
import {
  PASTE_OFFSET, cloneNodes, nextPasteOffset, readClipboard, textNodeFromText, writeNodes,
} from '../lib/clipboard';
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
  /** Snap lines to test against, captured once when the drag starts. */
  targets?: Targets;
  /**
   * The selected subtrees exactly as they were when a resize began.
   *
   * `scale` rounds, so applying it once per pointermove would compound the
   * rounding and the artwork would drift away from the box. Every frame
   * therefore puts these back and scales the pristine copy by the total
   * factor, which makes the drag exact at every position rather than only at
   * the first.
   */
  originNodes?: Node[];
  /**
   * How far the selection has already been translated during this drag.
   * `translate` is relative, so each pointermove sends only the difference
   * from here, and pointerup reverts by exactly this before committing.
   */
  applied: { dx: number; dy: number };
}

/* ── smart guides ─────────────────────────────────────────────────────────
 * Everything a moving selection can latch onto: the page's own edges and
 * centre, plus the edges and centres of every other visible object. Captured
 * once per drag, because they cannot change while you are dragging.
 * ---------------------------------------------------------------------- */

export interface Guide { axis: 'x' | 'y'; at: number }
interface Targets { xs: number[]; ys: number[] }
const EMPTY_TARGETS: Targets = { xs: [], ys: [] };
/** Screen pixels, divided by zoom at use so the feel is constant at any zoom. */
const SNAP_TOL = 7;

/**
 * How long a run of arrow-key nudges stays open before it is committed as one
 * undo step. Long enough to cover key-repeat and deliberate tapping, short
 * enough that the entry is on the stack before the user reaches for Cmd+Z.
 */
const NUDGE_IDLE_MS = 400;

/** One open run of arrow-key nudges: where it started and how far it has gone. */
interface Nudge { ids: string[]; dx: number; dy: number }

function unionBox(boxes: Box[]): { x: number; y: number; width: number; height: number } | null {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function collectTargets(others: Node[], page: { width: number; height: number }): Targets {
  const xs = [0, page.width / 2, page.width];
  const ys = [0, page.height / 2, page.height];
  for (const o of others) {
    const b = o as any;
    if (b.visible === false) continue;
    xs.push(b.x, b.x + b.width / 2, b.x + b.width);
    ys.push(b.y, b.y + b.height / 2, b.y + b.height);
  }
  return { xs, ys };
}

/**
 * Find the smallest nudge that puts one of the box's three x-anchors (and one
 * of its three y-anchors) onto a target. Each axis is solved independently, so
 * a box can snap horizontally without being dragged vertically.
 */
function solveSnap(
  box: { x: number; y: number; width: number; height: number },
  targets: Targets,
  tol: number,
): { dx: number; dy: number; guides: Guide[] } {
  const guides: Guide[] = [];
  const axis = (anchors: number[], candidates: number[]) => {
    let best = 0, bestGap = tol, at: number | null = null;
    for (const a of anchors) {
      for (const c of candidates) {
        const gap = Math.abs(c - a);
        if (gap < bestGap) { bestGap = gap; best = c - a; at = c; }
      }
    }
    return { delta: at === null ? 0 : best, at };
  };
  const h = axis([box.x, box.x + box.width / 2, box.x + box.width], targets.xs);
  const v = axis([box.y, box.y + box.height / 2, box.y + box.height], targets.ys);
  if (h.at !== null) guides.push({ axis: 'x', at: h.at });
  if (v.at !== null) guides.push({ axis: 'y', at: v.at });
  return { dx: h.delta, dy: v.delta, guides };
}

export function Canvas({ tool, onToolDone }: { tool: string; onToolDone: () => void }) {
  const { state, dispatch, run, runTransient, artboard, selected } = useEditor();
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);

  // a11y OFF for the editing surface, deliberately, and it is the one caller
  // that wants it off. The scaffolding is written for an exported SVG that
  // lands in a page: `role="img"` collapses the graphic to a single named
  // image, which is right for a picture and wrong for the canvas somebody is
  // working in — it hides from assistive tech the very structure they are
  // editing, and the Layers panel is that structure's accessible surface.
  // The visible half matters more: a `<title>` child of the canvas <svg> is a
  // native browser tooltip, so leaving it on makes the whole artboard sprout
  // "Launch Week" under the pointer while you drag things around it.
  const { scene, diagnostics } = renderArtboard(state.doc, artboard, { a11y: false });
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

  /* ── nudge coalescing ───────────────────────────────────────────────────
   * Arrow keys repeat, and tapping ArrowRight twenty times is ONE gesture in
   * the user's head — it must be one entry in the undo stack, not twenty.
   *
   * So a burst is applied transiently (no history at all) while it is open,
   * and an idle timer closes it: the selection is reverted to where the burst
   * started and the final positions are then committed as a single command.
   * That is the same revert-then-commit trick `onPointerUp` uses to turn a
   * hundred pointermove frames into one undo step, and it means `invert` sees
   * exactly one before/after pair, so undo restores the document exactly.
   *
   * The burst is also flushed the moment anything else happens — another key,
   * a pointer press, a selection change, unmount — so the undo stack can never
   * be one gesture behind what is on screen.
   * -------------------------------------------------------------------- */
  const nudgeRef = useRef<Nudge | null>(null);
  const nudgeTimer = useRef<number | null>(null);

  const flushNudge = useCallback(() => {
    if (nudgeTimer.current !== null) { window.clearTimeout(nudgeTimer.current); nudgeTimer.current = null; }
    const n = nudgeRef.current;
    nudgeRef.current = null;
    if (!n || (n.dx === 0 && n.dy === 0)) return;
    runTransient({ type: 'translate', nodeIds: n.ids, dx: -n.dx, dy: -n.dy });
    run({ type: 'translate', nodeIds: n.ids, dx: n.dx, dy: n.dy });
  }, [run, runTransient]);

  /* A burst left open when the component goes away would be lost from history. */
  useEffect(() => flushNudge, [flushNudge]);

  /* ── pointer handling ─────────────────────────────────────────────────── */
  const onPointerDown = (e: React.PointerEvent) => {
    flushNudge();
    if (e.button === 1 || e.altKey || tool === 'hand') {
      dragRef.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, origin: {}, originPan: state.pan, moved: false, applied: { dx: 0, dy: 0 } };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const { x, y } = toArtboard(e.clientX, e.clientY);

    if (tool !== 'select') {
      dragRef.current = { mode: 'draw', startX: x, startY: y, origin: {}, originPan: state.pan, drawKind: tool, moved: false, applied: { dx: 0, dy: 0 } };
      setDraft({ x, y, w: 0, h: 0 });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && selected.length) {
      dragRef.current = {
        mode: handle === 'rot' ? 'rotate' : 'resize', handle,
        startX: x, startY: y, originPan: state.pan, moved: false, applied: { dx: 0, dy: 0 },
        origin: Object.fromEntries(selected.map(n => [n.id, boxOf(n)])),
        originNodes: selected.map(n => structuredClone(n as Node)),
      };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    const hit = pickAt(x, y);
    if (!hit) {
      dispatch({ type: 'select', ids: [] });
      dragRef.current = { mode: 'marquee', startX: x, startY: y, origin: {}, originPan: state.pan, moved: false, applied: { dx: 0, dy: 0 } };
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
      mode: 'move', startX: x, startY: y, originPan: state.pan, moved: false, applied: { dx: 0, dy: 0 },
      origin: Object.fromEntries(picked.map(n => [n.id, boxOf(n)])),
      targets: collectTargets(nodes.filter(n => !ids.includes(n.id)), artboard),
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
      // Smart guides: nudge the whole selection so one of its edges or centres
      // lands exactly on an edge or centre of the page or another object.
      // Hold Alt to move freely.
      const boxes = Object.values(d.origin);
      const union = unionBox(boxes.map(b => ({ ...b, x: b.x + dx, y: b.y + dy })));
      const fit = e.altKey || !union
        ? { dx: 0, dy: 0, guides: [] as Guide[] }
        : solveSnap(union, d.targets ?? EMPTY_TARGETS, SNAP_TOL / state.zoom);
      setGuides(fit.guides);

      // Where the selection should sit, as a delta from where the drag began.
      // Snapping is solved on the union rather than per node, so a multi-node
      // selection keeps its internal spacing instead of each member rounding to
      // the grid on its own and quietly deforming the arrangement.
      const base = unionBox(boxes);
      const want = base
        ? { dx: snap(base.x + dx + fit.dx, grid) - base.x, dy: snap(base.y + dy + fit.dy, grid) - base.y }
        : { dx: 0, dy: 0 };
      const stepX = want.dx - d.applied.dx, stepY = want.dy - d.applied.dy;
      if (stepX !== 0 || stepY !== 0) {
        runTransient({ type: 'translate', nodeIds: Object.keys(d.origin), dx: stepX, dy: stepY });
        d.applied = want;
      }
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
      const cmds: Command[] = Object.entries(d.origin).flatMap(([id, b]) => {
        let { x: nx, y: ny, width: nw, height: nh } = b;
        if (h.includes('e')) nw = b.width + dx;
        if (h.includes('s')) nh = b.height + dy;
        if (h.includes('w')) { nx = b.x + dx; nw = b.width - dx; }
        if (h.includes('n')) { ny = b.y + dy; nh = b.height - dy; }
        // Ratio-locked on request (shift), and ALSO when the target contains a
        // rotated node -- a rotated box scaled by different x and y factors is
        // a parallelogram, which `scale` refuses because no node can store one.
        // Constraining the drag is better than letting it fail: the refusal
        // would be swallowed frame by frame (runTransient discards throws) and
        // then surface as a toast at pointerup, so the gesture would look
        // simply dead. Locked, the user sees the box grow squarely and gets a
        // correct result. Unlike shift, this applies to the side handles too --
        // a side handle IS a non-uniform scale, so it is the case that has to
        // be constrained rather than the one that can be left alone.
        const target = nodes.find(v => v.id === id) as Node | undefined;
        const mustLock = !!target && !!unscalableDescendant(target);
        if (((e.shiftKey && h.length === 2) || mustLock) && b.width > 0 && b.height > 0) {
          const ratio = b.width / b.height;
          if (Math.abs(nw - b.width) > Math.abs(nh - b.height)) nh = nw / ratio; else nw = nh * ratio;
          if (h.includes('n')) ny = b.y + b.height - nh;
          if (h.includes('w')) nx = b.x + b.width - nw;
        }
        const box = { x: snap(nx, grid), y: snap(ny, grid),
                      width: Math.max(1, snap(nw, grid)), height: Math.max(1, snap(nh, grid)) };
        return resizeCommands(nodes.find(v => v.id === id) as Node | undefined, b, box, d.originNodes);
      });
      runTransient({ type: 'batch', label: 'resize', commands: cmds });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    setGuides([]);
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

    // Commit the transient drag as ONE history entry: rewind what the drag
    // applied, then run the whole thing again through `run` so `invert` sees
    // exactly one before/after pair.
    if (d.moved && d.mode === 'move') {
      const ids = Object.keys(d.origin);
      const { dx: adx, dy: ady } = d.applied;
      if (adx !== 0 || ady !== 0) {
        runTransient({ type: 'translate', nodeIds: ids, dx: -adx, dy: -ady });
        run({ type: 'translate', nodeIds: ids, dx: adx, dy: ady });
      }
      return;
    }

    if (d.moved && (d.mode === 'resize' || d.mode === 'rotate')) {
      // Revert to the origin state, then commit the whole gesture, so history
      // records exactly one step. A resized GROUP reverts and commits through
      // `replaceNodes`/`scale` rather than a box patch: its box is bounds
      // metadata, and `updateNode` refuses to write it precisely because doing
      // so would move the handles and leave the artwork behind. A ROTATED group
      // stays on the patch path -- rotation is emitted on the group's wrapper
      // and does work -- and sends x/y/width/height unchanged, which the guard
      // allows.
      const revert: Command[] = [];
      const cmds: Command[] = [];
      for (const [id, b] of Object.entries(d.origin)) {
        const now = nodes.find(n => n.id === id) as any;
        if (!now) continue;
        const pristine = (d.originNodes ?? []).filter(n => n.id === id);
        if (now.kind === 'group' && d.mode === 'resize' && pristine[0]) {
          revert.push({ type: 'replaceNodes', nodes: pristine });
          cmds.push(...resizeCommands(pristine[0], b, now));
        } else {
          revert.push({ type: 'updateNode', nodeId: id, patch: { x: b.x, y: b.y, width: b.width, height: b.height, rotation: b.rotation } });
          cmds.push({ type: 'updateNode', nodeId: id, patch: { x: now.x, y: now.y, width: now.width, height: now.height, rotation: now.rotation } });
        }
      }
      runTransient({ type: 'batch', label: 'revert', commands: revert });
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
    const ARROWS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    /* Pressing Shift for a 10px nudge fires its own keydown first. Treating
       that as "some other key" would end the burst before the arrow that
       follows it, so Shift+Arrow could never coalesce at all. */
    const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock']);

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // Never take a key away from a field, and never from the canvas text
      // editor. `editingTextId` is checked as well as the target, so that a
      // stray focus loss mid-edit cannot turn Backspace into "delete the node".
      if (typing || state.editingTextId) {
        if (e.key === 'Escape') dispatch({ type: 'editText', id: null });
        return;
      }

      const dir = ARROWS[e.key];
      if (!dir && !MODIFIERS.has(e.key)) flushNudge();

      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      /** Gate on read-only, with the same message the store would have given. */
      const mutable = (): boolean => {
        if (!state.readOnly) return true;
        dispatch({ type: 'toast', toast: { level: 'warn', message: 'This document is read-only.' } });
        return false;
      };

      if (meta && key === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return; }

      if (meta && key === 'a') {
        e.preventDefault();
        dispatch({ type: 'select', ids: nodes.filter(n => !(n as any).locked).map(n => n.id) });
        return;
      }

      /* Copy / cut. Copying is not a mutation, so it works read-only too. */
      if (meta && (key === 'c' || key === 'x')) {
        if (!selected.length) return;
        e.preventDefault();
        void writeNodes(selected);
        if (key === 'x' && mutable()) {
          run({ type: 'batch', label: 'cut',
                commands: selected.map(n => ({ type: 'removeNode', artboardId: artboard.id, nodeId: n.id })) });
          dispatch({ type: 'select', ids: [] });
        }
        return;
      }

      /* Paste. Async, because reading the system clipboard is async — which is
         also what lets a paste come from another page, document or tab. */
      if (meta && key === 'v') {
        e.preventDefault();
        if (!mutable()) return;
        const page = { id: artboard.id, width: artboard.width, height: artboard.height };
        void (async () => {
          const read = await readClipboard();
          if (!read) return;
          const offset = nextPasteOffset(read.sig);
          const fresh = read.kind === 'nodes'
            ? cloneNodes(read.nodes, offset, offset)
            : ([textNodeFromText(read.text, page, offset)].filter(Boolean) as Node[]);
          if (!fresh.length) return;
          run({ type: 'batch', label: 'paste',
                commands: fresh.map(n => ({ type: 'addNode', artboardId: page.id, node: n })) });
          dispatch({ type: 'select', ids: fresh.map(n => n.id) });
        })();
        return;
      }

      /* Duplicate — copy+paste without touching the system clipboard. The new
         copies become the selection, so holding Cmd+D cascades on its own. */
      if (meta && key === 'd') {
        e.preventDefault();
        if (!selected.length || !mutable()) return;
        const copies = cloneNodes(selected, PASTE_OFFSET, PASTE_OFFSET);
        if (!copies.length) return;
        run({ type: 'batch', label: 'duplicate',
              commands: copies.map(n => ({ type: 'addNode', artboardId: artboard.id, node: n })) });
        dispatch({ type: 'select', ids: copies.map(n => n.id) });
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
        e.preventDefault();
        if (!mutable()) return;
        run({ type: 'batch', label: 'delete',
              commands: selected.map(n => ({ type: 'removeNode', artboardId: artboard.id, nodeId: n.id })) });
        dispatch({ type: 'select', ids: [] });
        return;
      }

      if (e.key === 'Escape') { dispatch({ type: 'select', ids: [] }); return; }

      if (dir && selected.length) {
        e.preventDefault();
        if (!mutable()) return;
        const step = e.shiftKey ? 10 : 1;
        const ids = selected.map(n => n.id);
        const open = nudgeRef.current;
        // A burst belongs to one selection; selecting something else ends it.
        if (!open || open.ids.length !== ids.length || open.ids.some((id, i) => id !== ids[i])) {
          flushNudge();
          nudgeRef.current = {
            ids, dx: 0, dy: 0,
          };
        }
        const burst = nudgeRef.current!;
        burst.dx += dir[0] * step;
        burst.dy += dir[1] * step;
        runTransient({ type: 'translate', nodeIds: burst.ids, dx: dir[0] * step, dy: dir[1] * step });
        if (nudgeTimer.current !== null) window.clearTimeout(nudgeTimer.current);
        nudgeTimer.current = window.setTimeout(flushNudge, NUDGE_IDLE_MS);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, nodes, artboard.id, artboard.width, artboard.height,
      state.readOnly, state.editingTextId, run, runTransient, dispatch, flushNudge]);

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
            {selected.map(n => (
              <SelectionBox key={n.id} box={boxOf(n)} zoom={state.zoom}
                            single={selected.length === 1}
                            />
            ))}
            {guides.map((g, i) => (
              <line key={i}
                x1={g.axis === 'x' ? g.at : 0} x2={g.axis === 'x' ? g.at : artboard.width}
                y1={g.axis === 'y' ? g.at : 0} y2={g.axis === 'y' ? g.at : artboard.height}
                stroke="#ec4899" strokeWidth={1 / state.zoom} strokeDasharray={`${5 / state.zoom} ${4 / state.zoom}`} />
            ))}
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

/**
 * The commands that resize one node to `box`.
 *
 * A plain node is its own geometry, so its box is simply patched -- resizing a
 * text frame must NOT change its font size, which is what dragging a text box's
 * edge means in every tool.
 *
 * A group owns no geometry: its children carry absolute coordinates and the
 * renderer emits no transform for it, so patching its box moved the handles and
 * nothing else. It therefore goes through `scale`, which multiplies the whole
 * subtree -- positions, sizes, font sizes, stroke widths -- about the corner the
 * drag is pinning.
 *
 * The pinned corner is derived rather than looked up from the handle: scaling
 * about (ox, oy) has to map the node's own x and width onto the new box, and
 * solving that is one line that stays correct for all eight handles, including
 * the shift-constrained cases where the fixed point is not the opposite corner
 * at all.
 *
 * `originNodes` is put back first so each frame scales the pristine subtree by
 * the total factor rather than compounding a rounded one.
 */
function resizeCommands(node: Node | undefined, from: Box, box: { x: number; y: number; width: number; height: number }, originNodes?: Node[]): Command[] {
  if (!node) return [];
  if ((node as any).kind !== 'group') {
    return [{ type: 'updateNode', nodeId: node.id, patch: { ...box } }];
  }
  if (from.width <= 0 || from.height <= 0) return [];
  let sx = box.width / from.width, sy = box.height / from.height;
  // A subtree that cannot be stretched unevenly gets ONE factor, not two that
  // happen to be close. The drag already ratio-locks, but the box it produces
  // is snapped to the grid first, so the two ratios come out a thousandth
  // apart -- enough for `scale` to call it non-uniform and refuse, every frame,
  // which `runTransient` discards and the user sees as a dead handle. Sending
  // a single factor is what "locked" actually means.
  if (unscalableDescendant(node)) {
    const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = s; sy = s;
  }
  const fixed = (nFrom: number, nTo: number, s: number) => (s === 1 ? nFrom : (nTo - nFrom * s) / (1 - s));
  const pristine = (originNodes ?? []).filter(n => n.id === node.id);
  return [
    ...(pristine.length ? [{ type: 'replaceNodes', nodes: pristine } as Command] : []),
    { type: 'scale', nodeIds: [node.id], sx, sy,
      ox: fixed(from.x, box.x, sx), oy: fixed(from.y, box.y, sy) },
  ];
}

/**
 * Every selected node gets the eight resize handles and the rotate handle.
 *
 * A group's handles were hidden for a while, because resizing one moved the
 * bounds box and left the artwork untouched -- the same silent no-op as the
 * drag bug, wearing the other gesture, and a control that cannot do what it
 * advertises is worse than no control. `scale` makes the gesture real, so they
 * are back. See `resizeCommands`.
 */
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
