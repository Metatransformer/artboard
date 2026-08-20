import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1020 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2200);
// Select a headline and stack effects on it from the Effects panel.
const t = await p.evaluate(() => {
  const els = [...document.querySelectorAll('.ab-paper text[data-node-id], .ab-paper [data-node-id]')];
  const r = els.map(e => { const q = e.getBoundingClientRect(); return { id: e.dataset.nodeId, x:q.x,y:q.y,w:q.width,h:q.height }; })
    .filter(v => v.w > 200 && v.h > 80).sort((a,c)=>c.w*c.h-a.w*a.h)[0];
  return { cx: r.x + r.w/2, cy: r.y + r.h/2 };
});
await p.mouse.click(t.cx, t.cy);
await p.waitForTimeout(400);
console.log('effect buttons:', await p.locator('.dockpanel.grow button').allInnerTexts().then(a=>a.filter(Boolean)));
for (const name of ['Neon', 'Echo', 'Shadow']) {
  const btn = p.locator('.dockpanel.grow button', { hasText: name }).first();
  const n = await btn.count();
  console.log(name, 'found?', n);
  if (n) { await btn.click({ force: true }); await p.waitForTimeout(600); }
}
// Does the DOM actually carry the filter attributes React used to drop?
const fx = await p.evaluate(() => {
  const f = [...document.querySelectorAll('.ab-paper filter')];
  return f.map(x => ({
    cif: x.getAttribute('color-interpolation-filters'),
    floods: [...x.querySelectorAll('feFlood')].map(n => n.getAttribute('flood-opacity')),
  }));
});
console.log('filters in editor DOM:', JSON.stringify(fx));
await p.screenshot({ path: '.scratch/shots/fx-parity.png' });
await b.close();
