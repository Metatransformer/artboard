import { loadDocument } from '../packages/schema/src/index';
import { renderToString } from '../packages/render-svg/src/index';

const node = (i: number, effects: any[], label: string) => ([
  { id: `t${i}`, kind: 'text', name: label, x: 40 + (i % 3) * 320, y: 60 + Math.floor(i / 3) * 200,
    width: 280, height: 90, text: label, fontSize: 46, fontWeight: 800, color: '#ffffff',
    align: 'center', effects },
]);

const cases: Array<[string, any[]]> = [
  ['Shadow', [{ kind: 'shadow', x: 6, y: 8, blur: 10, spread: 0, color: '#000000', opacity: 0.5 }]],
  ['Glow', [{ kind: 'glow', blur: 16, color: '#38bdf8', opacity: 0.9 }]],
  ['Outline', [{ kind: 'outline', width: 4, color: '#f43f5e' }]],
  ['Echo', [{ kind: 'echo', dx: 8, dy: 8, count: 3, color: '#a855f7', opacity: 0.5 }]],
  ['Blur', [{ kind: 'blur', radius: 3 }]],
  ['Plate', [{ kind: 'background', color: '#f59e0b', padding: 14, radius: 10, opacity: 1 }]],
  ['Curve up', [{ kind: 'curve', amount: 60 }]],
  ['Duotone', [{ kind: 'duotone', dark: '#312e81', light: '#fbbf24' }]],
  ['Vignette', [{ kind: 'vignette', amount: 80, color: '#000000' }]],
];

const nodes = cases.flatMap(([label, fx], i) => node(i, fx, label));
const { doc } = loadDocument({
  version: 1, id: 'd', name: 'fx',
  artboards: [{ id: 'ab', name: 'fx', width: 1000, height: 700, background: { kind: 'solid', color: '#111827' }, nodes }],
  assets: {}, diagnostics: [],
});
const { svg, diagnostics } = renderToString(doc, 0);
console.log(svg);
console.error('diagnostics:', diagnostics.length);
