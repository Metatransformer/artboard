import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
await p.locator('.tcard').nth(3).click();
await p.waitForTimeout(600);

// what is actually at the geometric centre of the artboard?
const probe = await p.evaluate(() => {
  const paper = document.querySelector('.ab-paper').getBoundingClientRect();
  const cx = paper.left + paper.width/2, cy = paper.top + paper.height/2;
  const el = document.elementFromPoint(cx, cy);
  const nodes = [...document.querySelectorAll('.ab-paper [data-node-id]')].map(e => {
    const r = e.getBoundingClientRect();
    return { id: e.dataset.nodeId, tag: e.tagName, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return { centre: [Math.round(cx), Math.round(cy)], elAt: el?.tagName + '/' + (el?.dataset?.nodeId ?? '-'), nodeCount: nodes.length, nodes: nodes.slice(0,8) };
});
console.log(JSON.stringify(probe, null, 2));

// click the centre of a REAL node instead
const target = probe.nodes.find(n => n.w > 30 && n.h > 20);
console.log('targeting node:', target);
await p.mouse.click(target.x + target.w/2, target.y + target.h/2);
await p.waitForTimeout(400);
console.log('handles after targeted click:', await p.locator('[data-handle]').count());
console.log('inspector title:', await p.locator('.panel-right h3').first().textContent());

// now drag + undo on the real selection
const xField = p.locator('.panel-right .field').first();
const x0 = await xField.inputValue();
await p.mouse.move(target.x + target.w/2, target.y + target.h/2);
await p.mouse.down(); await p.mouse.move(target.x + target.w/2 + 80, target.y + target.h/2 + 30, { steps: 12 }); await p.mouse.up();
await p.waitForTimeout(350);
const x1 = await xField.inputValue();
await p.keyboard.press('Meta+z');
await p.waitForTimeout(350);
const x2 = await xField.inputValue();
console.log(`X: start=${x0} afterDrag=${x1} afterUndo=${x2}`);
console.log('MOVE WORKS:', x0 !== x1, '| UNDO WORKS:', x2 === x0);
await b.close();
