/**
 * Throwaway proof harness for copy / cut / paste / duplicate / nudge / select-all.
 * Drives the real studio at localhost:5273 and asserts on the real DOM.
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:5273/';
const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1680, height: 1020 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const p = await ctx.newPage();

const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

let pass = 0, fail = 0;
const step = async (name, fn) => {
  try { const extra = await fn(); pass++; console.log(`  PASS  ${name}${extra ? ` :: ${extra}` : ''}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name} :: ${String(e.message).split('\n')[0]}`); }
  await p.mouse.move(4, 4).catch(() => {});
  await p.waitForTimeout(650);   // past the double-click window
};
const group = n => console.log(`\n— ${n} —`);
const eq = (a, x, tol, what) => { if (Math.abs(a - x) > tol) throw new Error(`${what}: got ${a}, want ${x}`); };

/* ── readers ──────────────────────────────────────────────────────────── */
const layerCount = () => p.locator('.layer').count();
/** id -> {x,y} in ARTBOARD units, derived from the paper's own scale. */
const snap = () => p.evaluate(() => {
  const paper = document.querySelector('.ab-paper');
  const pr = paper.getBoundingClientRect();
  const z = pr.width / parseFloat(paper.style.width);
  const out = {};
  for (const e of document.querySelectorAll('.ab-paper [data-node-id]')) {
    const r = e.getBoundingClientRect();
    out[e.dataset.nodeId] = { x: (r.x - pr.x) / z, y: (r.y - pr.y) / z, w: r.width / z, h: r.height / z };
  }
  return out;
});
const added = (before, after) => Object.keys(after).filter(k => !(k in before));
const gone = (before, after) => Object.keys(before).filter(k => !(k in after));
/** Exact x/y of a single selection, read off the inspector's Position fields. */
const position = async () => {
  const f = p.locator('.row', { hasText: 'Position' }).first().locator('input');
  return [Number(await f.nth(0).inputValue()), Number(await f.nth(1).inputValue())];
};

const pickTarget = () => p.evaluate(() => {
  const host = document.querySelector('.canvas-host').getBoundingClientRect();
  const M = 48;
  const cands = [...document.querySelectorAll('.ab-paper [data-node-id]')]
    .map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(r => r.w > 40 && r.h > 30 && r.x > host.x + M && r.y > host.y + M
                 && r.x + r.w < host.right - M && r.y + r.h < host.bottom - M)
    .sort((a, c) => c.w * c.h - a.w * a.h);
  for (const r of cands) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const top = document.elementFromPoint(cx, cy)?.closest('[data-node-id]');
    if (top) return { id: top.dataset.nodeId, cx, cy };
  }
  return null;
});
const selectOne = async () => {
  const t = await pickTarget();
  if (!t) throw new Error('no usable target node');
  await p.mouse.click(t.cx, t.cy);
  await p.waitForTimeout(250);
  if (!(await p.locator('.ab-overlay [data-handle]').count())) throw new Error('nothing got selected');
  return t;
};
const key = async (k, wait = 350) => { await p.keyboard.press(k); await p.waitForTimeout(wait); };

await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);

const N0 = await layerCount();
console.log(`\nstarting document: ${N0} top-level nodes`);

/* ── copy / paste ─────────────────────────────────────────────────────── */
group('copy & paste');
let pastedIds = [];
await step('copy one node, paste twice — two copies at +16 and +32', async () => {
  const t = await selectOne();
  const base = await snap();
  const src = base[t.id];
  if (!src) throw new Error('target vanished');
  const n0 = await layerCount();

  await key('Meta+c');
  await key('Meta+v', 500);
  const n1 = await layerCount();
  const s1 = await snap();
  const first = added(base, s1);
  if (n1 !== n0 + 1) throw new Error(`layers ${n0} -> ${n1} after first paste`);
  if (first.length !== 1) throw new Error(`${first.length} nodes appeared, want 1`);
  eq(s1[first[0]].x - src.x, 16, 1.5, 'paste 1 dx');
  eq(s1[first[0]].y - src.y, 16, 1.5, 'paste 1 dy');

  await key('Meta+v', 500);
  const n2 = await layerCount();
  const s2 = await snap();
  const second = added(s1, s2);
  if (n2 !== n0 + 2) throw new Error(`layers ${n1} -> ${n2} after second paste`);
  if (second.length !== 1) throw new Error(`${second.length} nodes appeared, want 1`);
  eq(s2[second[0]].x - src.x, 32, 1.5, 'paste 2 dx (cascade)');
  eq(s2[second[0]].y - src.y, 32, 1.5, 'paste 2 dy (cascade)');
  pastedIds = [first[0], second[0]];
  return `${n0} -> ${n1} -> ${n2} nodes`;
});

await step('the copies carry fresh ids', async () => {
  const ids = Object.keys(await snap());
  if (new Set(ids).size !== ids.length) throw new Error('duplicate ids in the document');
  return `${ids.length} painted nodes, all ids unique`;
});

await step('one paste is one undo step', async () => {
  const n0 = await layerCount();
  await key('Meta+z', 450);
  const n1 = await layerCount();
  if (n1 !== n0 - 1) throw new Error(`layers ${n0} -> ${n1}`);
  await key('Meta+Shift+z', 450);   // put it back for the next steps
  const n2 = await layerCount();
  if (n2 !== n0) throw new Error(`redo left ${n2}, want ${n0}`);
  return `${n0} -> ${n1} -> ${n2}`;
});

/* ── cut ──────────────────────────────────────────────────────────────── */
group('cut');
await step('cut removes the node; paste brings it back', async () => {
  const t = await selectOne();
  const before = await snap();
  const n0 = await layerCount();
  await key('Meta+x', 450);
  const n1 = await layerCount();
  const afterCut = await snap();
  if (n1 !== n0 - 1) throw new Error(`layers ${n0} -> ${n1} after cut`);
  if (!gone(before, afterCut).includes(t.id)) throw new Error('the cut node is still painted');
  await key('Meta+v', 500);
  const n2 = await layerCount();
  const afterPaste = await snap();
  if (n2 !== n0) throw new Error(`layers ${n1} -> ${n2} after paste`);
  const back = added(afterCut, afterPaste);
  if (back.length !== 1) throw new Error(`${back.length} nodes came back`);
  eq(afterPaste[back[0]].x - before[t.id].x, 16, 1.5, 'pasted-back dx');
  return `${n0} -> ${n1} -> ${n2}`;
});

/* ── duplicate ────────────────────────────────────────────────────────── */
group('duplicate');
await step('Cmd+D duplicates at +16, and again at +32', async () => {
  const t = await selectOne();
  const base = await snap();
  const src = base[t.id];
  const n0 = await layerCount();
  await key('Meta+d', 450);
  const s1 = await snap();
  const a1 = added(base, s1);
  if (a1.length !== 1) throw new Error(`${a1.length} appeared on first duplicate`);
  eq(s1[a1[0]].x - src.x, 16, 1.5, 'duplicate 1 dx');
  await key('Meta+d', 450);
  const s2 = await snap();
  const a2 = added(s1, s2);
  if (a2.length !== 1) throw new Error(`${a2.length} appeared on second duplicate`);
  eq(s2[a2[0]].x - src.x, 32, 1.5, 'duplicate 2 dx (cascades off the new selection)');
  const n2 = await layerCount();
  if (n2 !== n0 + 2) throw new Error(`layers ${n0} -> ${n2}`);
  return `${n0} -> ${n2} nodes`;
});

await step('duplicate does not disturb the system clipboard', async () => {
  const text = await p.evaluate(() => navigator.clipboard.readText());
  if (!text.includes('artboard/nodes')) throw new Error('clipboard no longer holds our payload');
  return 'clipboard still holds the earlier copy';
});

/* ── nudge ────────────────────────────────────────────────────────────── */
group('nudge');
await step('five taps of ArrowRight move 5px and undo ONCE restores them all', async () => {
  await selectOne();
  const [x0, y0] = await position();
  for (let i = 0; i < 5; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(70); }
  await p.waitForTimeout(700);                     // let the burst close
  const [x1, y1] = await position();
  eq(x1 - x0, 5, 0.01, 'after 5 nudges dx');
  eq(y1 - y0, 0, 0.01, 'after 5 nudges dy');
  await key('Meta+z', 500);
  const [x2, y2] = await position();
  eq(x2, x0, 0.01, 'x after a single undo');
  eq(y2, y0, 0.01, 'y after a single undo');
  return `x ${x0} -> ${x1} -> ${x2} (one undo)`;
});

await step('Shift+Arrow nudges 10px, and that burst is also one undo', async () => {
  const [x0, y0] = await position();
  for (let i = 0; i < 3; i++) { await p.keyboard.press('Shift+ArrowDown'); await p.waitForTimeout(70); }
  await p.waitForTimeout(700);
  const [x1, y1] = await position();
  eq(y1 - y0, 30, 0.01, 'after 3 shift-nudges dy');
  await key('Meta+z', 500);
  const [x2, y2] = await position();
  eq(y2, y0, 0.01, 'y after a single undo');
  return `y ${y0} -> ${y1} -> ${y2}`;
});

await step('a nudge burst is flushed before an unrelated key', async () => {
  // Nudge twice, then hit undo straight away with no idle gap. The burst must
  // already be its own history entry by the time undo is handled, so the undo
  // lands on the nudge itself and puts the node exactly back.
  await selectOne();
  const [x0, y0] = await position();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(60);           // well under the 400ms idle timer
  const [x1] = await position();
  eq(x1 - x0, 2, 0.01, 'two nudges applied');
  await key('Meta+z', 500);
  const [x2, y2] = await position();
  eq(x2, x0, 0.01, 'x after undoing a burst that had not idled out');
  eq(y2, y0, 0.01, 'y untouched');
  return `x ${x0} -> ${x1} -> ${x2}`;
});

/* ── select all, deselect, delete ─────────────────────────────────────── */
group('select all / escape / delete');
await step('Cmd+A selects everything, Delete clears the page, one undo restores it', async () => {
  const n0 = await layerCount();
  await p.mouse.click(20, 500);         // focus the canvas area
  await p.waitForTimeout(200);
  await key('Meta+a', 350);
  const boxes = await p.locator('.ab-overlay rect[stroke="#4f46e5"]').count();
  if (boxes < n0) throw new Error(`${boxes} selection boxes for ${n0} nodes`);
  await key('Delete', 450);
  const n1 = await layerCount();
  if (n1 !== 0) throw new Error(`${n1} nodes left after deleting everything`);
  await key('Meta+z', 600);
  const n2 = await layerCount();
  if (n2 !== n0) throw new Error(`undo restored ${n2} of ${n0}`);
  return `${n0} -> 0 -> ${n2} nodes (${boxes} selection boxes)`;
});

await step('Escape clears the selection', async () => {
  await selectOne();
  await key('Escape', 300);
  const handles = await p.locator('.ab-overlay [data-handle]').count();
  if (handles !== 0) throw new Error(`${handles} handles still showing`);
  return 'no handles remain';
});

/* ── across pages ─────────────────────────────────────────────────────── */
group('across pages');
await step('paste lands on the page that is open', async () => {
  const t = await selectOne();
  await key('Meta+c', 300);
  await p.locator('.pagechip', { hasText: '+ Page' }).click();
  await p.waitForTimeout(500);
  const empty = await layerCount();
  if (empty !== 0) throw new Error(`new page already had ${empty} nodes`);
  await p.mouse.click(20, 500);
  await p.waitForTimeout(150);
  await key('Meta+v', 600);
  const n = await layerCount();
  if (n !== 1) throw new Error(`page 2 has ${n} nodes after paste, want 1`);
  return `page 2: 0 -> ${n} node`;
});

/* ── defensive parsing ────────────────────────────────────────────────── */
group('untrusted clipboard content');
await step('plain text becomes a text node', async () => {
  await p.evaluate(() => navigator.clipboard.writeText('Pasted from somewhere else'));
  const n0 = await layerCount();
  await key('Meta+v', 600);
  const n1 = await layerCount();
  if (n1 !== n0 + 1) throw new Error(`layers ${n0} -> ${n1}`);
  const txt = await p.locator('.ab-paper text').filter({ hasText: 'Pasted from somewhere else' }).count();
  if (!txt) throw new Error('no text node carrying the pasted string');
  return `${n0} -> ${n1}, text painted`;
});

await step('a bad node inside our envelope is dropped, the good one survives', async () => {
  await p.evaluate(() => navigator.clipboard.writeText(JSON.stringify({
    'artboard/nodes': 1,
    nodes: [
      { kind: 'rect', id: 'COLLIDE', name: 'ok', x: 40, y: 40, width: 120, height: 90 },
      { kind: 'wat', id: 'bad' },
      { kind: 'rect' },
    ],
  })));
  const n0 = await layerCount();
  await key('Meta+v', 600);
  const n1 = await layerCount();
  if (n1 !== n0 + 1) throw new Error(`layers ${n0} -> ${n1}; only the valid node should land`);
  if (await p.locator('[data-node-id="COLLIDE"]').count()) throw new Error('the payload id was used verbatim');
  return `${n0} -> ${n1}, id regenerated`;
});

await step('a payload from a newer version is ignored, not guessed at', async () => {
  await p.evaluate(() => navigator.clipboard.writeText(JSON.stringify({
    'artboard/nodes': 99, nodes: [{ kind: 'rect', id: 'z', x: 0, y: 0, width: 10, height: 10 }],
  })));
  const n0 = await layerCount();
  await key('Meta+v', 600);
  const n1 = await layerCount();
  // Not our envelope any more -> it is just text, so a text node is the only
  // acceptable outcome. What must NOT happen is the rect landing.
  if (await p.locator('[data-node-id="z"]').count()) throw new Error('a v99 node was pasted');
  return `${n0} -> ${n1}, no v99 node entered the document`;
});

/* ── typing must never trigger any of this ────────────────────────────── */
group('typing guard');
await step('shortcuts stay quiet while a field is focused', async () => {
  await selectOne();
  const n0 = await layerCount();
  const f = p.locator('.row', { hasText: 'Position' }).first().locator('input').first();
  await f.click();
  await p.waitForTimeout(200);
  await p.keyboard.press('Meta+d');
  await p.keyboard.press('Meta+a');
  await p.keyboard.press('ArrowUp');
  await p.waitForTimeout(400);
  const n1 = await layerCount();
  if (n1 !== n0) throw new Error(`layers ${n0} -> ${n1} while typing in a field`);
  return `${n0} nodes, unchanged`;
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errs.length) console.log('page errors:\n' + errs.slice(0, 12).map(e => '  ' + e).join('\n'));
await b.close();
process.exit(fail || errs.length ? 1 : 0);
