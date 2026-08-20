import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 900 } });
const errs=[]; p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('http://localhost:5399/index.html',{waitUntil:'networkidle'});
await p.waitForTimeout(800);

const pass = (n,c)=>console.log(`  ${c?'PASS':'FAIL'}  ${n}`);

await p.locator('.railbtn',{hasText:'Uploads'}).first().click();
await p.waitForTimeout(300);
const before = await p.locator('.layer').count();
await p.locator('input[type=file][accept="image/*"]').setInputFiles('.scratch/test-image.png');
await p.waitForTimeout(900);
const after = await p.locator('.layer').count();
pass('upload adds a layer', after === before + 1);
const imgs = await p.locator('.ab-paper image').count();
pass('image is drawn on the canvas', imgs >= 1);
const thumbs = await p.locator('.ucard img').count();
pass('asset appears in the uploads grid', thumbs === 1);

// project save/reopen
await p.locator('.railbtn',{hasText:'Projects'}).first().click();
await p.waitForTimeout(400);
await p.locator('.drawer input.field').first().fill('E2E Test Design');
await p.getByRole('button',{name:/Save design/i}).click();
await p.waitForTimeout(900);
const saved = await p.locator('.drawer').innerText();
pass('project appears in the list', /E2E Test Design/.test(saved));

await p.reload({waitUntil:'networkidle'});
await p.waitForTimeout(900);
await p.locator('.railbtn',{hasText:'Projects'}).first().click();
await p.waitForTimeout(700);
const afterReload = await p.locator('.drawer').innerText();
pass('project survives a reload', /E2E Test Design/.test(afterReload));

console.log('CONSOLE/PAGE ERRORS:', errs.length ? errs.slice(0,5) : 'none');
await b.close();
