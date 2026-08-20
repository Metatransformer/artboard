import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch();
const p = await b.newPage();
for (const f of process.argv.slice(2)) {
  const svg = readFileSync(f, 'utf8');
  const px = await p.evaluate(async (svgText) => {
    const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { corner: at(5, 5), gap: at(620, 600), insideShape: at(130, 110) };
  }, svg);
  console.log(f, JSON.stringify(px));
}
await b.close();
