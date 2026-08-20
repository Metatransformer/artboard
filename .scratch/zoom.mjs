import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [,, file, out, x, y, w, h, s] = process.argv;
const svg = readFileSync(file, 'utf8');
const sc = Number(s || 2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Math.round(Number(w)*sc), height: Math.round(Number(h)*sc) } });
await p.setContent(`<body style="margin:0;overflow:hidden;background:repeating-conic-gradient(#ff00ff 0% 25%, #202020 0% 50%) 50% / 24px 24px">
<div style="position:absolute;left:0;top:0;transform:scale(${sc});transform-origin:0 0">
<div style="position:absolute;left:${-x}px;top:${-y}px">${svg}</div></div></body>`);
await p.waitForTimeout(400);
await p.screenshot({ path: out });
await b.close();
console.log('ok');
