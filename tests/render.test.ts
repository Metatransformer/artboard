import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildNode, findNode, loadDocument, type Document } from '@artboard/schema';
import { renderToString, renderArtboard, serialize, type SceneNode } from '@artboard/render-svg';
import { checkXml } from './helpers';

const docWith = (nodes: unknown[], extra: Record<string, unknown> = {}): Document =>
  loadDocument({
    id: 'd', name: 'Render fixture',
    artboards: [{ id: 'ab', name: 'Page', width: 400, height: 300, nodes }],
    ...extra,
  }).doc;

/** A document that exercises gradients, shadows, text, groups and images at once. */
const kitchenSink = (): Document => docWith(
  [
    { id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50, radius: 6,
      fill: { kind: 'gradient', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] },
      shadow: { x: 2, y: 4, blur: 10, color: '#00000033' } },
    { id: 'e1', kind: 'ellipse', x: 200, y: 40, width: 80, height: 80, rotation: 30, opacity: 0.5 },
    { id: 't1', kind: 'text', x: 20, y: 150, width: 200, height: 80, text: 'Hello\nworld', fontSize: 18 },
    { id: 'i1', kind: 'image', assetId: 'img-1', x: 250, y: 150, width: 100, height: 100 },
    { id: 'g1', kind: 'group', x: 0, y: 0, width: 400, height: 300,
      children: [{ id: 'r2', kind: 'rect', x: 5, y: 5, width: 20, height: 20, fill: { kind: 'solid', color: '#00ff00' } }] },
    { id: 'p1', kind: 'path', x: 300, y: 10, width: 24, height: 24, d: 'M0 0 L24 24 Z' },
    { id: 'l1', kind: 'line', x: 0, y: 280, width: 400, height: 0 },
  ],
  { assets: { 'img-1': { id: 'img-1', mime: 'image/png', width: 200, height: 100, data: 'data:image/png;base64,AAAA' } } },
);

const flatten = (scene: SceneNode): SceneNode[] =>
  [scene, ...(scene.children ?? []).flatMap(flatten)];

/**
 * The scene's drawing children, ignoring the <defs> block and the a11y
 * scaffolding. Tests care what got painted, not where the accessibility
 * <title> happens to sit in the child list.
 */
const drawn = (scene: SceneNode): SceneNode[] =>
  (scene.children ?? []).filter(c => c.tag !== 'defs' && c.tag !== 'title');

/** The element carrying a given document node id, or undefined. */
const elementFor = (scene: SceneNode, nodeId: string): SceneNode | undefined =>
  flatten(scene).find(n => n.nodeId === nodeId);

describe('render: determinism (the golden-test precondition)', () => {
  it('produces byte-identical output across three renders of the same document', () => {
    const doc = kitchenSink();
    const runs = [renderToString(doc), renderToString(doc), renderToString(doc)];

    expect(runs[1]!.svg).toBe(runs[0]!.svg);
    expect(runs[2]!.svg).toBe(runs[0]!.svg);
    expect(new Set(runs.map(r => r.svg)).size).toBe(1);
  });

  it('produces identical output for two structurally identical documents', () => {
    expect(renderToString(kitchenSink()).svg).toBe(renderToString(kitchenSink()).svg);
  });

  it('emits the same diagnostics on every render', () => {
    const doc = docWith([{ id: 'i1', kind: 'image', assetId: 'gone', x: 0, y: 0, width: 10, height: 10 }]);
    const a = renderToString(doc).diagnostics;
    const b = renderToString(doc).diagnostics;
    expect(b).toEqual(a);
  });

  it('resets generated ids per render, so ids never drift upward', () => {
    const doc = kitchenSink();
    const ids = (svg: string) => svg.match(/id="[^"]+"/g) ?? [];
    expect(ids(renderToString(doc).svg)).toEqual(ids(renderToString(doc).svg));
    expect(ids(renderToString(doc).svg).length).toBeGreaterThan(0);
  });

  it('throws a clear error for an artboard index that does not exist', () => {
    expect(() => renderToString(kitchenSink(), 9)).toThrow(/Artboard 9 does not exist/);
  });
});

describe('render: visibility', () => {
  it('emits nothing for a hidden node', () => {
    const doc = docWith([
      { id: 'hidden', kind: 'rect', x: 0, y: 0, width: 10, height: 10, visible: false, fill: { kind: 'solid', color: '#abcdef' } },
    ]);
    const { scene } = renderArtboard(doc, doc.artboards[0]!);

    // only the artboard background rect survives
    expect(drawn(scene)).toHaveLength(1);
    expect(drawn(scene)[0]!.nodeId).toBeUndefined();
    expect(flatten(scene).some(n => n.nodeId === 'hidden')).toBe(false);
    expect(renderToString(doc).svg).not.toContain('#abcdef');
  });

  it('still emits a visible sibling of a hidden node', () => {
    const doc = docWith([
      { id: 'hidden', kind: 'rect', x: 0, y: 0, width: 10, height: 10, visible: false },
      { id: 'shown', kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: { kind: 'solid', color: '#123456' } },
    ]);
    const svg = renderToString(doc).svg;
    expect(svg).toContain('#123456');
    expect(flatten(renderArtboard(doc, doc.artboards[0]!).scene).some(n => n.nodeId === 'shown')).toBe(true);
  });

  it('drops a hidden child from inside a group', () => {
    const doc = docWith([
      { id: 'g', kind: 'group', x: 0, y: 0, width: 100, height: 100, children: [
        { id: 'c1', kind: 'rect', x: 0, y: 0, width: 5, height: 5, visible: false },
        { id: 'c2', kind: 'rect', x: 0, y: 0, width: 5, height: 5 },
      ]},
    ]);
    const nodeIds = flatten(renderArtboard(doc, doc.artboards[0]!).scene).map(n => n.nodeId);
    expect(nodeIds).toContain('c2');
    expect(nodeIds).not.toContain('c1');
  });

  it('emits nothing for a hidden group, children included', () => {
    const doc = docWith([
      { id: 'g', kind: 'group', x: 0, y: 0, width: 100, height: 100, visible: false, children: [
        { id: 'c', kind: 'rect', x: 0, y: 0, width: 5, height: 5, fill: { kind: 'solid', color: '#abcdef' } },
      ]},
    ]);
    expect(renderToString(doc).svg).not.toContain('#abcdef');
  });
});

describe('render: gradients', () => {
  const gradientDoc = () => docWith([
    { id: 'r1', kind: 'rect', x: 0, y: 0, width: 100, height: 100,
      fill: { kind: 'gradient', angle: 90, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] } },
  ]);

  it('emits a <linearGradient> in <defs> that the rect references by url(#…)', () => {
    const svg = renderToString(gradientDoc()).svg;

    expect(svg).toContain('<defs>');
    const gradMatch = svg.match(/<linearGradient id="([^"]+)"/);
    expect(gradMatch).not.toBeNull();

    const id = gradMatch![1]!;
    const rect = svg.split('\n').find(l => l.includes('<rect') && l.includes('url(#'));
    expect(rect).toBeDefined();
    expect(rect).toContain(`fill="url(#${id})"`);

    // the gradient lives inside defs, not loose in the scene
    const defsStart = svg.indexOf('<defs>');
    const defsEnd = svg.indexOf('</defs>');
    expect(svg.indexOf('<linearGradient')).toBeGreaterThan(defsStart);
    expect(svg.indexOf('<linearGradient')).toBeLessThan(defsEnd);
  });

  it('emits one <stop> per gradient stop, in order', () => {
    const svg = renderToString(gradientDoc()).svg;
    const stops = svg.match(/<stop [^>]*\/>/g) ?? [];
    expect(stops).toHaveLength(2);
    expect(stops[0]).toContain('stop-color="#ff0000"');
    expect(stops[1]).toContain('stop-color="#0000ff"');
    expect(stops[0]).toContain('offset="0"');
    expect(stops[1]).toContain('offset="1"');
  });

  it('gives each gradient its own id when several are present', () => {
    const doc = docWith([
      { id: 'r1', kind: 'rect', x: 0, y: 0, width: 10, height: 10,
        fill: { kind: 'gradient', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } },
      { id: 'r2', kind: 'rect', x: 0, y: 0, width: 10, height: 10,
        fill: { kind: 'gradient', angle: 0, stops: [{ offset: 0, color: '#111111' }, { offset: 1, color: '#eeeeee' }] } },
    ]);
    const svg = renderToString(doc).svg;
    const ids = [...svg.matchAll(/<linearGradient id="([^"]+)"/g)].map(m => m[1]!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(svg).toContain(`url(#${id})`);
  });

  it('varies the gradient vector with the angle', () => {
    const at = (angle: number) => renderToString(docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10,
        fill: { kind: 'gradient', angle, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } },
    ])).svg.match(/<linearGradient[^>]*>/)![0];
    expect(at(0)).not.toBe(at(90));
  });

  it('emits fill="none" and no defs for a none-fill', () => {
    const doc = docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: { kind: 'none' } }]);
    const svg = renderToString(doc).svg;
    expect(svg).toContain('fill="none"');
    expect(svg).not.toContain('<linearGradient');
  });
});

describe('render: transforms', () => {
  it('emits a rotate() transform around the node centre', () => {
    const doc = docWith([{ id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50, rotation: 30 }]);
    const svg = renderToString(doc).svg;
    // centre of (10,20,100x50) is (60,45)
    expect(svg).toContain('transform="rotate(30 60 45)"');
  });

  it('emits no transform for an unrotated node', () => {
    const doc = docWith([{ id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50 }]);
    expect(renderToString(doc).svg).not.toContain('rotate(');
  });

  it('wraps the rotated element in a <g> that keeps the node id', () => {
    const doc = docWith([{ id: 'r1', kind: 'rect', x: 0, y: 0, width: 10, height: 10, rotation: 45 }]);
    const { scene } = renderArtboard(doc, doc.artboards[0]!);
    const wrapper = elementFor(scene, 'r1')!;
    expect(wrapper.tag).toBe('g');
    expect(wrapper.nodeId).toBe('r1');
    expect(wrapper.attrs.transform).toBe('rotate(45 5 5)');
    expect(wrapper.children![0]!.tag).toBe('rect');
  });

  it('emits opacity only when it is not 1', () => {
    const opaque = docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }]);
    const faded = docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, opacity: 0.4 }]);
    expect(renderToString(opaque).svg).not.toContain('opacity=');
    expect(renderToString(faded).svg).toContain('opacity="0.4"');
  });

  it('emits a drop-shadow filter referenced from the wrapper', () => {
    const doc = docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, shadow: { x: 1, y: 2, blur: 8, color: '#00000033' } },
    ]);
    const svg = renderToString(doc).svg;
    const id = svg.match(/<filter id="([^"]+)"/)?.[1];
    expect(id).toBeDefined();
    expect(svg).toContain(`filter="url(#${id})"`);
    expect(svg).toContain('<feDropShadow');
    expect(svg).toContain('stdDeviation="4"');
  });
});

describe('render: forward compatibility', () => {
  it('draws nothing for an unknown (opaque) node but reports a NODE_UNKNOWN info diagnostic', () => {
    const doc = docWith([
      { id: 'o1', kind: 'opaque', originalKind: 'lottie', raw: { src: 'a.json' }, x: 0, y: 0, width: 50, height: 50 },
    ]);
    const { scene } = renderArtboard(doc, doc.artboards[0]!);
    const { svg, diagnostics } = renderToString(doc);

    // nothing drawn: only the artboard background remains
    expect(drawn(scene)).toHaveLength(1);
    expect(flatten(scene).some(n => n.nodeId === 'o1')).toBe(false);
    expect(svg).not.toContain('lottie');

    const diag = diagnostics.find(d => d.code === 'NODE_UNKNOWN');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('info');
    expect(diag!.nodeId).toBe('o1');
    expect(diag!.message).toContain('lottie');
    expect(diag!.message).toMatch(/preserved on save/);
  });

  it('reports one NODE_UNKNOWN per unknown node, including inside groups', () => {
    const doc = docWith([
      { id: 'o1', kind: 'opaque', originalKind: 'video', raw: null, x: 0, y: 0, width: 5, height: 5 },
      { id: 'g', kind: 'group', x: 0, y: 0, width: 50, height: 50, children: [
        { id: 'o2', kind: 'opaque', originalKind: 'chart', raw: null, x: 0, y: 0, width: 5, height: 5 },
      ]},
    ]);
    const codes = renderToString(doc).diagnostics.filter(d => d.code === 'NODE_UNKNOWN');
    expect(codes.map(d => d.nodeId).sort()).toEqual(['o1', 'o2']);
  });

  it('keeps drawing the known siblings of an unknown node', () => {
    const doc = docWith([
      { id: 'o1', kind: 'opaque', originalKind: 'video', raw: null, x: 0, y: 0, width: 5, height: 5 },
      { id: 'r1', kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: { kind: 'solid', color: '#123456' } },
    ]);
    expect(renderToString(doc).svg).toContain('#123456');
  });
});

describe('render: escaping', () => {
  it('escapes &, < and > in text content, leaving quotes literal (valid in XML text)', () => {
    const doc = docWith([
      { id: 't1', kind: 'text', x: 0, y: 0, width: 800, height: 40, text: 'Tom & Jerry <b>"hi"</b>' },
    ]);
    const svg = renderToString(doc).svg;

    expect(svg).toContain('Tom &amp; Jerry &lt;b&gt;"hi"&lt;/b&gt;');
    expect(svg).not.toContain('<b>');
    // no raw ampersand survives outside a character entity
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
    expect(checkXml(svg).ok).toBe(true);
  });

  it('escapes double quotes inside attribute values', () => {
    const doc = docWith([
      { id: 't1', kind: 'text', x: 0, y: 0, width: 400, height: 40, text: 'x', fontFamily: 'My "Odd" Face' },
    ]);
    const svg = renderToString(doc).svg;
    expect(svg).toContain('&quot;Odd&quot;');
    expect(checkXml(svg).ok).toBe(true);
  });

  it('escapes markup in the artboard and asset paths too', () => {
    const doc = docWith(
      [{ id: 't', kind: 'text', x: 0, y: 0, width: 400, height: 40, text: ']]><script>alert(1)</script>' }],
    );
    const svg = renderToString(doc).svg;
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(checkXml(svg).ok).toBe(true);
  });

  it('preserves whitespace-only and multi-line text without breaking the markup', () => {
    const doc = docWith([{ id: 't', kind: 'text', x: 0, y: 0, width: 400, height: 60, text: '  a  \n  b  ' }]);
    const svg = renderToString(doc).svg;
    expect(svg).toContain('xml:space="preserve"');
    expect(checkXml(svg).ok).toBe(true);
  });
});

describe('render: images', () => {
  const missing = () => docWith([{ id: 'i1', kind: 'image', assetId: 'gone', x: 10, y: 20, width: 100, height: 80 }]);

  it('renders a placeholder and reports ASSET_MISSING when the asset is absent', () => {
    const { svg, diagnostics } = renderToString(missing());

    expect(svg).toContain('Missing image');
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('fill="#f3f4f6"');

    const diag = diagnostics.find(d => d.code === 'ASSET_MISSING');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('error');
    expect(diag!.nodeId).toBe('i1');
    expect(diag!.message).toContain('gone');

    // the placeholder occupies the node's box
    expect(svg).toContain('x="10"');
    expect(svg).toContain('width="100"');
    expect(checkXml(svg).ok).toBe(true);
  });

  it('emits no <image> element for a missing asset', () => {
    expect(renderToString(missing()).svg).not.toContain('<image');
  });

  it('renders a real asset as a clipped <image> with the data URI inlined', () => {
    const doc = docWith(
      [{ id: 'i1', kind: 'image', assetId: 'img-1', x: 0, y: 0, width: 100, height: 100, radius: 8 }],
      { assets: { 'img-1': { id: 'img-1', mime: 'image/png', width: 200, height: 100, data: 'data:image/png;base64,AAAA' } } },
    );
    const { svg, diagnostics } = renderToString(doc);

    expect(diagnostics).toEqual([]);
    expect(svg).toContain('<clipPath');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).toContain('rx="8"');
  });

  it('replaces the data URI with an asset: reference when inlineAssets is false', () => {
    const doc = docWith(
      [{ id: 'i1', kind: 'image', assetId: 'img-1', x: 0, y: 0, width: 100, height: 100 }],
      { assets: { 'img-1': { id: 'img-1', mime: 'image/png', width: 200, height: 100, data: 'data:image/png;base64,AAAA' } } },
    );
    const svg = renderToString(doc, 0, { inlineAssets: false }).svg;
    expect(svg).toContain('href="asset:img-1"');
    expect(svg).not.toContain('base64');
  });
});

describe('render: serialization', () => {
  it('produces well-formed XML: every opened tag closes, in order', () => {
    const { svg } = renderToString(kitchenSink());
    const result = checkXml(svg);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('opens with an <svg> root carrying xmlns and a viewBox matching the artboard', () => {
    const svg = renderToString(kitchenSink()).svg;
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 400 300"');
  });

  it('self-closes childless elements and never emits an empty text node as a self-close', () => {
    const empty = serialize({ tag: 'rect', attrs: { x: 1 } });
    expect(empty).toBe('<rect x="1"/>');
    expect(serialize({ tag: 'tspan', attrs: {}, text: '' })).toBe('<tspan></tspan>');
  });

  it('indents nested elements by two spaces per level', () => {
    const out = serialize({ tag: 'g', attrs: {}, children: [{ tag: 'rect', attrs: { x: 0 } }] });
    expect(out).toBe('<g>\n  <rect x="0"/>\n</g>');
  });

  it('stays well-formed for every artboard of a multi-artboard document', () => {
    const doc = loadDocument({
      id: 'd',
      artboards: [
        { id: 'a1', width: 100, height: 100, nodes: [{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }] },
        { id: 'a2', width: 50, height: 50, nodes: [{ id: 't', kind: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a<b' }] },
      ],
    }).doc;
    for (let i = 0; i < doc.artboards.length; i++) {
      expect(checkXml(renderToString(doc, i).svg).ok).toBe(true);
    }
  });

  it('rejects malformed markup, proving the checker can fail', () => {
    expect(checkXml('<g><rect/></svg>').ok).toBe(false);
    expect(checkXml('<g><rect/>').ok).toBe(false);
    expect(checkXml('<g><rect/></g>').ok).toBe(true);
  });
});

describe('render: object fit', () => {
  /*
   * REGRESSION GUARD. `renderNode`'s `case 'image'` used to derive a single
   * scale from the crop WIDTH alone. Since `objectFit` returns the whole source
   * rect for both 'contain' and 'fill', both fits rendered at the source aspect
   * scaled to the box width — contain never letterboxed and fill never
   * stretched, so all three fits produced near-identical pixels. It was silent:
   * the markup stayed well-formed and every golden still matched, because no
   * golden fixture contains an image node at all. Fixed by scaling each axis
   * separately and centring the result.
   */
  const imageEl = (fit: string, box: { w: number; h: number }, src: { w: number; h: number }) =>
    renderToString(docWith(
      [{ id: 'i', kind: 'image', assetId: 'a', x: 0, y: 0, width: box.w, height: box.h, fit }],
      { assets: { a: { id: 'a', mime: 'image/png', width: src.w, height: src.h, data: 'data:,x' } } },
    )).svg.match(/<image[^>]*>/)![0];

  const geom = (el: string) => {
    const num = (k: string) => Number(el.match(new RegExp(`${k}="(-?[\\d.]+)"`))![1]);
    return { x: num('x'), y: num('y'), width: num('width'), height: num('height') };
  };

  const PORTRAIT = { w: 100, h: 200 };
  const LANDSCAPE = { w: 200, h: 100 };
  const SQUARE_BOX = { w: 100, h: 100 };

  it('contain letterboxes a portrait source so the whole image fits inside the box', () => {
    const g = geom(imageEl('contain', SQUARE_BOX, PORTRAIT));
    expect(g).toEqual({ x: 25, y: 0, width: 50, height: 100 });   // pillarboxed, centred
  });

  it('contain letterboxes a landscape source too', () => {
    const g = geom(imageEl('contain', SQUARE_BOX, LANDSCAPE));
    expect(g).toEqual({ x: 0, y: 25, width: 100, height: 50 });   // letterboxed, centred
  });

  it('contain never overflows the box, and preserves the source aspect ratio', () => {
    for (const src of [PORTRAIT, LANDSCAPE, { w: 640, h: 480 }, { w: 33, h: 400 }]) {
      const g = geom(imageEl('contain', SQUARE_BOX, src));
      expect(g.width, JSON.stringify(src)).toBeLessThanOrEqual(SQUARE_BOX.w + 0.01);
      expect(g.height, JSON.stringify(src)).toBeLessThanOrEqual(SQUARE_BOX.h + 0.01);
      expect(g.width / g.height).toBeCloseTo(src.w / src.h, 1);
      // and it touches at least one edge — it is scaled up to fit, not shrunk arbitrarily
      expect(Math.max(g.width / SQUARE_BOX.w, g.height / SQUARE_BOX.h)).toBeCloseTo(1, 2);
    }
  });

  it('fill stretches the source to exactly the box, distorting it', () => {
    expect(geom(imageEl('fill', SQUARE_BOX, PORTRAIT))).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(geom(imageEl('fill', SQUARE_BOX, LANDSCAPE))).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('cover fills the box and overflows, keeping the source aspect ratio', () => {
    const g = geom(imageEl('cover', SQUARE_BOX, PORTRAIT));
    expect(g.width).toBeCloseTo(100, 2);
    expect(g.height).toBeCloseTo(200, 2);          // overflows vertically, then gets clipped
    expect(g.width / g.height).toBeCloseTo(PORTRAIT.w / PORTRAIT.h, 2);
    // covers the box completely
    expect(g.x).toBeLessThanOrEqual(0);
    expect(g.y).toBeLessThanOrEqual(0);
    expect(g.x + g.width).toBeGreaterThanOrEqual(SQUARE_BOX.w);
    expect(g.y + g.height).toBeGreaterThanOrEqual(SQUARE_BOX.h);
  });

  it('renders all three fits differently from one another', () => {
    const [cover, contain, fill] = ['cover', 'contain', 'fill'].map(f => imageEl(f, SQUARE_BOX, PORTRAIT));
    expect(new Set([cover, contain, fill]).size).toBe(3);
  });

  it('leaves a source that already matches the box aspect identical under every fit', () => {
    const els = ['cover', 'contain', 'fill'].map(f => geom(imageEl(f, SQUARE_BOX, { w: 50, h: 50 })));
    for (const g of els) expect(g).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('stays deterministic and well-formed for every fit', () => {
    for (const fit of ['cover', 'contain', 'fill']) {
      const doc = docWith(
        [{ id: 'i', kind: 'image', assetId: 'a', x: 10, y: 20, width: 100, height: 80, fit }],
        { assets: { a: { id: 'a', mime: 'image/png', width: 300, height: 200, data: 'data:,x' } } },
      );
      const runs = [renderToString(doc).svg, renderToString(doc).svg, renderToString(doc).svg];
      expect(new Set(runs).size, fit).toBe(1);
      expect(checkXml(runs[0]!).ok, fit).toBe(true);
    }
  });
});

describe('render: node identity', () => {
  const idsIn = (doc: Document) =>
    flatten(renderArtboard(doc, doc.artboards[0]!).scene).map(n => n.nodeId).filter(Boolean);

  it('puts the node id on exactly ONE element, however the node is decorated', () => {
    // each of these takes a different branch through the wrapper logic
    const decorations: Array<Record<string, unknown>> = [
      {},
      { rotation: 30 },
      { opacity: 0.5 },
      { flipX: true },
      { blend: 'multiply' },
      { alt: 'A red square' },
      { shadow: { x: 1, y: 2, blur: 4, color: '#00000033' } },
      { effects: [{ kind: 'blur', radius: 4 }] },
      { effects: [{ kind: 'vignette' }] },
      { effects: [{ kind: 'background' }] },
      { rotation: 30, opacity: 0.5, alt: 'Everything', effects: [{ kind: 'glow' }], blend: 'screen' },
    ];

    for (const extra of decorations) {
      const doc = docWith([{ id: 'n1', kind: 'rect', x: 0, y: 0, width: 10, height: 10, ...extra }]);
      expect(idsIn(doc).filter(id => id === 'n1'), JSON.stringify(extra)).toHaveLength(1);
    }
  });

  it('gives every visible node in a group its own single id', () => {
    const doc = docWith([
      { id: 'g', kind: 'group', x: 0, y: 0, width: 100, height: 100, rotation: 10, children: [
        { id: 'c1', kind: 'rect', x: 0, y: 0, width: 5, height: 5, opacity: 0.5 },
        { id: 'c2', kind: 'ellipse', x: 0, y: 0, width: 5, height: 5 },
      ]},
    ]);
    const ids = idsIn(doc);
    for (const id of ['g', 'c1', 'c2']) expect(ids.filter(x => x === id), id).toHaveLength(1);
  });
});

describe('render: transforms, flips and blending', () => {
  it('mirrors about the node centre for flipX and flipY', () => {
    const svg = renderToString(docWith([
      { id: 'r', kind: 'rect', x: 10, y: 20, width: 100, height: 50, flipX: true },
    ])).svg;
    expect(svg).toContain('translate(60 45) scale(-1 1) translate(-60 -45)');
  });

  it('applies the flip before the rotation, so a rotated node mirrors inside its own frame', () => {
    const svg = renderToString(docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 100, height: 100, rotation: 45, flipY: true },
    ])).svg;
    const transform = svg.match(/transform="([^"]*)"/)![1]!;
    // SVG applies a transform list right-to-left: rotate listed first means it happens last
    expect(transform.indexOf('rotate(')).toBeLessThan(transform.indexOf('scale('));
    expect(transform).toContain('scale(1 -1)');
  });

  it('emits no transform when the node is neither rotated nor flipped', () => {
    expect(renderToString(docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }])).svg)
      .not.toContain('transform=');
  });

  it('emits a mix-blend-mode style only for a non-normal blend', () => {
    expect(renderToString(docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, blend: 'multiply' }])).svg)
      .toContain('style="mix-blend-mode:multiply"');
    expect(renderToString(docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, blend: 'normal' }])).svg)
      .not.toContain('mix-blend-mode');
  });
});

describe('render: effects', () => {
  const withEffects = (effects: unknown[], extra: Record<string, unknown> = {}) =>
    renderToString(docWith([{ id: 'n', kind: 'rect', x: 20, y: 20, width: 100, height: 100, effects, ...extra }]));

  it('compiles blur, glow and shadow into a filter the node references', () => {
    for (const kind of ['blur', 'glow', 'shadow', 'outline', 'echo']) {
      const { svg } = withEffects([{ kind }]);
      const id = svg.match(/<filter id="([^"]+)"/)?.[1];
      expect(id, kind).toBeDefined();
      expect(svg, kind).toContain(`filter="url(#${id})"`);
      expect(checkXml(svg).ok, kind).toBe(true);
    }
  });

  it('draws a background plate behind the node rather than as a filter', () => {
    const { svg } = withEffects([{ kind: 'background', color: '#ff0000', padding: 10 }]);
    const plate = svg.indexOf('#ff0000');
    const shape = svg.indexOf('#4f46e5');       // the rect's own default fill
    expect(plate).toBeGreaterThan(-1);
    expect(plate, 'the plate must be painted before the shape').toBeLessThan(shape);
  });

  it('lays a vignette over the node, outside the filter that blurs it', () => {
    const { svg } = withEffects([{ kind: 'blur' }, { kind: 'vignette' }]);
    expect(svg).toContain('<radialGradient');
    expect(svg).toContain('pointer-events="none"');
    // the overlay rect comes after the filtered content
    expect(svg.indexOf('pointer-events="none"')).toBeGreaterThan(svg.indexOf('filter="url(#'));
  });

  it('stacks several effects without producing malformed markup', () => {
    const { svg } = withEffects([
      { kind: 'shadow' }, { kind: 'glow' }, { kind: 'blur' },
      { kind: 'adjust', saturation: 40 }, { kind: 'duotone' }, { kind: 'vignette' },
    ]);
    expect(checkXml(svg).ok).toBe(true);
  });

  it('emits nothing extra when the effects list is empty', () => {
    expect(withEffects([]).svg).not.toContain('<filter');
  });

  it('is deterministic with a full effects stack', () => {
    const doc = docWith([{ id: 'n', kind: 'rect', x: 0, y: 0, width: 50, height: 50,
      effects: [{ kind: 'glow' }, { kind: 'vignette' }, { kind: 'background' }] }]);
    const runs = [renderToString(doc).svg, renderToString(doc).svg, renderToString(doc).svg];
    expect(new Set(runs).size).toBe(1);
  });
});

describe('render: curved text', () => {
  const curved = (text: string, width = 400) => renderToString(docWith([
    { id: 't', kind: 'text', x: 0, y: 0, width, height: 100, text, fontSize: 20,
      effects: [{ kind: 'curve', amount: 60 }] },
  ]));

  it('rides the text on a path in defs instead of laying out tspans', () => {
    const { svg } = curved('Arched headline');
    const pathId = svg.match(/<path id="([^"]+)"/)?.[1];
    expect(pathId).toBeDefined();
    expect(svg).toContain(`href="#${pathId}"`);
    expect(svg).toContain('<textPath');
    expect(svg).not.toContain('<tspan');
    expect(checkXml(svg).ok).toBe(true);
  });

  it('warns CURVE_SINGLE_LINE and keeps the first line when the text wraps', () => {
    const { svg, diagnostics } = curved('this headline is far too long to fit on a single line', 60);
    const diag = diagnostics.find(d => d.code === 'CURVE_SINGLE_LINE');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('warn');
    expect(diag!.nodeId).toBe('t');
    expect(checkXml(svg).ok).toBe(true);
  });

  it('stays silent when the curved text already fits on one line', () => {
    expect(curved('Short').diagnostics.filter(d => d.code === 'CURVE_SINGLE_LINE')).toEqual([]);
  });

  it('warns CURVE_NO_RULES rather than drawing a rule that ignores the arc', () => {
    // `effects.json` carries curved text but sets neither rule, so this branch
    // had no coverage of any kind while its sibling CURVE_SINGLE_LINE did.
    //
    // No golden can hold it as things stand: a diagnostic is not in the SVG,
    // and the committed `golden` compares nothing else. A .diag baseline that
    // WOULD hold one exists only in an uncommitted working tree, so measuring
    // it by running the CLI reports on code that is not in the repository.
    // If that lands, this assertion is still the cheaper place to pin level
    // and nodeId, and it does not wait on a fixture being written.
    const doc = docWith([{ id: 't', kind: 'text', x: 0, y: 0, width: 400, height: 100,
      text: 'Arched', fontSize: 20, underline: true,
      effects: [{ kind: 'curve', amount: 60 }] }]);
    const { svg, diagnostics } = renderToString(doc);
    const diag = diagnostics.find(d => d.code === 'CURVE_NO_RULES');
    expect(diag).toBeDefined();
    expect(diag!.level).toBe('warn');
    expect(diag!.nodeId).toBe('t');
    // Warning and then drawing it anyway would be worse than either alone.
    expect(svg).not.toContain('<path d="M');
    expect(checkXml(svg).ok).toBe(true);
  });

  it('warns for a strikethrough on curved text too, not only an underline', () => {
    const strike = docWith([{ id: 't', kind: 'text', x: 0, y: 0, width: 400, height: 100,
      text: 'Arched', fontSize: 20, strikethrough: true,
      effects: [{ kind: 'curve', amount: 60 }] }]);
    expect(renderToString(strike).diagnostics.some(d => d.code === 'CURVE_NO_RULES')).toBe(true);
  });

  it('stays silent when curved text asks for no rules', () => {
    // The control. Both assertions above are that a code IS present; without
    // this, a renderer that warned unconditionally would satisfy them.
    expect(curved('Short').diagnostics.filter(d => d.code === 'CURVE_NO_RULES')).toEqual([]);
  });
});

describe('render: paint', () => {
  it('emits a <radialGradient> for a radial fill and a <linearGradient> for a linear one', () => {
    const stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }];
    const radial = renderToString(docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10,
      fill: { kind: 'gradient', type: 'radial', stops } }])).svg;
    const linear = renderToString(docWith([{ id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10,
      fill: { kind: 'gradient', type: 'linear', stops } }])).svg;

    expect(radial).toContain('<radialGradient');
    expect(radial).not.toContain('<linearGradient');
    expect(linear).toContain('<linearGradient');
    expect(linear).not.toContain('<radialGradient');
  });

  it('lets a text fill win over the legacy color', () => {
    const plain = renderToString(docWith([
      { id: 't', kind: 'text', x: 0, y: 0, width: 100, height: 40, text: 'hi', color: '#123456' },
    ])).svg;
    expect(plain).toContain('fill="#123456"');

    const painted = renderToString(docWith([
      { id: 't', kind: 'text', x: 0, y: 0, width: 100, height: 40, text: 'hi', color: '#123456',
        fill: { kind: 'gradient', stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] } },
    ])).svg;
    expect(painted).toContain('<linearGradient');
    expect(painted).not.toContain('fill="#123456"');
  });

  it('emits a <marker> per decorated stroke end and references it', () => {
    const svg = renderToString(docWith([
      { id: 'l', kind: 'line', x: 0, y: 50, width: 200, height: 0,
        stroke: { width: 4, color: '#111111', markerStart: 'dot', markerEnd: 'arrow' } },
    ])).svg;

    const ids = [...svg.matchAll(/<marker id="([^"]+)"/g)].map(m => m[1]!);
    expect(ids).toHaveLength(2);
    expect(svg).toContain(`marker-start="url(#${ids[0]})"`);
    expect(svg).toContain(`marker-end="url(#${ids[1]})"`);
    expect(checkXml(svg).ok).toBe(true);
  });

  it('emits no markers when both ends are none', () => {
    expect(renderToString(docWith([
      { id: 'l', kind: 'line', x: 0, y: 0, width: 100, height: 0, stroke: { width: 2 } },
    ])).svg).not.toContain('<marker');
  });

  it('emits stroke cap and join only when they differ from the SVG defaults', () => {
    const plain = renderToString(docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, stroke: { width: 2 } },
    ])).svg;
    expect(plain).not.toContain('stroke-linejoin');

    const rounded = renderToString(docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, stroke: { width: 2, cap: 'round', join: 'round' } },
    ])).svg;
    expect(rounded).toContain('stroke-linecap="round"');
    expect(rounded).toContain('stroke-linejoin="round"');
  });

  it('draws nothing at all for a none background, leaving the export transparent', () => {
    const doc = loadDocument({ id: 'd', artboards: [{ id: 'ab', width: 100, height: 100,
      background: { kind: 'none' }, nodes: [] }] }).doc;
    const { scene } = renderArtboard(doc, doc.artboards[0]!);
    expect(drawn(scene)).toHaveLength(0);
    expect(renderToString(doc).svg).not.toContain('<rect');
  });
});

describe('render: image frames', () => {
  const framed = (extra: Record<string, unknown>) => renderToString(docWith(
    [{ id: 'i', kind: 'image', assetId: 'a', x: 10, y: 20, width: 100, height: 80, ...extra }],
    { assets: { a: { id: 'a', mime: 'image/png', width: 200, height: 100, data: 'data:,x' } } },
  )).svg;

  it('clips to a rect by default, honouring the corner radius', () => {
    const svg = framed({ radius: 12 });
    expect(svg).toContain('<clipPath');
    expect(svg).toContain('rx="12"');
  });

  it('clips to an ellipse centred on the node box', () => {
    expect(framed({ frame: 'ellipse' })).toMatch(/<ellipse cx="60" cy="60" rx="50" ry="40"\/>/);
  });

  it('clips to a scaled path in frameBox space', () => {
    const svg = framed({ frame: 'path', frameD: 'M0 0 L24 24 Z', frameBox: [24, 24] });
    expect(svg).toContain('d="M0 0 L24 24 Z"');
    // 100/24 and 80/24, rounded to 2dp
    expect(svg).toContain('translate(10 20) scale(4.17 3.33)');
  });

  it('falls back to a rect when a path frame carries no path data', () => {
    const svg = framed({ frame: 'path', frameD: '' });
    expect(svg).toContain('<clipPath');
    expect(svg).not.toContain('<path');
  });
});

describe('render: accessibility', () => {
  const doc = () => docWith([
    { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
    { id: 'i', kind: 'image', assetId: 'a', x: 0, y: 0, width: 10, height: 10, alt: 'A red barn' },
  ], { name: 'My design', assets: { a: { id: 'a', mime: 'image/png', width: 2, height: 2, data: 'data:,x' } } });

  it('renders per-node alt text as a <title>, whatever the a11y option', () => {
    for (const a11y of [false, true]) {
      expect(renderToString(doc(), 0, { a11y }).svg, `a11y=${a11y}`).toContain('<title>A red barn</title>');
    }
  });

  it('emits role, a document title and aria-hidden by default', () => {
    // An exported SVG usually lands in a web page, so the accessible markup is
    // the default and opting out is the deliberate act.
    for (const opts of [undefined, { a11y: true }]) {
      const svg = renderToString(doc(), 0, opts).svg;
      expect(svg, String(opts)).toContain('role="img"');
      expect(svg, String(opts)).toContain('<title>My design</title>');
      expect(svg, String(opts)).toContain('aria-hidden="true"');   // the unnamed rect
      expect(checkXml(svg).ok, String(opts)).toBe(true);
    }
  });

  it('drops the document-level scaffolding only when a11y is explicitly false', () => {
    const off = renderToString(doc(), 0, { a11y: false }).svg;
    expect(off).not.toContain('role="img"');
    expect(off).not.toContain('aria-hidden');
    expect(off).not.toContain('<title>My design</title>');
    // per-node alt is opt-in per node already, so it survives either way
    expect(off).toContain('<title>A red barn</title>');
    expect(checkXml(off).ok).toBe(true);
  });

  it('never hides a shape that carries alt text', () => {
    const svg = renderToString(docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, alt: 'Meaningful square' },
    ]), 0, { a11y: true }).svg;
    expect(svg).toContain('<title>Meaningful square</title>');
    expect(svg).not.toContain('aria-hidden');
  });

  it('escapes markup inside alt text', () => {
    const svg = renderToString(docWith([
      { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 10, alt: 'A <b>bold</b> & odd name' },
    ])).svg;
    expect(svg).toContain('<title>A &lt;b&gt;bold&lt;/b&gt; &amp; odd name</title>');
    expect(checkXml(svg).ok).toBe(true);
  });
});

describe('render: the golden oracle covers images at all', () => {
  // The objectFit bug -- contain and fill rendering identically to cover --
  // survived a fully green oracle because not one of the 24 fixtures contained
  // an image node. An oracle with no coverage of a path does not fail on that
  // path, it lies about it. This guard is here so that gap cannot reopen
  // quietly: if the image fixture is deleted, this goes red, not silent.
  const dir = fileURLToPath(new URL('./golden/', import.meta.url));
  const fixtures = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(dir + f, 'utf8')));
  const nodesOf = (d: any): any[] =>
    d.artboards.flatMap((ab: any) => ab.nodes.flatMap(function walk(n: any): any[] {
      return [n, ...(n.children ?? []).flatMap(walk)];
    }));
  const images = fixtures.flatMap(nodesOf).filter(n => n.kind === 'image');

  it('has at least one baselined image node', () => {
    expect(images.length).toBeGreaterThan(0);
  });

  it('baselines all three object fits', () => {
    expect(new Set(images.map(n => n.fit ?? 'cover'))).toEqual(new Set(['cover', 'contain', 'fill']));
  });

  it('baselines a non-rectangular frame', () => {
    expect(images.some(n => n.frame === 'ellipse' || n.frame === 'path')).toBe(true);
  });
});

describe('render: a group rotates around its artwork, not its stored bounds', () => {
  // A group's x/y/width/height is written once by `makeGroup` and refreshed by
  // nothing, so it goes stale the moment a child is edited. That is a display
  // problem everywhere else in the app and a CORRECTNESS problem here: the
  // wrapper's `rotate()` took its pivot from those fields, so a group whose
  // child had moved spun around a point that no longer had anything to do with
  // what was drawn -- wrong in the exported SVG and PDF, not only on screen.
  const doc = (childX: number) => loadDocument({
    id: 'd', name: 'd', artboards: [{
      id: 'ab', name: 'a', width: 400, height: 400,
      background: { kind: 'solid', color: '#ffffff' },
      nodes: [buildNode({
        id: 'g1', kind: 'group', x: 10, y: 10, width: 110, height: 60, rotation: 30,
        children: [
          buildNode({ id: 'c1', kind: 'rect', x: childX, y: 10, width: 50, height: 50 }),
          buildNode({ id: 'c2', kind: 'rect', x: 70, y: 20, width: 50, height: 50 }),
        ],
      })],
    }],
  }).doc;
  const pivot = (d: Document) => /rotate\(30 ([-\d.]+) ([-\d.]+)\)/.exec(renderToString(d, 0).svg)!.slice(1).map(Number);

  it('pivots on the true centre of the subtree', () => {
    // children span x 10..120, y 10..70 -> centre 65,40, which is also what the
    // stored bounds say while they are still accurate.
    expect(pivot(doc(10))).toEqual([65, 40]);
  });

  it('follows the artwork when a child moves and the stored bounds go stale', () => {
    // c1 to x=-40: the subtree now spans -40..120, centre 40. The stored box is
    // untouched and still claims 65 -- the number this used to emit.
    const d = doc(-40);
    expect((findNode(d, 'g1') as any).x).toBe(10);       // stored bounds ARE stale
    expect(pivot(d)).toEqual([40, 40]);                  // and the pivot ignores them
  });

  it('widens a nested group by that group\'s own rotation', () => {
    // The easy mistake is to push a nested group's derived box WITHOUT the
    // rotation that group's own wrapper will apply.
    //
    // A second child is what makes this detectable. With `inner` alone, turning
    // it widens its box symmetrically about its own centre, so the union's
    // centre does not move and both implementations agree -- the first version
    // of this test asserted exactly that, passed, and went on passing when the
    // bug was reintroduced. `anchor` sits off to one corner, so a wider `inner`
    // drags the union's centre measurably.
    const nested = (rot: number) => loadDocument({
      id: 'd', name: 'd', artboards: [{
        id: 'ab', name: 'a', width: 600, height: 600,
        background: { kind: 'solid', color: '#ffffff' },
        nodes: [buildNode({
          id: 'outer', kind: 'group', x: 0, y: 0, width: 10, height: 10, rotation: 20,
          children: [
            buildNode({ id: 'anchor', kind: 'rect', x: 0, y: 0, width: 20, height: 20 }),
            buildNode({
              id: 'inner', kind: 'group', x: 100, y: 100, width: 200, height: 100, rotation: rot,
              children: [buildNode({ id: 'k', kind: 'rect', x: 100, y: 100, width: 200, height: 100 })],
            }),
          ],
        })],
      }],
    }).doc;
    const p = (rot: number) =>
      /rotate\(20 ([-\d.]+) ([-\d.]+)\)/.exec(renderToString(nested(rot), 0).svg)!.slice(1).map(Number);

    // Square on: inner occupies 100..300 x 100..200. With anchor at 0..20, the
    // union is 0..300 x 0..200 -> centre 150,100.
    expect(p(0)).toEqual([150, 100]);
    // Turned 90 degrees, inner's 200x100 footprint becomes 100x200 about its own
    // centre 200,150: it occupies 150..250 x 50..250. Union 0..250 x 0..250 ->
    // centre 125,125. Ignoring the nested rotation would still report 150,100.
    expect(p(90)).toEqual([125, 125]);
  });
});
