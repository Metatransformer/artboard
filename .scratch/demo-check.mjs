import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://localhost:5399/artboard-demo.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
const info = await p.evaluate(() => ({
  templates: document.querySelectorAll('.tcard').length,
  nodes: document.querySelectorAll('.ab-paper svg *').length,
  paper: (() => { const e = document.querySelector('.ab-paper'); const h = document.querySelector('.canvas-host');
    if(!e||!h) return 'missing'; const a=e.getBoundingClientRect(), c=h.getBoundingClientRect();
    return `${a.width|0}x${a.height|0} in ${c.width|0}x${c.height|0} fits=${a.width<=c.width&&a.height<=c.height}`; })(),
}));
console.log(JSON.stringify(info));
// exercise it
await p.locator('.tcard').nth(6).click(); await p.waitForTimeout(600);
await p.locator('.tab', { hasText: 'elements' }).click(); await p.waitForTimeout(200);
await p.locator('button', { hasText: 'Add a headline' }).click(); await p.waitForTimeout(400);
console.log('after edit nodes:', await p.evaluate(() => document.querySelectorAll('.ab-paper svg *').length));
await p.screenshot({ path: '.scratch/shots/demo.png' });
console.log('ERRORS:', errs.length ? errs.slice(0,5).join(' | ') : 'none');
await b.close();
