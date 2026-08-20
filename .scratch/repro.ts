import { loadDocument } from '../packages/schema/src/index';
const r = loadDocument({ id: 'd', name: 'x', version: 1, artboards: [{ id: 'a', name: 'A', width: 100, height: 100, background: { kind: 'solid', color: '#fff' }, nodes: [
  { id: 'r', kind: 'rect', name: 'r', x: 0, y: 0, width: 10, height: 10 },
  { id: 'g', kind: 'group', name: 'g', x: 0, y: 0, width: 50, height: 50, children: [
    { id: 'c', kind: 'ellipse', name: 'c', x: 0, y: 0, width: 5, height: 5 } ] },
] }], assets: {}, diagnostics: [] });
const ns = r.doc.artboards[0]!.nodes as any[];
console.log('parsed OK — top-level nodes:', ns.length, '| kinds:', ns.map(n => n.kind).join(','));
console.log('nested group child kind:', ns[1].children[0].kind);
