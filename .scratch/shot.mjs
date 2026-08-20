import { chromium } from 'playwright';
const out = process.argv[2] || '.scratch/shots/studio.png';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await p.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
await p.screenshot({ path: out });
const info = await p.evaluate(() => ({
  root: !!document.querySelector('#root')?.children.length,
  svgs: document.querySelectorAll('.ab-paper svg').length,
  templates: document.querySelectorAll('.tcard').length,
  tools: document.querySelectorAll('.tool').length,
  paperSize: (() => { const e = document.querySelector('.ab-paper'); return e ? `${e.clientWidth}x${e.clientHeight}` : 'none'; })(),
}));
console.log(JSON.stringify(info, null, 2));
console.log('CONSOLE ERRORS:', errs.length ? errs.slice(0,8).join('\n') : 'none');
await b.close();
