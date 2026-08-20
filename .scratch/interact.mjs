/**
 * End-to-end proof harness for the Artboard studio shell.
 *
 * This drives the real app in a real browser and asserts on what actually
 * happened to the DOM. It is the thing that catches "typechecks, builds, and
 * is broken" — so it targets user-visible outcomes (the canvas repainted, the
 * node moved, the file came back after a reload), never internal state.
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:5273/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1020 }, deviceScaleFactor: 2 });

const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

let pass = 0, fail = 0;
const step = async (name, fn) => {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name} :: ${String(e.message).split('\n')[0]}`); }
  // Two clicks on the same node inside the double-click window open the text
  // editor instead of starting a drag. Park the pointer away and wait past the
  // threshold so each step exercises what it says it does. Deliberately NOT an
  // Escape: that would clear the selection later steps depend on.
  await p.mouse.move(4, 4).catch(() => {});
  await p.waitForTimeout(650);
};
const group = n => console.log(`\n— ${n} —`);

/* ── helpers ──────────────────────────────────────────────────────────── */
const rail = name => p.locator('.rail .railbtn', { hasText: name });
const openRail = async name => {
  // The Design drawer is open at load, so clicking its own button would close
  // it. Only click when this section is not already the open one.
  const head = await p.locator('.drawer .drawer-head').first().innerText().catch(() => '');
  if (!head.toLowerCase().includes(name.toLowerCase())) {
    await rail(name).click();
    await p.waitForTimeout(340);
  }
  if (!(await p.locator('.drawer').count())) throw new Error(`drawer did not open for ${name}`);
};
const svgHTML = () => p.locator('.ab-paper svg').innerHTML();
const nodeCount = () => p.locator('.ab-paper [data-node-id]').count();

/**
 * Aim at a real painted node with room around it.
 *
 * The id we return is whatever is actually TOPMOST at the point we will click,
 * not the node whose box we measured: designs stack, and clicking the centre
 * of a big card often grabs the label sitting on it. Asserting against the
 * node we aimed at rather than the one we grabbed reports a phantom bug.
 */
const pickTarget = () => p.evaluate(() => {
  const host = document.querySelector('.canvas-host').getBoundingClientRect();
  const M = 48;
  const candidates = [...document.querySelectorAll('.ab-paper [data-node-id]')]
    .map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(r => r.w > 40 && r.h > 30 && r.x > host.x + M && r.y > host.y + M
                 && r.x + r.w < host.right - M && r.y + r.h < host.bottom - M)
    .sort((a, c) => c.w * c.h - a.w * a.h);
  for (const r of candidates) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const top = document.elementFromPoint(cx, cy)?.closest('[data-node-id]');
    if (top) return { id: top.dataset.nodeId, cx, cy };
  }
  return null;
});

await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);

/* ── shell ────────────────────────────────────────────────────────────── */
group('shell');
await step('all four zones render', async () => {
  for (const sel of ['.toolbar, header', '.rail', '.canvas-host', '.dock', '.pagebar, footer']) {
    if (!(await p.locator(sel).first().count())) throw new Error(`missing ${sel}`);
  }
});
await step('artboard fits its viewport', async () => {
  const r = await p.evaluate(() => {
    const a = document.querySelector('.ab-paper').getBoundingClientRect();
    const c = document.querySelector('.canvas-host').getBoundingClientRect();
    return { fits: a.width <= c.width + 1 && a.height <= c.height + 1, a: [a.width | 0, a.height | 0], c: [c.width | 0, c.height | 0] };
  });
  if (!r.fits) throw new Error(`artboard ${r.a} overflows host ${r.c}`);
});
await step('layers and properties are visible at the same time', async () => {
  // This is the whole point of the IA rebuild: document state and selection
  // properties are no longer mutually exclusive tabs.
  const layers = await p.locator('.layers').isVisible();
  const props = await p.locator('.dockpanel.grow').isVisible();
  if (!layers || !props) throw new Error(`layers=${layers} properties=${props}`);
});

/* ── left rail ────────────────────────────────────────────────────────── */
group('left rail');
for (const name of ['Design', 'Elements', 'Text', 'Uploads', 'Brand', 'Projects']) {
  await step(`${name} drawer opens`, () => openRail(name));
}
await step('clicking the active rail button collapses the drawer', async () => {
  await rail('Projects').click();
  await p.waitForTimeout(300);
  if (await p.locator('.drawer').count()) throw new Error('drawer stayed open');
});

/* ── templates ────────────────────────────────────────────────────────── */
group('templates');
await step('choosing a design repaints the canvas', async () => {
  await openRail('Design');
  const before = await svgHTML();
  await p.locator('.tcard').nth(3).click();
  await p.waitForTimeout(800);
  if (await svgHTML() === before) throw new Error('canvas did not change');
});
await step('search filters the design list', async () => {
  await p.fill('.search', 'story');
  await p.waitForTimeout(300);
  const n = await p.locator('.tcard').count();
  if (n === 0) throw new Error('search returned nothing');
  await p.fill('.search', '');
  await p.waitForTimeout(200);
});

/* ── selection, transform, layers ─────────────────────────────────────── */
group('selection & transform');
await step('clicking a node selects it', async () => {
  const t = await pickTarget();
  if (!t) throw new Error('no usable target node');
  await p.mouse.click(t.cx, t.cy);
  await p.waitForTimeout(250);
  if (!(await p.locator('.ab-overlay [data-handle]').count())) throw new Error('no selection handles appeared');
});
await step('dragging moves the selection', async () => {
  // Assert that WHATEVER the app picked moved by the drag delta, rather than
  // naming the node ourselves. The app hit-tests by bounding box — clicking
  // whitespace inside a text block selects the text, as every editor does —
  // while the harness's elementFromPoint hit-tests per glyph, so the two
  // legitimately disagree about which node owns a point.
  const snap = () => p.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.ab-paper [data-node-id]')]
      .map(e => { const r = e.getBoundingClientRect(); return [e.dataset.nodeId, [Math.round(r.x), Math.round(r.y)]]; })));
  const t = await pickTarget();
  const before = await snap();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.waitForTimeout(80);
  // Step the pointer with a frame's gap between moves. Firing them back to
  // back outruns React's commit and the drag reads as a click.
  const DX = 120, DY = 60;
  for (let i = 1; i <= 15; i++) { await p.mouse.move(t.cx + (DX / 15) * i, t.cy + (DY / 15) * i); await p.waitForTimeout(16); }
  await p.mouse.up();
  await p.waitForTimeout(300);
  const after = await snap();
  const moved = Object.keys(after).filter(k => before[k] && (after[k][0] !== before[k][0] || after[k][1] !== before[k][1]));
  if (moved.length === 0) throw new Error('nothing moved');
  const id = moved[0];
  const dx = after[id][0] - before[id][0], dy = after[id][1] - before[id][1];
  if (Math.abs(dx - DX) > 6 || Math.abs(dy - DY) > 6) {
    throw new Error(`${moved.length} node(s) moved by ${dx},${dy}; expected ~${DX},${DY}`);
  }
});

await step('undo restores the dragged position', async () => {
  const t = await pickTarget();
  await p.mouse.click(t.cx, t.cy);
  await p.waitForTimeout(200);
  const sel = p.locator(`[data-node-id="${t.id}"]`).first();
  const start = await sel.boundingBox();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.waitForTimeout(60);
  for (let i = 1; i <= 15; i++) { await p.mouse.move(t.cx + i * 8, t.cy), await p.waitForTimeout(16); }
  await p.mouse.up();
  await p.waitForTimeout(300);
  const moved = await sel.boundingBox();
  if (Math.abs(moved.x - start.x) < 20) throw new Error('setup drag did not move the node');
  await p.keyboard.press('Meta+z');
  await p.waitForTimeout(400);
  const back = await sel.boundingBox();
  if (Math.abs(back.x - start.x) > 2) throw new Error(`undo left the node ${(back.x - start.x).toFixed(1)}px from where it started`);
});
await step('layers list matches the canvas', async () => {
  const rows = await p.locator('.layer').count();
  const nodes = await nodeCount();
  if (rows === 0) throw new Error('layer list is empty');
  if (rows > nodes) throw new Error(`${rows} layer rows for ${nodes} painted nodes`);
});
await step('hiding a layer removes it from the canvas', async () => {
  const before = await nodeCount();
  await p.locator('.layer .lvis').first().click();
  await p.waitForTimeout(300);
  const after = await nodeCount();
  if (after >= before) throw new Error(`node count ${before} -> ${after}`);
  await p.locator('.layer .lvis').first().click();   // put it back
  await p.waitForTimeout(250);
});

/* ── inspector & effects ──────────────────────────────────────────────── */
group('inspector');
await step('selecting shows properties for that node', async () => {
  const t = await pickTarget();
  await p.mouse.click(t.cx, t.cy);
  await p.waitForTimeout(250);
  const fields = await p.locator('.dockpanel.grow .field, .dockpanel.grow input').count();
  if (fields < 4) throw new Error(`only ${fields} property fields`);
});
await step('align centres the node horizontally', async () => {
  const t = await pickTarget();
  await p.mouse.click(t.cx, t.cy);
  await p.waitForTimeout(200);
  const before = await p.locator(`[data-node-id="${t.id}"]`).first().boundingBox();
  await p.locator('button[aria-label="Align horizontal centres"]').click();
  await p.waitForTimeout(350);
  const after = await p.locator(`[data-node-id="${t.id}"]`).first().boundingBox();
  const paper = await p.locator('.ab-paper').boundingBox();
  const off = Math.abs((after.x + after.width / 2) - (paper.x + paper.width / 2));
  if (off > 3) throw new Error(`centre is ${off.toFixed(1)}px off (was ${Math.abs((before.x + before.width / 2) - (paper.x + paper.width / 2)).toFixed(1)})`);
});
await step('flip mirrors the selection', async () => {
  const btn = p.locator('button', { hasText: /^Flip H$/ });
  if (await btn.isDisabled()) throw new Error('Flip H is still disabled');
  const before = await svgHTML();
  await btn.click();
  await p.waitForTimeout(300);
  if (await svgHTML() === before) throw new Error('canvas unchanged after flip');
});
await step('adding an effect changes the paint', async () => {
  const before = await svgHTML();
  const add = p.locator('button', { hasText: /Add effect|\+ Effect|Shadow|Glow/i }).first();
  if (!(await add.count())) throw new Error('no effect control found');
  await add.click();
  await p.waitForTimeout(400);
  if (await svgHTML() === before) throw new Error('canvas unchanged after adding an effect');
});

/* ── pages ────────────────────────────────────────────────────────────── */
group('pages');
await step('adding a page adds a chip', async () => {
  const before = await p.locator('.pagechip').count();
  await p.locator('.pagechip', { hasText: 'Page' }).last().click();
  await p.waitForTimeout(400);
  const after = await p.locator('.pagechip').count();
  if (after <= before) throw new Error(`chips ${before} -> ${after}`);
});
await step('switching pages changes the canvas', async () => {
  const before = await svgHTML();
  await p.locator('.pagechip').first().click();
  await p.waitForTimeout(400);
  if (await svgHTML() === before) throw new Error('canvas unchanged across pages');
});
await step('zoom slider changes the artboard size', async () => {
  const before = (await p.locator('.ab-paper').boundingBox()).width;
  await p.locator('.zoomslider').fill('0.5');
  await p.waitForTimeout(350);
  const after = (await p.locator('.ab-paper').boundingBox()).width;
  if (Math.abs(after - before) < 10) throw new Error(`width ${before} -> ${after}`);
});

/* ── projects & brand ─────────────────────────────────────────────────── */
group('projects & brand');
await step('saving a project then reloading brings it back', async () => {
  await openRail('Projects');
  const save = p.locator('button', { hasText: /^Save/ }).first();
  if (!(await save.count())) throw new Error('no save control in Projects');
  await save.click();
  await p.waitForTimeout(700);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1800);
  await openRail('Projects');
  const cards = await p.locator('.pj-grid .pj-thumb').count();
  if (cards === 0) throw new Error('no saved project after reload');
});
await step('brand panel lists palettes', async () => {
  await openRail('Brand');
  const swatches = await p.locator('.bk-sw').count();
  if (swatches === 0) throw new Error('no palette swatches');
});

/* ── present & shortcuts ──────────────────────────────────────────────── */
group('present & shortcuts');
await step('? opens the shortcuts sheet', async () => {
  await p.locator('.canvas-host').click({ position: { x: 5, y: 5 } });
  await p.keyboard.press('Shift+Slash');
  await p.waitForTimeout(400);
  if (!(await p.locator('.sc-panel').isVisible().catch(() => false))) throw new Error('shortcuts sheet did not appear');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
});
await step('Present enters full-bleed mode and Escape leaves', async () => {
  await p.locator('button', { hasText: /^Present$/ }).click();
  await p.waitForTimeout(600);
  if (!(await p.locator('.pm-exit').isVisible().catch(() => false))) throw new Error('present mode did not open');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  if (await p.locator('.pm-exit').isVisible().catch(() => false)) throw new Error('Escape did not exit present mode');
});

/* ── export ───────────────────────────────────────────────────────────── */
group('export');
await step('export menu offers all four formats', async () => {
  await p.locator('button', { hasText: /^Export/ }).click();
  await p.waitForTimeout(350);
  const rows = await p.locator('.pop-menu .sizerow').count();
  if (rows < 4) throw new Error(`only ${rows} export formats`);
  await p.keyboard.press('Escape');
});

/* ── report ───────────────────────────────────────────────────────────── */
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
if (errs.length) {
  console.log(`\n${errs.length} console/page error(s):`);
  for (const e of [...new Set(errs)].slice(0, 12)) console.log('   ' + e.slice(0, 200));
} else {
  console.log('no console or page errors');
}
await p.screenshot({ path: '.scratch/shots/interact-final.png' });
await b.close();
process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
