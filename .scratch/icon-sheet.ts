/**
 * Contact sheet for @artboard/icons.
 *
 * Renders every bundled icon and shape through the REAL pipeline — buildNode →
 * renderArtboard → serialize — so what lands on the page is exactly what the
 * editor and the CLI would paint. Eyeballing 400 tiles at once is the only way
 * to catch a fill/stroke mix-up or a mangled subpath before it reaches a user;
 * clicking twelve of them cannot.
 */
import { writeFileSync } from 'node:fs';
import { buildNode, loadDocument } from '@artboard/schema';
import { renderArtboard, serialize } from '@artboard/render-svg';
import { ICONS, SHAPES, iconNodeStyle, shapeNodeStyle, ICON_CATEGORIES } from '@artboard/icons';

const CELL = 64, PAD = 14, COLS = 24, TOP = 40;
const rows = Math.ceil(ICONS.length / COLS) + Math.ceil(SHAPES.length / COLS) + 2;

const nodes: unknown[] = [];
let i = 0;
const place = (d: string, style: Record<string, unknown>, name: string) => {
  const col = i % COLS, row = Math.floor(i / COLS);
  nodes.push(buildNode({
    id: `n${i}`, kind: 'path', name,
    x: PAD + col * CELL, y: TOP + PAD + row * CELL,
    width: CELL - PAD * 2, height: CELL - PAD * 2,
    d, ...style,
  }));
  i++;
};

for (const icon of ICONS) place(icon.d, iconNodeStyle('#111827'), icon.name);
i = Math.ceil(i / COLS) * COLS + COLS;                  // blank row between the two catalogues
for (const s of SHAPES) place(s.d, shapeNodeStyle('#4f46e5'), s.name);

const doc = loadDocument({
  version: 3, id: 'sheet', name: 'Icon sheet',
  artboards: [{
    id: 'ab', name: 'Sheet',
    width: PAD * 2 + COLS * CELL, height: TOP + PAD * 2 + rows * CELL,
    background: { kind: 'solid', color: '#ffffff' },
    nodes,
  }],
  assets: {}, diagnostics: [],
}).doc;

const ab = doc.artboards[0]!;
const { scene, diagnostics } = renderArtboard(doc, ab);
writeFileSync('.scratch/icon-sheet.svg', serialize(scene));
console.log(`${ICONS.length} icons + ${SHAPES.length} shapes -> .scratch/icon-sheet.svg (${ab.width}x${ab.height})`);
console.log(`categories: ${ICON_CATEGORIES.map(c => c.label).join(', ')}`);
if (diagnostics.length) console.log('diagnostics:', diagnostics);
