import { writeFileSync } from 'node:fs';
import { Document, buildNode } from '@artboard/schema';
import { renderToString } from '@artboard/render-svg';

// circle-alert, straight from Lucide: the exclamation dot is a zero-length segment.
const ALERT = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M12 8v4 M12 16h.01';
const CHEVRON = 'M6 4 L14 12 L6 20';

const mk = (id: string, x: number, d: string, stroke: any) => buildNode({
  id, kind: 'path', x, y: 30, width: 120, height: 120, viewBox: [24, 24], d,
  fill: { kind: 'none' }, stroke,
});

const doc = Document.parse({ id: 'caps', name: 'caps', artboards: [{
  id: 'ab', width: 560, height: 200, background: { kind: 'solid', color: '#ffffff' },
  nodes: [
    mk('a1', 20, ALERT, { color: '#111111', width: 2 }),                              // default butt/miter
    mk('a2', 160, ALERT, { color: '#111111', width: 2, cap: 'round', join: 'round' }), // Lucide's intent
    mk('a3', 300, CHEVRON, { color: '#111111', width: 3 }),                            // miter join
    mk('a4', 420, CHEVRON, { color: '#111111', width: 3, cap: 'round', join: 'round' }),
  ],
}]});
const { svg } = renderToString(doc);
writeFileSync('.scratch/screens/caps.svg', svg);
console.log(svg.split('\n').filter(l => l.includes('<path')).join('\n'));
