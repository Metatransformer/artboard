import type { Document, Artboard, Node, Diagnostic, Effect } from '@artboard/schema';
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
  /**
   * Emit the document-level accessibility scaffolding: `role="img"` plus a
   * `<title>` on the root `<svg>`, and `aria-hidden="true"` on shapes that
   * carry no `alt`. Off by default because it changes every byte of output for
   * every existing document; per-node `alt` text always renders.
   */
  a11y?: boolean;
}

import { compileEffects, curvePath } from './effects';
import { fillToPaint, markerAttrs } from './paint';
export { polygonPath, starPath, roundedPolygonPath } from './shapes';

let idSeq = 0;
const nextGradId = (prefix: string) => `${prefix}-${(idSeq++).toString(36)}`;

export function renderArtboard(doc: Document, artboard: Artboard, opts: RenderOptions = {}): RenderResult {
  idSeq = 0;                       // reset per render → deterministic ids
  const measure = opts.measure ?? metricMeasurer;
  const inlineAssets = opts.inlineAssets !== false;
  const diagnostics: Diagnostic[] = [];
  const defs: SceneNode[] = [];

  // A `none` background draws nothing at all: the exported SVG is genuinely
  // transparent, rather than white pixels pretending to be transparent.
  const children: SceneNode[] = [];
  if (artboard.background && artboard.background.kind !== 'none') {
    children.push({ tag: 'rect', attrs: { x: 0, y: 0, width: artboard.width, height: artboard.height,
      fill: fillToPaint(artboard.background, defs, nextGradId) } });
  }

  for (const node of artboard.nodes as Node[]) {
    const el = renderNode(node, doc, defs, diagnostics, measure, inlineAssets, !!opts.a11y);
    if (el) children.push(el);
  }

  const head: SceneNode[] = [];
  if (opts.a11y) head.push({ tag: 'title', attrs: {}, text: doc.name || artboard.name || 'Untitled' });
  if (defs.length) head.push({ tag: 'defs', attrs: {}, children: defs });

  const scene: SceneNode = {
    tag: 'svg',
    attrs: clean({
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: `0 0 ${artboard.width} ${artboard.height}`,
      width: artboard.width,
      height: artboard.height,
      role: opts.a11y ? 'img' : undefined,
    }),
    children: head.length ? [...head, ...children] : children,
  };
  return { scene, diagnostics };
}

function renderNode(
  node: Node, doc: Document, defs: SceneNode[], diagnostics: Diagnostic[],
  measure: Measurer, inlineAssets: boolean, a11y = false,
): SceneNode | null {
  const n = node as any;
  if (!n.visible) return null;

  const wrapAttrs: Record<string, string | number> = {};
  // Transform list applies right-to-left: the node is mirrored about its own
  // centre FIRST, then rotated. Flipping a rotated node therefore mirrors it
  // inside its own frame and leaves the rotation reading the same, which is
  // what every design tool does — and what flipping after the rotation would
  // not do (that mirrors the rotation itself).
  const cx = round(n.x + n.width / 2), cy = round(n.y + n.height / 2);
  const tf: string[] = [];
  if (n.rotation) tf.push(`rotate(${round(n.rotation)} ${cx} ${cy})`);
  if (n.flipX || n.flipY) {
    tf.push(`translate(${cx} ${cy}) scale(${n.flipX ? -1 : 1} ${n.flipY ? -1 : 1}) translate(${round(-cx)} ${round(-cy)})`);
  }
  if (tf.length) wrapAttrs.transform = tf.join(' ');
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
        fill: fillToPaint(n.fill, defs, nextGradId), ...strokeAttrs(n.stroke),
      }) };
      break;

    case 'ellipse':
      inner = { tag: 'ellipse', attrs: clean({
        cx: round(n.x + n.width / 2), cy: round(n.y + n.height / 2),
        rx: round(n.width / 2), ry: round(n.height / 2),
        fill: fillToPaint(n.fill, defs, nextGradId), ...strokeAttrs(n.stroke),
      }) };
      break;

    case 'line':
      inner = { tag: 'line', attrs: clean({
        x1: round(n.x), y1: round(n.y + n.height / 2),
        x2: round(n.x + n.width), y2: round(n.y + n.height / 2),
        'stroke-linecap': 'round', ...strokeAttrs(n.stroke, true), ...markerAttrs(n.stroke, defs, nextGradId, true),
      }) };
      break;

    case 'path': {
      const [vw, vh] = n.viewBox ?? [24, 24];
      const sx = n.width / (vw || 1), sy = n.height / (vh || 1);
      inner = { tag: 'g', attrs: { transform: `translate(${round(n.x)} ${round(n.y)}) scale(${round(sx)} ${round(sy)})` },
        children: [{ tag: 'path', attrs: clean({ d: n.d, fill: fillToPaint(n.fill, defs, nextGradId), ...strokeAttrs(n.stroke), ...markerAttrs(n.stroke, defs, nextGradId) }) }] };
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
      // One scale PER AXIS. `cover` and `contain` lock the two together so the
      // photo is never distorted — cover fills the box and overflows, contain
      // fits inside it and letterboxes — while `fill` scales each axis on its
      // own, which is the entire point of it. Deriving a single `scale` from
      // the width alone (what this did before) made contain and fill render
      // identically to cover: a portrait photo in a square box overflowed and
      // was clipped instead of being letterboxed. `objectFit` hands back the
      // whole source rect for both, so the fit has to be honoured HERE.
      const fitX = n.width / crop.width, fitY = n.height / crop.height;
      const sx = n.fit === 'fill' ? fitX : n.fit === 'contain' ? Math.min(fitX, fitY) : Math.max(fitX, fitY);
      const sy = n.fit === 'fill' ? fitY : sx;
      // Centre the scaled crop in the node box. Zero for cover and fill, which
      // both cover the box exactly; the letterbox margin for contain.
      const ox = (n.width - crop.width * sx) / 2, oy = (n.height - crop.height * sy) / 2;
      const clipId = nextGradId('clip');
      defs.push({ tag: 'clipPath', attrs: { id: clipId }, children: [frameShape(n)] });
      inner = { tag: 'g', attrs: { 'clip-path': `url(#${clipId})` }, children: [
        { tag: 'image', attrs: {
          x: round(n.x + ox - crop.x * sx), y: round(n.y + oy - crop.y * sy),
          width: round(asset.width * sx), height: round(asset.height * sy),
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

      // Curved text rides a path, so it cannot also be wrapped into lines.
      // We arc the first line and say so in the diagnostics rather than
      // silently dropping the rest.
      const curve = ((n.effects ?? []) as Effect[]).find(f => f.kind === 'curve') as
        Extract<Effect, { kind: 'curve' }> | undefined;
      if (curve) {
        const first = layout.lines[0];
        if (layout.lines.length > 1) {
          diagnostics.push({ level: 'warn', code: 'CURVE_SINGLE_LINE', nodeId: n.id,
            message: 'Curved text uses the first line only. Shorten the text or widen the box.' });
        }
        const pid = nextGradId('curve');
        defs.push({ tag: 'path', attrs: { id: pid, d: curvePath(curve.amount, n.x, n.width, n.y + (first?.y ?? 0)), fill: 'none' } });
        inner = { tag: 'text', attrs: clean({
          'font-family': `${quoteFamily(n.fontFamily)}, ui-sans-serif, system-ui, sans-serif`,
          'font-size': round(n.fontSize),
          'font-weight': n.fontWeight,
          'font-style': n.italic ? 'italic' : undefined,
          'letter-spacing': n.letterSpacing || undefined,
          fill: textPaint(n, defs),
          'text-anchor': anchor,
          'xml:space': 'preserve',
        }), children: [{
          tag: 'textPath',
          attrs: clean({ href: `#${pid}`, startOffset: anchor === 'start' ? '0%' : anchor === 'end' ? '100%' : '50%' }),
          text: first?.text ?? '',
        }] };
        break;
      }

      inner = { tag: 'text', attrs: clean({
        x: round(n.x), y: round(n.y),
        'font-family': `${quoteFamily(n.fontFamily)}, ui-sans-serif, system-ui, sans-serif`,
        'font-size': round(n.fontSize),
        'font-weight': n.fontWeight,
        'font-style': n.italic ? 'italic' : undefined,
        'letter-spacing': n.letterSpacing || undefined,
        'text-anchor': anchor,
        fill: textPaint(n, defs),
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
        const el = renderNode(child, doc, defs, diagnostics, measure, inlineAssets, a11y);
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

  // Accessibility: a named node gets a real <title>; an unnamed decorative
  // shape is hidden from assistive tech so a screen reader hears the picture,
  // not a list of rectangles.
  const alt: string = typeof n.alt === 'string' ? n.alt.trim() : '';
  const titleEl: SceneNode | null = alt ? { tag: 'title', attrs: {}, text: alt } : null;
  if (!alt && a11y && DECORATIVE.has(n.kind)) el.attrs['aria-hidden'] = 'true';

  // Stacked effects wrap the drawn element: filtered content first, then any
  // overlay (a vignette must not be blurred by the filter it sits above).
  let content: SceneNode = el;
  const fx = (n.effects ?? []) as Effect[];
  if (fx.length) {
    const box = { x: n.x, y: n.y, width: n.width, height: n.height };
    const c = compileEffects(fx, box, nextGradId);
    defs.push(...c.defs);
    if (c.behind.length) content = { tag: 'g', attrs: {}, children: [...c.behind, content] };
    if (c.primitives.length) {
      const fid = nextGradId('fx');
      defs.push({
        tag: 'filter',
        attrs: { id: fid, x: '-50%', y: '-50%', width: '200%', height: '200%', 'color-interpolation-filters': 'sRGB' },
        children: c.primitives,
      });
      content = { tag: 'g', attrs: { filter: `url(#${fid})` }, children: [content] };
    }
    if (c.over.length) content = { tag: 'g', attrs: {}, children: [content, ...c.over] };
  }
  if (n.blend && n.blend !== 'normal') wrapAttrs.style = `mix-blend-mode:${n.blend}`;

  if (!titleEl && content === el && Object.keys(wrapAttrs).length === 0) return el;
  // Exactly ONE element per node carries the id, and it is the outermost one.
  // Leaving it on the inner element too puts two `data-node-id="x"` nodes in
  // the DOM, which makes hit-testing and bounding-box reads pick whichever the
  // browser happened to return first.
  el.nodeId = undefined;
  return { tag: 'g', attrs: wrapAttrs, children: titleEl ? [titleEl, content] : [content], nodeId: n.id };
}

/** Shapes that carry no meaning of their own when they have no `alt`. */
const DECORATIVE = new Set(['rect', 'ellipse', 'line', 'path']);

/** `TextNode.fill` wins over the legacy single `color` when it is present. */
function textPaint(n: any, defs: SceneNode[]): string {
  return n.fill ? fillToPaint(n.fill, defs, nextGradId) : n.color;
}

/**
 * The shape a photo is poured into. A frame is a clip path, not a mask, so the
 * image keeps its own pixels and can still be repositioned inside the frame.
 */
function frameShape(n: any): SceneNode {
  if (n.frame === 'ellipse') {
    return { tag: 'ellipse', attrs: {
      cx: round(n.x + n.width / 2), cy: round(n.y + n.height / 2),
      rx: round(n.width / 2), ry: round(n.height / 2),
    }};
  }
  if (n.frame === 'path' && n.frameD) {
    const [vw, vh] = (n.frameBox ?? [24, 24]) as [number, number];
    const sx = n.width / (vw || 1), sy = n.height / (vh || 1);
    return { tag: 'path', attrs: {
      d: n.frameD,
      transform: `translate(${round(n.x)} ${round(n.y)}) scale(${round(sx)} ${round(sy)})`,
    }};
  }
  return { tag: 'rect', attrs: clean({
    x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height),
    rx: n.radius || undefined,
  })};
}

function placeholder(n: any): SceneNode {
  return { tag: 'g', attrs: {}, children: [
    { tag: 'rect', attrs: { x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height), fill: '#f3f4f6', stroke: '#d1d5db', 'stroke-width': 2, 'stroke-dasharray': '6 4' } },
    { tag: 'text', attrs: { x: round(n.x + n.width / 2), y: round(n.y + n.height / 2), 'text-anchor': 'middle', 'font-family': 'ui-sans-serif, sans-serif', 'font-size': 14, fill: '#9ca3af' }, text: 'Missing image' },
  ]};
}

function strokeAttrs(stroke: any, required = false): Record<string, string | number | undefined> {
  if (!stroke || (!stroke.width && !required)) return {};
  const out: Record<string, string | number | undefined> = {
    stroke: stroke.color,
    'stroke-width': round(stroke.width || 0),
    'stroke-dasharray': stroke.dash?.length ? stroke.dash.join(' ') : undefined,
  };
  // Only present when they differ from the SVG default — the key must stay
  // absent rather than be set to undefined, or it would spread over the cap a
  // caller set before it (the `line` case does exactly that).
  if (stroke.cap && stroke.cap !== 'butt') out['stroke-linecap'] = stroke.cap;
  if (stroke.join && stroke.join !== 'miter') out['stroke-linejoin'] = stroke.join;
  return out;
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
