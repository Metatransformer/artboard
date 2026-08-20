import { loadDocument } from '../packages/schema/src/index';
import { renderToString } from '../packages/render-svg/src/index';
const mk = (i: number, amount: number, align: string) => ({
  id: `c${i}`, kind: 'text', x: 60, y: 40 + i * 160, width: 680, height: 120,
  text: 'CURVED TEXT', fontSize: 54, fontWeight: 800, color: '#111827',
  align, effects: [{ kind: 'curve', amount }],
});
const nodes = [mk(0, 50, 'center'), mk(1, -50, 'center'), mk(2, 0, 'center')];
const { doc } = loadDocument({ version: 1, id: 'd', name: 'c',
  artboards: [{ id: 'ab', name: 'c', width: 800, height: 520, background: { kind: 'solid', color: '#ffffff' }, nodes }],
  assets: {}, diagnostics: [] });
console.log(renderToString(doc, 0).svg);
