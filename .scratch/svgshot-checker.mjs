import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync(process.argv[2], 'utf8');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
// magenta/black checkerboard: anything that stays visible through the artwork
// is genuinely transparent, not white-on-white.
await p.setContent(`<body style="margin:0;background: repeating-conic-gradient(#ff00ff 0% 25%, #202020 0% 50%) 50% / 24px 24px">${svg}</body>`);
await p.waitForTimeout(500);
await p.screenshot({ path: process.argv[3] });
await b.close();
console.log('ok');
