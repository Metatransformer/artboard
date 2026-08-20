import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
const step = async (name, fn) => { try { await fn(); console.log(`  PASS  ${name}`); } catch (e) { console.log(`  FAIL  ${name} :: ${e.message.split('\n')[0]}`); } };

await p.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2200);

console.log('— load —');
await step('artboard fits viewport', async () => {
  const r = await p.evaluate(() => { const e = document.querySelector('.ab-paper'); const h = document.querySelector('.canvas-host');
    const a = e.getBoundingClientRect(), c = h.getBoundingClientRect();
    return { fits: a.width <= c.width && a.height <= c.height, a: [a.width|0, a.height|0], c: [c.width|0, c.height|0] }; });
  if (!r.fits) throw new Error(`artboard ${r.a} overflows host ${r.c}`);
});

console.log('— templates —');
await step('switch template repaints canvas', async () => {
  const before = await p.locator('.ab-paper svg').innerHTML();
  await p.locator('.tcard').nth(3).click();
  await p.waitForTimeout(700);
  const after = await p.locator('.ab-paper svg').innerHTML();
  if (before === after) throw new Error('canvas did not change');
});
await step('template search filters', async () => {
  await p.fill('.search', 'story');
  await p.waitForTimeout(250);
  const n = await p.locator('.tcard').count();
  if (n === 0) throw new Error('search returned nothing');
  await p.fill('.search', '');
});

console.log('— selection & transform —');
// aim at a real rendered node, not the geometric centre (which can be whitespace)
const pickTarget = async () => p.evaluate(() => {
  const host = document.querySelector('.canvas-host').getBoundingClientRect();
  const M = 40;   // handles must be reachable, so require margin inside the host
  const els = [...document.querySelectorAll('.ab-paper [data-node-id]')];
  const best = els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(r => r.w > 40 && r.h > 30 &&
                 r.x > host.x + M && r.y > host.y + M &&
                 r.x + r.w < host.right - M && r.y + r.h < host.bottom - M)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return best ? { cx: best.x + best.w / 2, cy: best.y + best.h / 2 } : null;
});
let TGT = null;
await step('click selects a node', async () => {
  TGT = await pickTarget();
  if (!TGT) throw new Error('no renderable node found');
  await p.mouse.click(TGT.cx, TGT.cy);
  await p.waitForTimeout(250);
  const handles = await p.locator('[data-handle]').count();
  if (handles !== 9) throw new Error(`expected 8 resize + 1 rotate handle, got ${handles}`);
});
await step('drag moves the node', async () => {
  const before = await p.locator('.panel-right .field').first().inputValue();
  await p.mouse.move(TGT.cx, TGT.cy);
  await p.mouse.down();
  await p.mouse.move(TGT.cx + 90, TGT.cy + 40, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const after = await p.locator('.panel-right .field').first().inputValue();
  if (before === after) throw new Error(`X did not change (${before})`);
});
await step('undo restores position exactly', async () => {
  const moved = await p.locator('.panel-right .field').first().inputValue();
  await p.keyboard.press('Meta+z');
  await p.waitForTimeout(300);
  const undone = await p.locator('.panel-right .field').first().inputValue();
  if (moved === undone) throw new Error('undo did nothing');
  await p.keyboard.press('Meta+Shift+z');
  await p.waitForTimeout(300);
  const redone = await p.locator('.panel-right .field').first().inputValue();
  if (redone !== moved) throw new Error(`redo gave ${redone}, expected ${moved}`);
  await p.keyboard.press('Meta+z');
  await p.waitForTimeout(250);
});
await step('resize handle changes width', async () => {
  const w0 = await p.locator('.panel-right .field').nth(2).inputValue();
  const h = await p.locator('[data-handle="se"]').first().boundingBox();
  await p.mouse.move(h.x + h.width/2, h.y + h.height/2);
  await p.mouse.down(); await p.mouse.move(h.x + 70, h.y + 50, { steps: 10 }); await p.mouse.up();
  await p.waitForTimeout(300);
  const w1 = await p.locator('.panel-right .field').nth(2).inputValue();
  if (w0 === w1) throw new Error(`width unchanged (${w0})`);
});
await step('arrow key nudges', async () => {
  const x0 = await p.locator('.panel-right .field').first().inputValue();
  await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(250);
  const x1 = await p.locator('.panel-right .field').first().inputValue();
  if (Number(x1) !== Number(x0) + 2) throw new Error(`${x0} -> ${x1}`);
});

console.log('— creating elements —');
await step('rect tool draws a shape', async () => {
  const n0 = await p.evaluate(() => document.querySelectorAll('.ab-paper svg *').length);
  await p.keyboard.press('Escape');
  await p.locator('.tool[title^="Rectangle"]').click();
  const box = await p.locator('.ab-paper').boundingBox();
  await p.mouse.move(box.x + 60, box.y + 60);
  await p.mouse.down(); await p.mouse.move(box.x + 200, box.y + 180, { steps: 10 }); await p.mouse.up();
  await p.waitForTimeout(350);
  const n1 = await p.evaluate(() => document.querySelectorAll('.ab-paper svg *').length);
  if (n1 <= n0) throw new Error(`node count ${n0} -> ${n1}`);
});
await step('elements tab adds a headline', async () => {
  await p.locator('.tab', { hasText: 'elements' }).click();
  await p.waitForTimeout(200);
  const n0 = await p.evaluate(() => document.querySelectorAll('.ab-paper text').length);
  await p.locator('button', { hasText: 'Add a headline' }).click();
  await p.waitForTimeout(350);
  const n1 = await p.evaluate(() => document.querySelectorAll('.ab-paper text').length);
  if (n1 <= n0) throw new Error(`text count ${n0} -> ${n1}`);
});
await step('shape library adds a path', async () => {
  const n0 = await p.evaluate(() => document.querySelectorAll('.ab-paper path').length);
  await p.locator('.ecard').nth(4).click();
  await p.waitForTimeout(350);
  const n1 = await p.evaluate(() => document.querySelectorAll('.ab-paper path').length);
  if (n1 <= n0) throw new Error(`path count ${n0} -> ${n1}`);
});

console.log('— layers —');
await step('layers list reflects the document', async () => {
  await p.locator('.tab', { hasText: 'layers' }).click();
  await p.waitForTimeout(250);
  const n = await p.locator('.layer').count();
  if (n < 3) throw new Error(`only ${n} layers`);
});
await step('hide layer removes it from render', async () => {
  const before = await p.evaluate(() => document.querySelectorAll('.ab-paper svg *').length);
  await p.locator('.layer .licon').first().click();
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => document.querySelectorAll('.ab-paper svg *').length);
  if (after >= before) throw new Error(`${before} -> ${after}`);
});

console.log('— export —');
await step('SVG export downloads', async () => {
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 8000 }),
    (async () => { await p.locator('.exportmenu').hover(); await p.waitForTimeout(250); await p.locator('.exportmenu .menu button', { hasText: 'SVG' }).click(); })(),
  ]);
  if (!dl.suggestedFilename().endsWith('.svg')) throw new Error(dl.suggestedFilename());
});
await step('PNG export downloads', async () => {
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 15000 }),
    (async () => { await p.locator('.exportmenu').hover(); await p.waitForTimeout(250); await p.locator('.exportmenu .menu button', { hasText: 'PNG' }).click(); })(),
  ]);
  const path = await dl.path();
  const { statSync } = await import('node:fs');
  if (statSync(path).size < 2000) throw new Error('png suspiciously small');
});
await step('JSON export downloads valid document', async () => {
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 8000 }),
    (async () => { await p.locator('.exportmenu').hover(); await p.waitForTimeout(250); await p.locator('.exportmenu .menu button', { hasText: 'artboard.json' }).click(); })(),
  ]);
  const { readFileSync } = await import('node:fs');
  const j = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  if (!j.artboards?.[0]?.nodes) throw new Error('not a valid document');
});

await p.screenshot({ path: '.scratch/shots/after-edit.png' });
console.log('\nCONSOLE/PAGE ERRORS:', errs.length ? errs.slice(0,6).join('\n') : 'none');
await b.close();
