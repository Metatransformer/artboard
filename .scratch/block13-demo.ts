import { writeFileSync } from 'node:fs';
import { Document, buildNode } from '@artboard/schema';
import { renderToString, polygonPath, starPath, roundedPolygonPath } from '@artboard/render-svg';

const nodes: any[] = [];
const push = (o: Record<string, unknown>) => nodes.push(buildNode(o));

/* 1. radial gradient on a shape (left) vs linear on the twin (right) */
push({ id: 'r-radial', kind: 'ellipse', x: 30, y: 30, width: 200, height: 160,
  fill: { kind: 'gradient', type: 'radial', cx: 0.35, cy: 0.35, r: 0.65,
          stops: [{ offset: 0, color: '#fef08a' }, { offset: 0.5, color: '#f97316' }, { offset: 1, color: '#7c2d12' }] },
  alt: 'Sunset orb' });
push({ id: 'r-linear', kind: 'rect', x: 250, y: 30, width: 200, height: 160, radius: 16,
  fill: { kind: 'gradient', angle: 45, stops: [{ offset: 0, color: '#22d3ee' }, { offset: 1, color: '#4f46e5' }] } });

/* 2. gradient-filled text (linear) + radial-filled text + plain colour text */
push({ id: 't-grad', kind: 'text', x: 480, y: 40, width: 480, height: 70, text: 'GRADIENT',
  fontSize: 64, fontWeight: 800, align: 'left',
  fill: { kind: 'gradient', angle: 90, stops: [{ offset: 0, color: '#f43f5e' }, { offset: 1, color: '#8b5cf6' }] } });
push({ id: 't-radial', kind: 'text', x: 480, y: 110, width: 480, height: 70, text: 'RADIAL',
  fontSize: 64, fontWeight: 800,
  fill: { kind: 'gradient', type: 'radial', stops: [{ offset: 0, color: '#facc15' }, { offset: 1, color: '#065f46' }] } });
push({ id: 't-plain', kind: 'text', x: 480, y: 180, width: 480, height: 40, text: 'plain color still works',
  fontSize: 28, color: '#0f172a' });

/* 3. flip: four copies of the same asymmetric glyph */
const flipRow = (i: number, label: string, extra: Record<string, unknown>) => {
  const x = 30 + i * 150;
  push({ id: `f-box-${i}`, kind: 'rect', x, y: 240, width: 120, height: 120,
    fill: { kind: 'none' }, stroke: { color: '#94a3b8', width: 2, dash: [4, 4] } });
  push({ id: `f-p-${i}`, kind: 'path', x: x + 20, y: 260, width: 80, height: 80, viewBox: [100, 100],
    d: 'M10 10 L90 10 L90 30 L40 30 L40 45 L75 45 L75 65 L40 65 L40 90 L10 90 Z',
    fill: { kind: 'solid', color: '#dc2626' }, ...extra });
  push({ id: `f-l-${i}`, kind: 'text', x, y: 366, width: 120, height: 20, text: label,
    fontSize: 14, align: 'center', color: '#334155' });
};
flipRow(0, 'plain', {});
flipRow(1, 'rot 30', { rotation: 30 });
flipRow(2, 'flipX', { flipX: true });
flipRow(3, 'rot30+flipX', { rotation: 30, flipX: true });
flipRow(4, 'rot30+flipXY', { rotation: 30, flipX: true, flipY: true });

/* 4. arrowheads on lines and on a path */
push({ id: 'a1', kind: 'line', x: 640, y: 250, width: 300, height: 0,
  stroke: { color: '#0ea5e9', width: 6, markerEnd: 'arrow' } });
push({ id: 'a2', kind: 'line', x: 640, y: 290, width: 300, height: 0,
  stroke: { color: '#16a34a', width: 6, markerStart: 'arrow', markerEnd: 'arrow' } });
push({ id: 'a3', kind: 'line', x: 640, y: 330, width: 300, height: 0,
  stroke: { color: '#db2777', width: 6, markerStart: 'dot', markerEnd: 'bar' } });
push({ id: 'a4', kind: 'path', x: 640, y: 355, width: 300, height: 60, viewBox: [100, 20],
  d: 'M2 18 Q 25 0 50 10 T 98 4',
  fill: { kind: 'none' }, stroke: { color: '#7c3aed', width: 3, markerEnd: 'arrow', markerStart: 'dot' },
  alt: 'Rising trend line' });

/* 5. generated shapes */
const shape = (id: string, x: number, d: string, color: string, alt: string) =>
  push({ id, kind: 'path', x, y: 430, width: 140, height: 140, viewBox: [100, 100], d,
    fill: { kind: 'solid', color }, alt });
shape('s-tri', 30, polygonPath(3, 48), '#ef4444', 'Triangle');
shape('s-hex', 180, polygonPath(6, 48), '#0ea5e9', 'Hexagon');
shape('s-star5', 330, starPath(5, 48, 20), '#f59e0b', 'Five-pointed star');
shape('s-star8', 480, starPath(8, 48, 30), '#8b5cf6', 'Eight-pointed star');
shape('s-round', 630, roundedPolygonPath(5, 48, 14), '#10b981', 'Rounded pentagon');
shape('s-round8', 780, roundedPolygonPath(8, 48, 30), '#334155', 'Rounded octagon');

push({ id: 'note', kind: 'text', x: 30, y: 590, width: 900, height: 40,
  text: 'transparent background — the checkerboard behind is the page, not the artboard',
  fontSize: 20, color: '#0f172a' });

const doc = Document.parse({
  id: 'demo', name: 'Block 1 + 3 renderer demo',
  artboards: [{ id: 'ab1', name: 'Demo', width: 1000, height: 640,
    background: { kind: 'none' }, nodes }],
});

const { svg } = renderToString(doc);
writeFileSync('.scratch/screens/block13.svg', svg);
const { svg: svgA11y } = renderToString(doc, 0, { a11y: true });
writeFileSync('.scratch/screens/block13-a11y.svg', svgA11y);

// an opaque control, so the transparency claim is a comparison and not a guess
const opaque = Document.parse({ ...JSON.parse(JSON.stringify(doc)),
  artboards: [{ ...JSON.parse(JSON.stringify(doc.artboards[0])), background: { kind: 'solid', color: '#ffffff' } }] });
writeFileSync('.scratch/screens/block13-opaque.svg', renderToString(opaque).svg);
console.log('svg bytes', svg.length);
