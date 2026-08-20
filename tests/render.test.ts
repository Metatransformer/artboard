import { describe, it, expect } from 'vitest';
import { loadDocument, type Document } from '@artboard/schema';
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
    expect(scene.children).toHaveLength(1);
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
    const wrapper = scene.children![1]!;
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
    expect(scene.children).toHaveLength(1);
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

describe('render: known bugs', () => {
  const portraitInSquare = (fit: string) => renderToString(docWith(
    [{ id: 'i1', kind: 'image', assetId: 'a', x: 0, y: 0, width: 100, height: 100, fit }],
    { assets: { a: { id: 'a', mime: 'image/png', width: 100, height: 200, data: 'data:,x' } } },
  )).svg.match(/<image[^>]*>/)![0];

  // BUG: the renderer derives its scale from the crop WIDTH alone
  // (packages/render-svg/src/index.ts:125 `const scale = n.width / crop.width`).
  // objectFit returns the full source rect for both 'contain' and 'fill', so both
  // fits render at the source aspect ratio scaled to the box width — 'contain'
  // never letterboxes and 'fill' never stretches. Only 'cover' behaves as named.
  // Fix: scale by min(dw/cw, dh/ch) for contain, and by each axis for fill.
  it.fails('contain letterboxes a portrait source so it fits inside the box', () => {
    // 100×200 source in a 100×100 box should draw 50×100
    expect(portraitInSquare('contain')).toContain('height="100"');   // actual: height="200"
  });

  it.fails('fill stretches a portrait source to exactly the box', () => {
    expect(portraitInSquare('fill')).toContain('height="100"');      // actual: height="200"
  });

  it.fails('renders contain and fill differently from each other', () => {
    expect(portraitInSquare('contain')).not.toBe(portraitInSquare('fill'));
  });
});
