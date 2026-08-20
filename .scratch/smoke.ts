import { loadDocument } from '../packages/schema/src/index';
import { renderToString } from '../packages/render-svg/src/index';
import { apply, invert, commit, undo, redo, emptyHistory } from '../packages/commands/src/index';

const doc = loadDocument({
  version: 1, id: 'd1', name: 'Smoke',
  artboards: [{ id: 'a1', name: 'A', width: 400, height: 300,
    background: { kind: 'gradient', angle: 135, stops: [{offset:0,color:'#6366f1'},{offset:1,color:'#ec4899'}] },
    nodes: [
      { id: 'r1', kind: 'rect', x: 20, y: 20, width: 120, height: 80, radius: 12, rotation: 15,
        fill: { kind: 'solid', color: '#ffffff' } },
      { id: 't1', kind: 'text', x: 20, y: 140, width: 360, height: 120,
        text: 'Hello & <world>\nsecond line that is long enough to wrap somewhere around here',
        fontSize: 24, fontWeight: 700, color: '#111111', align: 'left' },
      { id: 'i1', kind: 'image', x: 200, y: 20, width: 100, height: 100, assetId: 'nope' },
      { id: 'x1', kind: 'opaque', x: 0, y: 0, width: 10, height: 10, originalKind: 'future-thing', raw: { a: 1 } },
    ] }],
  assets: {}, diagnostics: [],
}).doc;

const a = renderToString(doc, 0), b = renderToString(doc, 0), c = renderToString(doc, 0);
console.log('DETERMINISTIC:', a.svg === b.svg && b.svg === c.svg);
console.log('DIAGNOSTICS:', a.diagnostics.map(d => d.code).join(', '));
console.log('has gradient def:', a.svg.includes('<linearGradient'));
console.log('has rotate:', a.svg.includes('rotate(15'));
console.log('escaped text:', a.svg.includes('&amp;') && a.svg.includes('&lt;world&gt;'));
console.log('opaque not drawn:', !a.svg.includes('future-thing'));
console.log('--- svg head ---');
console.log(a.svg.split('\n').slice(0, 6).join('\n'));

// command round-trip
let h = emptyHistory(); let d2 = doc;
const cmd = { type: 'updateNode', nodeId: 'r1', patch: { x: 999, y: 888 } } as any;
const r1 = commit(d2, h, cmd);
const back = undo(r1.doc, r1.history);
console.log('UNDO RESTORES:', JSON.stringify(back.doc) === JSON.stringify(doc));
const fwd = redo(back.doc, back.history);
console.log('REDO REAPPLIES:', JSON.stringify(fwd.doc) === JSON.stringify(r1.doc));
