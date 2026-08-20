import type { Document, Artboard, Node, Fill, Diagnostic } from '@artboard/schema';
import { layoutText, metricMeasurer, objectFit, round, type Measurer } from '@artboard/engine';

/**
 * THE renderer. Emits an SVG scene graph as DATA.
 *  - the editor mounts it into the DOM (browser paints it, hit-testing free)
 *  - the CLI serializes it to a string (deterministic → golden tests)
 * One code path. No parity problem.
 */

export interface SceneNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SceneNode[];
  text?: string;
  /** document node id this element came from, for hit-testing and selection */
  nodeId?: string;
}

export interface RenderResult { scene: SceneNode; diagnostics: Diagnostic[]; }

export interface RenderOptions {
  measure?: Measurer;
  /** omit assets (data URIs) from output — used by golden tests to keep fixtures small */
  inlineAssets?: boolean;
}

let idSeq = 0;
const nextGradId = (prefix: string) => `${prefix}-${(idSeq++).toString(36)}`;

export function renderArtboard(doc: Document, artboard: Artboard, opts: RenderOptions = {}): RenderResult {
  idSeq = 0;                       // reset per render → deterministic ids
  const measure = opts.measure ?? metricMeasurer;
  const inlineAssets = opts.inlineAssets !== false;
  const diagnostics: Diagnostic[] = [];
  const defs: SceneNode[] = [];

  const bg = fillToPaint(artboard.background, defs);
  const children: SceneNode[] = [
    { tag: 'rect', attrs: { x: 0, y: 0, width: artboard.width, height: artboard.height, fill: bg } },
  ];

  for (const node of artboard.nodes as Node[]) {
    const el = renderNode(node, doc, defs, diagnostics, measure, inlineAssets);
    if (el) children.push(el);
  }

  const scene: SceneNode = {
    tag: 'svg',
    attrs: {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: `0 0 ${artboard.width} ${artboard.height}`,
      width: artboard.width,
      height: artboard.height,
    },
    children: defs.length ? [{ tag: 'defs', attrs: {}, children: defs }, ...children] : children,
  };
  return { scene, diagnostics };
}

function renderNode(
  node: Node, doc: Document, defs: SceneNode[], diagnostics: Diagnostic[],
  measure: Measurer, inlineAssets: boolean,
): SceneNode | null {
  const n = node as any;
  if (!n.visible) return null;

  const wrapAttrs: Record<string, string | number> = {};
  if (n.rotation) {
    wrapAttrs.transform = `rotate(${round(n.rotation)} ${round(n.x + n.width / 2)} ${round(n.y + n.height / 2)})`;
  }
  if (n.opacity !== 1) wrapAttrs.opacity = round(n.opacity);
  if (n.shadow) {
    const fid = nextGradId('sh');
    defs.push({
      tag: 'filter', attrs: { id: fid, x: '-50%', y: '-50%', width: '200%', height: '200%' },
      children: [{ tag: 'feDropShadow', attrs: { dx: n.shadow.x, dy: n.shadow.y, stdDeviation: round(n.shadow.blur / 2), 'flood-color': n.shadow.color } }],
    });
    wrapAttrs.filter = `url(#${fid})`;
  }

  let inner: SceneNode | SceneNode[] | null = null;

  switch (n.kind) {
    case 'rect':
      inner = { tag: 'rect', attrs: clean({
        x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height),
        rx: n.radius || undefined, ry: n.radius || undefined,
        fill: fillToPaint(n.fill, defs), ...strokeAttrs(n.stroke),
      }) };
      break;

    case 'ellipse':
      inner = { tag: 'ellipse', attrs: clean({
        cx: round(n.x + n.width / 2), cy: round(n.y + n.height / 2),
        rx: round(n.width / 2), ry: round(n.height / 2),
        fill: fillToPaint(n.fill, defs), ...strokeAttrs(n.stroke),
      }) };
      break;

    case 'line':
      inner = { tag: 'line', attrs: clean({
        x1: round(n.x), y1: round(n.y + n.height / 2),
        x2: round(n.x + n.width), y2: round(n.y + n.height / 2),
        'stroke-linecap': 'round', ...strokeAttrs(n.stroke, true),
      }) };
      break;

    case 'path': {
      const [vw, vh] = n.viewBox ?? [24, 24];
      const sx = n.width / (vw || 1), sy = n.height / (vh || 1);
      inner = { tag: 'g', attrs: { transform: `translate(${round(n.x)} ${round(n.y)}) scale(${round(sx)} ${round(sy)})` },
        children: [{ tag: 'path', attrs: clean({ d: n.d, fill: fillToPaint(n.fill, defs), ...strokeAttrs(n.stroke) }) }] };
      break;
    }

    case 'image': {
      const asset = doc.assets[n.assetId];
      if (!asset) {
        diagnostics.push({ level: 'error', code: 'ASSET_MISSING', nodeId: n.id, message: `Image "${n.assetId}" is missing.` });
        inner = placeholder(n);
        break;
      }
      const crop = objectFit(asset.width, asset.height, n.width, n.height, n.fit);
      const scale = n.width / crop.width;
      const clipId = nextGradId('clip');
      defs.push({ tag: 'clipPath', attrs: { id: clipId }, children: [
        { tag: 'rect', attrs: clean({ x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height), rx: n.radius || undefined }) },
      ]});
      inner = { tag: 'g', attrs: { 'clip-path': `url(#${clipId})` }, children: [
        { tag: 'image', attrs: {
          x: round(n.x - crop.x * scale), y: round(n.y - crop.y * scale),
          width: round(asset.width * scale), height: round(asset.height * scale),
          href: inlineAssets ? asset.data : `asset:${asset.id}`,
          preserveAspectRatio: 'none',
        }},
      ]};
      break;
    }

    case 'text': {
      const layout = layoutText(n, measure);
      if (layout.truncated) {
        diagnostics.push({ level: 'warn', code: 'TEXT_TRUNCATED', nodeId: n.id, message: 'Text too long to lay out; truncated.' });
      }
      const anchor = n.align === 'center' ? 'middle' : n.align === 'right' ? 'end' : 'start';
      inner = { tag: 'text', attrs: clean({
        x: round(n.x), y: round(n.y),
        'font-family': `${quoteFamily(n.fontFamily)}, ui-sans-serif, system-ui, sans-serif`,
        'font-size': round(n.fontSize),
        'font-weight': n.fontWeight,
        'font-style': n.italic ? 'italic' : undefined,
        'letter-spacing': n.letterSpacing || undefined,
        'text-anchor': anchor,
        fill: n.color,
        'xml:space': 'preserve',
      }), children: layout.lines.map(ln => ({
        tag: 'tspan',
        attrs: { x: round(n.x + ln.x), y: round(n.y + ln.y) },
        text: ln.text,
      })) };
      break;
    }

    case 'group': {
      const kids: SceneNode[] = [];
      for (const child of (n.children ?? []) as Node[]) {
        const el = renderNode(child, doc, defs, diagnostics, measure, inlineAssets);
        if (el) kids.push(el);
      }
      inner = { tag: 'g', attrs: {}, children: kids };
      break;
    }

    case 'opaque':
      diagnostics.push({ level: 'info', code: 'NODE_UNKNOWN', nodeId: n.id,
        message: `"${n.originalKind}" isn't supported in this version. It is preserved on save but not drawn.` });
      return null;

    default:
      return null;
  }

  const el: SceneNode = Array.isArray(inner) ? { tag: 'g', attrs: {}, children: inner } : inner!;
  el.nodeId = n.id;
  if (Object.keys(wrapAttrs).length === 0) return el;
  return { tag: 'g', attrs: wrapAttrs, children: [el], nodeId: n.id };
}

function placeholder(n: any): SceneNode {
  return { tag: 'g', attrs: {}, children: [
    { tag: 'rect', attrs: { x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height), fill: '#f3f4f6', stroke: '#d1d5db', 'stroke-width': 2, 'stroke-dasharray': '6 4' } },
    { tag: 'text', attrs: { x: round(n.x + n.width / 2), y: round(n.y + n.height / 2), 'text-anchor': 'middle', 'font-family': 'ui-sans-serif, sans-serif', 'font-size': 14, fill: '#9ca3af' }, text: 'Missing image' },
  ]};
}

function fillToPaint(fill: Fill | undefined, defs: SceneNode[]): string {
  if (!fill || fill.kind === 'none') return 'none';
  if (fill.kind === 'solid') return fill.color;
  const id = nextGradId('grad');
  const a = ((fill.angle - 90) * Math.PI) / 180;
  const x1 = round(50 - Math.cos(a) * 50), y1 = round(50 - Math.sin(a) * 50);
  const x2 = round(50 + Math.cos(a) * 50), y2 = round(50 + Math.sin(a) * 50);
  defs.push({
    tag: 'linearGradient',
    attrs: { id, x1: `${x1}%`, y1: `${y1}%`, x2: `${x2}%`, y2: `${y2}%` },
    children: fill.stops.map(s => ({ tag: 'stop', attrs: { offset: round(s.offset), 'stop-color': s.color } })),
  });
  return `url(#${id})`;
}

function strokeAttrs(stroke: any, required = false): Record<string, string | number | undefined> {
  if (!stroke || (!stroke.width && !required)) return {};
  return {
    stroke: stroke.color,
    'stroke-width': round(stroke.width || 0),
    'stroke-dasharray': stroke.dash?.length ? stroke.dash.join(' ') : undefined,
  };
}

const quoteFamily = (f: string) => (/[^a-zA-Z0-9-]/.test(f) ? `'${f.replace(/'/g, '')}'` : f);
const clean = (o: Record<string, any>): Record<string, string | number> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as any;

/* ── deterministic serialization (the golden-test oracle) ────────────────── */
export function serialize(scene: SceneNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  const attrs = Object.entries(scene.attrs).map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`).join('');
  if (scene.text !== undefined && !scene.children) return `${pad}<${scene.tag}${attrs}>${escapeText(scene.text)}</${scene.tag}>`;
  if (!scene.children || scene.children.length === 0) return `${pad}<${scene.tag}${attrs}/>`;
  const inner = scene.children.map(c => serialize(c, indent + 1)).join('\n');
  return `${pad}<${scene.tag}${attrs}>\n${inner}\n${pad}</${scene.tag}>`;
}

export function renderToString(doc: Document, artboardIndex = 0, opts: RenderOptions = {}): { svg: string; diagnostics: Diagnostic[] } {
  const ab = doc.artboards[artboardIndex];
  if (!ab) throw new Error(`Artboard ${artboardIndex} does not exist`);
  const { scene, diagnostics } = renderArtboard(doc, ab, opts);
  return { svg: serialize(scene), diagnostics };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
