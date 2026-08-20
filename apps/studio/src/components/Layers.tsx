import React from 'react';
import type { Node } from '@artboard/schema';
import { useEditor } from '../state/store';

/**
 * Layers is document STATE, not a content source. It belongs in the persistent
 * right dock next to Properties, never in a tab strip that swaps it out for the
 * template browser - you need to see your stack while you are placing things.
 */
export function Layers() {
  const { state, dispatch, run, artboard } = useEditor();
  const nodes = artboard.nodes as Node[];

  const move = (id: string, to: number) => run({ type: 'reorder', artboardId: artboard.id, nodeId: id, to });

  if (nodes.length === 0) {
    return <div className="hint pad">Nothing on this page yet. Add something from Elements.</div>;
  }

  return (
    <div className="layers">
      {[...nodes].reverse().map((n, ri) => {
        const idx = nodes.length - 1 - ri;
        const a = n as any;
        const on = state.selection.includes(n.id);
        return (
          <div
            key={n.id}
            className={`layer ${on ? 'on' : ''} ${a.visible === false ? 'off' : ''}`}
            onClick={e => dispatch({ type: 'select', ids: e.shiftKey ? [...state.selection, n.id] : [n.id] })}
          >
            <button
              className="lvis"
              title={a.visible === false ? 'Show' : 'Hide'}
              aria-label={a.visible === false ? 'Show layer' : 'Hide layer'}
              onClick={e => { e.stopPropagation(); run({ type: 'updateNode', nodeId: n.id, patch: { visible: a.visible === false } }); }}
            >
              <Eye off={a.visible === false} />
            </button>
            <LayerThumb node={a} />
            <span className="lname">{a.name || (a.kind === 'text' ? String(a.text).slice(0, 28) : a.kind)}</span>
            <span className="lactions">
              <button className="licon" title="Bring forward" disabled={idx === nodes.length - 1}
                      onClick={e => { e.stopPropagation(); move(n.id, idx + 1); }}>
                <svg viewBox="0 0 16 16"><path d="M8 12V4m0 0L4.5 7.5M8 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <button className="licon" title="Send backward" disabled={idx === 0}
                      onClick={e => { e.stopPropagation(); move(n.id, idx - 1); }}>
                <svg viewBox="0 0 16 16"><path d="M8 4v8m0 0l3.5-3.5M8 12L4.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <button className="licon" title={a.locked ? 'Unlock' : 'Lock'}
                      onClick={e => { e.stopPropagation(); run({ type: 'updateNode', nodeId: n.id, patch: { locked: !a.locked } }); }}>
                <Lock on={!!a.locked} />
              </button>
              <button className="licon danger" title="Delete"
                      onClick={e => { e.stopPropagation(); run({ type: 'removeNode', artboardId: artboard.id, nodeId: n.id }); }}>
                <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A tiny glyph per node kind reads faster than the word "ellipse". */
function LayerThumb({ node }: { node: any }) {
  const fill = node.fill?.kind === 'solid' ? node.fill.color : node.fill?.kind === 'gradient' ? node.fill.stops?.[0]?.color ?? '#888' : '#888';
  return (
    <span className="lthumb" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        {node.kind === 'text' ? <path d="M3 4h10M8 4v9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          : node.kind === 'ellipse' ? <circle cx="8" cy="8" r="5.5" fill={fill} />
          : node.kind === 'line' ? <path d="M3 13L13 3" stroke={fill} strokeWidth="2" strokeLinecap="round" />
          : node.kind === 'image' ? <><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M4 11l3-3 2.5 2.5L11 9l1 1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>
          : node.kind === 'path' ? <path d={node.d} fill={fill} transform={`scale(${16 / (node.viewBox?.[0] ?? 16)})`} />
          : <rect x="2.5" y="2.5" width="11" height="11" rx={node.radius ? 3 : 1} fill={fill} />}
      </svg>
    </span>
  );
}

const Eye = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 16 16">
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="8" r="1.9" fill="currentColor" />
    {off && <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
  </svg>
);

const Lock = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 16 16">
    <rect x="4" y="7" width="8" height="6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d={on ? 'M6 7V5.5a2 2 0 014 0V7' : 'M6 7V5.5a2 2 0 013.8-.9'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
