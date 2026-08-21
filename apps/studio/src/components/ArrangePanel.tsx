import React from 'react';
import { aabb, round } from '@artboard/engine';
import { uid, type Command } from '@artboard/commands';
import type { Node } from '@artboard/schema';
import { useEditor } from '../state/store';

/**
 * The Position toolbox: align, distribute, order, group.
 *
 * Two rules hold this together:
 *  - Geometry comes from the engine. Every measurement is `aabb(node)`, so a
 *    rotated node aligns by the box you can actually see, not by its unrotated
 *    x/y/w/h. Moving x by d moves the aabb by d, which is why a plain
 *    a `translate` by the computed delta is enough to hit any alignment
 *    target -- and unlike an x/y patch it also moves a group's children.
 *  - Every button is exactly one undo step. Multi-node work goes out as a
 *    `batch`, and the batch shapes here are the ones whose inverse is exact -
 *    see `orderCommands` for the one case where that took some care.
 */

type Rect = { x: number; y: number; width: number; height: number };
type Axis = 'x' | 'y';

const boxOf = (n: Node): Rect => {
  const a = n as any;
  return aabb({ x: a.x, y: a.y, width: a.width, height: a.height, rotation: a.rotation ?? 0 });
};

const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map(r => r.x));
  const y = Math.min(...rs.map(r => r.y));
  return {
    x, y,
    width: Math.max(...rs.map(r => r.x + r.width)) - x,
    height: Math.max(...rs.map(r => r.y + r.height)) - y,
  };
};

type Edge = 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom';
const EDGE_AXIS: Record<Edge, Axis> = {
  left: 'x', centerX: 'x', right: 'x', top: 'y', middleY: 'y', bottom: 'y',
};

export function ArrangePanel() {
  const { artboard, selected, run, dispatch } = useEditor();
  const nodes = artboard.nodes as Node[];
  const count = selected.length;

  /* ── flip ─────────────────────────────────────────────────────────────── */
  // Mirroring is per-node, about each node's own centre, so a multi-selection
  // flips each element in place rather than swapping their positions. That
  // matches what "flip" means in every editor a user has come from.
  const flip = (axis: 'flipX' | 'flipY') => {
    if (count === 0) return;
    const commands: Command[] = selected.map(n => ({
      type: 'updateNode', nodeId: n.id, patch: { [axis]: !(n as any)[axis] },
    }));
    run(commands.length === 1 ? commands[0]! : { type: 'batch', label: axis === 'flipX' ? 'Flip horizontal' : 'Flip vertical', commands });
  };

  /* ── align ────────────────────────────────────────────────────────────── */
  const align = (edge: Edge) => {
    if (count === 0) return;
    const boxes = selected.map(boxOf);
    // One node has nothing to align against but the page; several align to
    // the box they collectively occupy, which is what leaves the outermost
    // elements where the user put them.
    const target: Rect = count === 1
      ? { x: 0, y: 0, width: artboard.width, height: artboard.height }
      : union(boxes);

    const axis = EDGE_AXIS[edge];
    const size = axis === 'x' ? 'width' : 'height';
    const commands: Command[] = [];

    selected.forEach((n, i) => {
      const b = boxes[i]!;
      const delta =
        edge === 'left' || edge === 'top' ? target[axis] - b[axis]
        : edge === 'right' || edge === 'bottom' ? (target[axis] + target[size]) - (b[axis] + b[size])
        : (target[axis] + target[size] / 2) - (b[axis] + b[size] / 2);
      if (Math.abs(delta) < 1e-6) return;
      commands.push({ type: 'translate', nodeIds: [n.id], dx: axis === 'x' ? delta : 0, dy: axis === 'y' ? delta : 0 });
    });
    commit(commands, `align ${edge}`);
  };

  /* ── distribute ───────────────────────────────────────────────────────── */
  const distribute = (axis: Axis) => {
    if (count < 3) return;
    const size = axis === 'x' ? 'width' : 'height';
    const items = selected
      .map(n => ({ n, b: boxOf(n) }))
      .sort((p, q) => (p.b[axis] + p.b[size] / 2) - (q.b[axis] + q.b[size] / 2));

    // Equal GAPS, not equal centres: the two outermost elements stay put and
    // the space between neighbours is divided evenly, so differently sized
    // elements still read as evenly spaced.
    const start = Math.min(...items.map(i => i.b[axis]));
    const end = Math.max(...items.map(i => i.b[axis] + i.b[size]));
    const gap = (end - start - items.reduce((s, i) => s + i.b[size], 0)) / (items.length - 1);

    let cursor = start;
    const commands: Command[] = [];
    for (const it of items) {
      const delta = cursor - it.b[axis];
      cursor += it.b[size] + gap;
      if (Math.abs(delta) < 1e-6) continue;
      commands.push({ type: 'translate', nodeIds: [it.n.id], dx: axis === 'x' ? delta : 0, dy: axis === 'y' ? delta : 0 });
    }
    commit(commands, `distribute ${axis === 'x' ? 'horizontally' : 'vertically'}`);
  };

  const tidyAxis: Axis = count >= 2
    ? (() => { const b = union(selected.map(boxOf)); return b.width >= b.height ? 'x' : 'y'; })()
    : 'x';

  /* ── order ────────────────────────────────────────────────────────────── */
  const order = (op: 'front' | 'forward' | 'backward' | 'back') => {
    if (count === 0) return;
    const ids = nodes.map(n => n.id);
    const sel = new Set(selected.map(n => n.id));
    const target = targetOrder(ids, sel, op);
    const commands = orderCommands(nodes, artboard.id, selected.map(n => n.id), target);
    commit(commands, `bring ${op}`);
  };

  /* ── group ────────────────────────────────────────────────────────────── */
  const canGroup = count >= 2;
  const groupSel = count === 1 && (selected[0] as any)?.kind === 'group' ? (selected[0] as any) : null;

  const doGroup = () => {
    if (!canGroup) return;
    const groupId = uid('g');
    run({ type: 'group', artboardId: artboard.id, nodeIds: selected.map(n => n.id), groupId });
    dispatch({ type: 'select', ids: [groupId] });
  };
  const doUngroup = () => {
    if (!groupSel) return;
    const childIds = ((groupSel.children ?? []) as Node[]).map(c => c.id);
    run({ type: 'ungroup', artboardId: artboard.id, groupId: groupSel.id });
    dispatch({ type: 'select', ids: childIds });
  };

  /** One command goes out bare; several go out as a single undo step. */
  function commit(commands: Command[], label: string) {
    if (commands.length === 0) return;
    run(commands.length === 1 ? commands[0]! : { type: 'batch', label, commands });
  }

  /* ── copy ─────────────────────────────────────────────────────────────── */
  const alignHint =
    count === 0 ? 'Select an element to align it.'
    : count === 1 ? 'One element: aligns to the artboard.'
    : `${count} elements: aligns to the selection's bounding box.`;

  const needThree = `Select at least 3 elements to space them evenly (${count} selected).`;
  const tidyTitle = count < 3
    ? needThree
    : `Space the selection evenly ${tidyAxis === 'x' ? 'left to right' : 'top to bottom'} - its bounding box is ${tidyAxis === 'x' ? 'wider than it is tall' : 'taller than it is wide'}.`;

  return (
    <div className="arr">
      <section className="section">
        <h3>Align</h3>
        <div className="arr-grid arr-grid-6">
          {ALIGN_BUTTONS.map(([edge, label]) => (
            <button key={edge} className="arr-btn" aria-label={label} title={label}
                    disabled={count === 0} onClick={() => align(edge)}>
              <Glyph name={edge} />
            </button>
          ))}
        </div>
        <p className="arr-hint">{alignHint}</p>
      </section>

      <section className="section">
        <h3>Distribute</h3>
        <div className="arr-grid arr-grid-3">
          <button className="arr-btn" aria-label="Distribute horizontally"
                  title={count < 3 ? needThree : 'Even horizontal gaps; the leftmost and rightmost stay put.'}
                  disabled={count < 3} onClick={() => distribute('x')}>
            <Glyph name="distX" />
          </button>
          <button className="arr-btn" aria-label="Distribute vertically"
                  title={count < 3 ? needThree : 'Even vertical gaps; the topmost and bottommost stay put.'}
                  disabled={count < 3} onClick={() => distribute('y')}>
            <Glyph name="distY" />
          </button>
          <button className="arr-btn" aria-label="Tidy: space evenly along the longer axis"
                  title={tidyTitle} disabled={count < 3} onClick={() => distribute(tidyAxis)}>
            <Glyph name="tidy" />
          </button>
        </div>
      </section>

      <section className="section">
        <h3>Order</h3>
        <div className="arr-grid arr-grid-4">
          {ORDER_BUTTONS.map(([op, label]) => (
            <button key={op} className="arr-btn" aria-label={label} title={label}
                    disabled={count === 0} onClick={() => order(op)}>
              <Glyph name={op} />
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <h3>Group</h3>
        <div className="btn-grid">
          <button className="btn" disabled={!canGroup} onClick={doGroup}
                  title={canGroup ? 'Combine the selection into one group' : 'Select 2 or more elements to group them.'}>
            Group
          </button>
          <button className="btn" disabled={!groupSel} onClick={doUngroup}
                  title={groupSel ? 'Release the group back into separate elements' : 'Select exactly one group to ungroup it.'}>
            Ungroup
          </button>
          <button className="btn" disabled={!count} onClick={() => flip('flipX')}
                  title={count ? 'Mirror the selection left-to-right' : 'Select something to flip.'}>Flip H</button>
          <button className="btn" disabled={!count} onClick={() => flip('flipY')}
                  title={count ? 'Mirror the selection top-to-bottom' : 'Select something to flip.'}>Flip V</button>
        </div>
      </section>
    </div>
  );
}

/* ── ordering ─────────────────────────────────────────────────────────────
 * `invert` on a batch inverts every sub-command against the doc as it was
 * BEFORE the batch ran, then replays those inverses in reverse. That is exact
 * for independent edits but wrong for a batch of `reorder`s, whose inverses
 * each recompute a from-index that the earlier inverses have already shifted.
 * remove-then-add is exact, given the right order:
 *     removes  descending by current index
 *     adds     ascending by target index
 * because the reversal turns that into removes, then adds ascending by
 * ORIGINAL index - the one order that re-inserts every node where it started.
 * A single mover needs none of this and goes out as a plain `reorder`.
 * ---------------------------------------------------------------------- */
function targetOrder(ids: string[], sel: Set<string>, op: 'front' | 'forward' | 'backward' | 'back'): string[] {
  if (op === 'front') return [...ids.filter(i => !sel.has(i)), ...ids.filter(i => sel.has(i))];
  if (op === 'back') return [...ids.filter(i => sel.has(i)), ...ids.filter(i => !sel.has(i))];
  const a = [...ids];
  if (op === 'forward') {
    for (let i = a.length - 2; i >= 0; i--) {
      if (sel.has(a[i]!) && !sel.has(a[i + 1]!)) { const t = a[i]!; a[i] = a[i + 1]!; a[i + 1] = t; }
    }
  } else {
    for (let i = 1; i < a.length; i++) {
      if (sel.has(a[i]!) && !sel.has(a[i - 1]!)) { const t = a[i]!; a[i] = a[i - 1]!; a[i - 1] = t; }
    }
  }
  return a;
}

function orderCommands(nodes: Node[], artboardId: string, moverIds: string[], target: string[]): Command[] {
  const cur = nodes.map(n => n.id);
  if (cur.every((id, i) => id === target[i])) return [];
  if (moverIds.length === 1) {
    return [{ type: 'reorder', artboardId, nodeId: moverIds[0]!, to: target.indexOf(moverIds[0]!) }];
  }
  const movers = moverIds
    .map(id => ({ node: nodes[cur.indexOf(id)]!, from: cur.indexOf(id), to: target.indexOf(id) }))
    .filter(m => m.node && m.from >= 0 && m.to >= 0);
  return [
    ...[...movers].sort((a, b) => b.from - a.from)
      .map((m): Command => ({ type: 'removeNode', artboardId, nodeId: m.node.id })),
    ...[...movers].sort((a, b) => a.to - b.to)
      .map((m): Command => ({ type: 'addNode', artboardId, node: m.node, index: m.to })),
  ];
}

/* ── icons ──────────────────────────────────────────────────────────────── */
const ALIGN_BUTTONS: Array<[Edge, string]> = [
  ['left', 'Align left'], ['centerX', 'Align horizontal centres'], ['right', 'Align right'],
  ['top', 'Align top'], ['middleY', 'Align vertical middles'], ['bottom', 'Align bottom'],
];
const ORDER_BUTTONS: Array<['front' | 'forward' | 'backward' | 'back', string]> = [
  ['front', 'Bring to front'], ['forward', 'Bring forward'],
  ['backward', 'Send backward'], ['back', 'Send to back'],
];

const RAIL = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, fill: 'none' };
const ARROW = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };

function Glyph({ name }: { name: string }) {
  return <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{BODY[name]}</svg>;
}

/** Every align glyph is a rail (what you align to) plus two bars of unequal length. */
const BODY: Record<string, React.ReactNode> = {
  left: <><path d="M2 2.5v11" {...RAIL} /><rect x="4" y="3.6" width="9" height="3.3" rx="1" /><rect x="4" y="9.1" width="5.5" height="3.3" rx="1" /></>,
  centerX: <><path d="M8 2.5v11" {...RAIL} /><rect x="3.5" y="3.6" width="9" height="3.3" rx="1" /><rect x="5.25" y="9.1" width="5.5" height="3.3" rx="1" /></>,
  right: <><path d="M14 2.5v11" {...RAIL} /><rect x="3" y="3.6" width="9" height="3.3" rx="1" /><rect x="6.5" y="9.1" width="5.5" height="3.3" rx="1" /></>,
  top: <><path d="M2.5 2h11" {...RAIL} /><rect x="3.6" y="4" width="3.3" height="9" rx="1" /><rect x="9.1" y="4" width="3.3" height="5.5" rx="1" /></>,
  middleY: <><path d="M2.5 8h11" {...RAIL} /><rect x="3.6" y="3.5" width="3.3" height="9" rx="1" /><rect x="9.1" y="5.25" width="3.3" height="5.5" rx="1" /></>,
  bottom: <><path d="M2.5 14h11" {...RAIL} /><rect x="3.6" y="3" width="3.3" height="9" rx="1" /><rect x="9.1" y="6.5" width="3.3" height="5.5" rx="1" /></>,

  distX: <><rect x="1.6" y="3" width="2.6" height="10" rx="1" /><rect x="6.7" y="3" width="2.6" height="10" rx="1" /><rect x="11.8" y="3" width="2.6" height="10" rx="1" /></>,
  distY: <><rect x="3" y="1.6" width="10" height="2.6" rx="1" /><rect x="3" y="6.7" width="10" height="2.6" rx="1" /><rect x="3" y="11.8" width="10" height="2.6" rx="1" /></>,
  tidy: <><rect x="1.4" y="2.5" width="2.4" height="11" rx="1" /><rect x="12.2" y="2.5" width="2.4" height="11" rx="1" /><path d="M5.6 8h4.8M5.6 8l1.8-1.8M5.6 8l1.8 1.8M10.4 8L8.6 6.2M10.4 8l-1.8 1.8" {...ARROW} /></>,

  front: <><path d="M2.5 2h11" {...RAIL} /><path d="M8 13.5V5.5M4.8 8.7L8 5.4l3.2 3.3" {...ARROW} /></>,
  forward: <><path d="M8 13.5V4.5M4.8 7.7L8 4.4l3.2 3.3" {...ARROW} /></>,
  backward: <><path d="M8 2.5v9M4.8 8.3L8 11.6l3.2-3.3" {...ARROW} /></>,
  back: <><path d="M2.5 14h11" {...RAIL} /><path d="M8 2.5v8M4.8 7.3L8 10.6l3.2-3.3" {...ARROW} /></>,
};
