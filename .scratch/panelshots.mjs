import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 900 } });
const errs=[]; p.on('console', m => m.type()==='error' && errs.push(m.text()));
p.on('pageerror', e => errs.push('PAGEERROR '+e.message));
await p.goto('http://localhost:5399/index.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
for (const name of ['Projects','Brand','Uploads','Text']) {
  await p.locator('.railbtn', { hasText: name }).first().click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: `.scratch/panel-${name.toLowerCase()}.png` });
}
console.log('errors:', errs.length ? errs.slice(0,6) : 'none');
await b.close();
