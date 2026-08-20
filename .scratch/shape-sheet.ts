import { writeFileSync } from 'node:fs';
import { buildNode, loadDocument } from '@artboard/schema';
import { renderArtboard, serialize } from '@artboard/render-svg';
import { SHAPES, ICONS, iconNodeStyle, shapeNodeStyle } from '@artboard/icons';

const CELL = 150, PAD = 18, COLS = 8;
const detail = ['circle-alert', 'circle-help', 'info', 'triangle-alert', 'message-circle', 'wifi', 'more-horizontal', 'ellipsis'];
const picks = ICONS.filter(i => detail.includes(i.id));
const items = [
  ...SHAPES.map(s => ({ d: s.d, style: shapeNodeStyle('#4f46e5'), name: s.name })),
  ...picks.map(i => ({ d: i.d, style: iconNodeStyle('#111827'), name: i.name })),
];
const rows = Math.ceil(items.length / COLS);
const nodes = items.map((it, i) => buildNode({
  id: `n${i}`, kind: 'path', name: it.name,
  x: PAD + (i % COLS) * CELL, y: PAD + Math.floor(i / COLS) * CELL,
  width: CELL - PAD * 2, height: CELL - PAD * 2, d: it.d, ...it.style,
}));
const doc = loadDocument({ version: 3, id: 's', name: 's', artboards: [{ id: 'ab', name: 'a',
  width: PAD * 2 + COLS * CELL, height: PAD * 2 + rows * CELL,
  background: { kind: 'solid', color: '#ffffff' }, nodes }], assets: {}, diagnostics: [] }).doc;
const ab = doc.artboards[0]!;
writeFileSync('.scratch/shape-sheet.svg', serialize(renderArtboard(doc, ab).scene));
console.log(items.map(i => i.name).join(' | '));
