#!/usr/bin/env node
/**
 * Regenerates `tests/golden/insert-data.json` — the fixture that baselines what
 * the Elements panel's Chart / QR / Barcode inserts actually produce.
 *
 *   node tools/make-insert-fixture.mjs          # from the repo root
 *   npm run golden -- --update                  # then re-bake the SVG baseline
 *
 * Committed rather than left in a scratch directory because it is the ONLY way
 * to reproduce that fixture through the real insert path. Without it the JSON
 * becomes hand-maintained, and a hand-maintained artefact drifts from the code
 * it claims to describe — the same failure the golden oracle exists to catch,
 * arriving through the back door. It is also how you restore the fixture after
 * deliberately mutating it to check the assertions still bite: re-run this, not
 * `git checkout`, which would discard anything else uncommitted in the file.
 *
 * ── two constraints that are not obvious ──────────────────────────────────
 * IDS ARE HAND-WRITTEN, deliberately. The editor mints them with `uid`, which
 * is `Math.random()`-based, so letting the real path assign them would make the
 * fixture unreproducible and the golden churn on every run. The stamps below
 * stand in for minted ids; everything else follows `useInsertGroup` exactly —
 * re-mint through `buildNode`, `addNode` each, the real `group` command, then
 * `updateNode` for the name.
 *
 * PLACEMENT IS DELIBERATE AND INDEPENDENT of the panel's. All three generators
 * centre their output on the artboard, so emitting them as the panel does would
 * stack them and the render would be unreadable to whoever is looking at a
 * drift. Each gets its own cell here. Do not "fix" this to match the panel.
 *
 * ── regenerating the assertion constants ──────────────────────────────────
 * `tests/insert-data.test.ts` pins two constants this script does not produce:
 * the EAN-13 bit string (re-derivable by hand from the spec, or from
 * python-barcode) and the QR module grid, whose authority is a one-off cv2
 * decode recorded in that file. Changing a payload here means regenerating the
 * matching constant there — the QR one needs a decoder present.
 */
import { register } from 'tsx/esm/api';
register();
const { buildNode, loadDocument } = await import('../packages/schema/src/index.ts');
const { apply } = await import('../packages/commands/src/index.ts');
const { buildChart } = await import('../packages/charts/src/index.ts');
const { qrNode, barcodeNode } = await import('../packages/codes/src/index.ts');
const { writeFileSync } = await import('node:fs');

// Each element is sized exactly as InsertData sizes it for an artboard of one
// CELL, then placed in its own cell so the three don't stack.
const CELL_W = 440, CELL_H = 300, GAP = 20;
const cellX = (i) => GAP + i * (CELL_W + GAP);

const chartW = Math.round(CELL_W * 0.72), chartH = Math.round(chartW * 0.66);
const qrSize = Math.round(CELL_W * 0.34);
const barW = Math.round(CELL_W * 0.6), barH = Math.round(barW * 0.4);

const batches = [
  { stamp: 'n_chart001', name: 'Quarterly revenue', nodes: buildChart({
      kind: 'bar', labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [{ name: 'Revenue', values: [42, 68, 55, 91] }],
      title: 'Quarterly revenue', width: chartW, height: chartH,
      x: cellX(0) + Math.round((CELL_W - chartW) / 2),
      y: Math.round((CELL_H - chartH) / 2) }) },
  { stamp: 'n_qrcode01', name: 'QR code', nodes: qrNode({
      text: 'https://artboard.dev', ec: 'M', size: qrSize, light: '#ffffff',
      x: cellX(1) + Math.round((CELL_W - qrSize) / 2),
      y: Math.round((CELL_H - qrSize) / 2) }) },
  { stamp: 'n_barcode1', name: 'EAN-13 barcode', nodes: barcodeNode({
      text: '590123412345', symbology: 'ean13', width: barW, height: barH, showText: true,
      x: cellX(2) + Math.round((CELL_W - barW) / 2),
      y: Math.round((CELL_H - barH) / 2) }) },
];

let doc = loadDocument({
  version: 1, id: 'insert-data', name: 'Insert Data',
  artboards: [{ id: 'ab-1', name: 'Insert Data',
    width: GAP + 3 * (CELL_W + GAP), height: CELL_H,
    background: { kind: 'solid', color: '#ffffff' }, nodes: [] }],
  assets: {}, diagnostics: [],
}).doc;

// Mirrors useInsertGroup: re-mint through buildNode with sequential ids, add
// each node, group them with the real `group` command, rename the group.
for (const b of batches) {
  let seq = 0;
  const remint = (list) => list.map((n) => buildNode({
    ...n, id: `${b.stamp}-${seq++}`,
    ...(n.kind === 'group' ? { children: remint(n.children ?? []) } : {}),
  }));
  const nodes = remint(b.nodes);
  const groupId = `${b.stamp}-g`;
  for (const node of nodes) doc = apply(doc, { type: 'addNode', artboardId: 'ab-1', node });
  doc = apply(doc, { type: 'group', artboardId: 'ab-1', nodeIds: nodes.map((n) => n.id), groupId });
  doc = apply(doc, { type: 'updateNode', nodeId: groupId, patch: { name: b.name } });
}

const reloaded = loadDocument(JSON.parse(JSON.stringify(doc)));
if (reloaded.diagnostics.length) { console.error('diagnostics:', reloaded.diagnostics); process.exit(1); }
writeFileSync('tests/golden/insert-data.json', JSON.stringify(reloaded.doc, null, 1) + '\n');
console.log('artboard', reloaded.doc.artboards[0].width, 'x', reloaded.doc.artboards[0].height);
console.log('top-level nodes:', reloaded.doc.artboards[0].nodes.map((n) => `${n.id}(${n.kind},${n.name})`).join(' '));
