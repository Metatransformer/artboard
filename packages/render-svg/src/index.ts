import type { Document, Artboard, Node, Diagnostic, Effect } from '@artboard/schema';
import { layoutText, metricMeasurer, nodeBox, objectFit, round, type Measurer } from '@artboard/engine';

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
   * Document-level accessibility scaffolding: `role="img"` plus a `<title>` on
   * the root `<svg>`, and `aria-hidden="true"` on shapes carrying no `alt`.
   *
   * **On unless explicitly set to `false`.** An exported SVG usually lands in a
   * web page, so emitting inaccessible markup by default would make every user
   * ship an accessibility bug they never chose. Pass `false` for a raster
   * pipeline, where the a11y tree is dead weight.
   *
   * Per-node `alt` text renders either way — it is opt-in per node already.
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
  const a11y = opts.a11y !== false;
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
    const el = renderNode(node, doc, defs, diagnostics, measure, inlineAssets, a11y);
    if (el) children.push(el);
  }

  const head: SceneNode[] = [];
  if (a11y) head.push({ tag: 'title', attrs: {}, text: doc.name || artboard.name || 'Untitled' });
  if (defs.length) head.push({ tag: 'defs', attrs: {}, children: defs });

  const scene: SceneNode = {
    tag: 'svg',
    attrs: clean({
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: `0 0 ${artboard.width} ${artboard.height}`,
      width: artboard.width,
      height: artboard.height,
      role: a11y ? 'img' : undefined,
    }),
    children: head.length ? [...head, ...children] : children,
  };
  return { scene, diagnostics };
}


function renderNode(
  node: Node, doc: Document, defs: SceneNode[], diagnostics: Diagnostic[],
  measure: Measurer, inlineAssets: boolean, a11y = true,
): SceneNode | null {
  const n = node as any;
  if (!n.visible) return null;

  const wrapAttrs: Record<string, string | number> = {};
  // Transform list applies right-to-left: the node is mirrored about its own
  // centre FIRST, then rotated. Flipping a rotated node therefore mirrors it
  // inside its own frame and leaves the rotation reading the same, which is
  // what every design tool does — and what flipping after the rotation would
  // not do (that mirrors the rotation itself).
  // `nodeBox` because a group's stored box is a cache with no invalidation.
  // Everywhere else that is a display problem; here it is the rotation PIVOT,
  // so a group whose child moved rotated around a point with nothing to do
  // with its contents -- wrong in the exported SVG and PDF, not only on
  // screen. The derivation now lives in the engine, which owns geometry, and
  // the editor reads the same function, so the handles and the exported file
  // cannot disagree about where a group is.
  //
  // For an ACCURATE group this is the identical number. One golden baseline
  // did move -- groups-and-shadow, whose groups are hand-authored with round
  // bounds (gr-nested is stored 170 wide; its children span 690..850 = 160),
  // so its stored boxes were never accurate and its rotated groups pivoted on
  // centres that were simply made up. That fixture is the one place the golden
  // oracle watches this code: do not "correct" its bounds to match its
  // children, or the only fixture covering derived pivots stops covering
  // anything. The unit tests in tests/render.test.ts carry the proof
  // independently of the baseline.
  const box = nodeBox(n);
  const cx = round(box.x + box.width / 2), cy = round(box.y + box.height / 2);
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
      // TextLayout.diagnostics is documented "Renderers forward these", and
      // for a long time this one did not -- so FONT_SUBSTITUTED was raised on
      // every unmeasured family and reached nobody. Found by asking which
      // diagnostic codes no fixture had ever provoked, which is a question
      // only tools/golden-coverage.mjs can ask.
      diagnostics.push(...layout.diagnostics);
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
        if (n.underline || n.strikethrough) {
          diagnostics.push({ level: 'warn', code: 'CURVE_NO_RULES', nodeId: n.id,
            message: 'Curved text cannot be underlined or struck through; the rule would not follow the arc.' });
        }
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

      const rules = (n.underline || n.strikethrough) ? textRules(n, layout.lines, anchor) : '';
      if (rules) {
        // After the <text>, so a rule sits over the glyphs the way
        // text-decoration does. Same paint as the text: a rule in a different
        // colour from the word it belongs to is not a thing anyone asked for.
        inner = [inner, { tag: 'path', attrs: { d: rules, fill: textPaint(n, defs) } }];
      }
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

/**
 * Elements whose child whitespace is CONTENT, not formatting.
 *
 * Inside <text>, the newline and indent a pretty-printer puts before a <tspan>
 * are real characters. With xml:space="preserve" they are five space glyphs;
 * without it XML collapses them to one. Either way they join the anchor chunk,
 * so a text-anchor="middle" run centres on its text PLUS that whitespace and
 * text-anchor="end" ends that much early -- 55px at font-size 44 and four
 * levels of indent, and the offset grows with nesting depth.
 *
 * The bug was invisible to everything that watched this function. The goldens
 * diff the STRING, and the string was stable; the editor mounts the same scene
 * graph through React, which never emits the whitespace, so the editor was
 * right and only the export was wrong. It took drawing an underline -- a rule
 * placed at the position the text was SUPPOSED to occupy -- for the gap to
 * become something you could see.
 */
const TEXT_CONTENT = new Set(['text', 'tspan', 'textPath']);

export function serialize(scene: SceneNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  const attrs = Object.entries(scene.attrs).map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`).join('');
  if (scene.text !== undefined && !scene.children) return `${pad}<${scene.tag}${attrs}>${escapeText(scene.text)}</${scene.tag}>`;
  if (!scene.children || scene.children.length === 0) return `${pad}<${scene.tag}${attrs}/>`;
  if (TEXT_CONTENT.has(scene.tag)) {
    return `${pad}<${scene.tag}${attrs}>${scene.children.map(c => serialize(c, 0)).join('')}</${scene.tag}>`;
  }
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

/* -- text rules (underline, strikethrough) --------------------------------
 *
 * Drawn as real geometry rather than `text-decoration="underline"`, because
 * text-decoration is a browser feature: Chrome draws it, resvg draws it, and
 * a PDF built from this scene graph draws nothing at all. A document is
 * supposed to look the same in the editor, the CLI and the export, and an
 * attribute only two of the three honour breaks that quietly -- the SVG on
 * screen would be right and the PDF would be missing a line.
 *
 * One <path> holds every rule rather than a <line> or a <rect> each. Two
 * reasons, and the first is not cosmetic: gradients here are in
 * objectBoundingBox units, so a zero-height <line> has a degenerate box and
 * does not paint at all, while a per-line <rect> would restart the gradient
 * inside each rule. A single path's box spans the whole block, close enough
 * to the <text> element's own box that one gradient reads as continuous
 * across the words and the lines under them.
 * ---------------------------------------------------------------------- */

/** post.underlinePosition / OS/2.yStrikeoutPosition, as a fraction of the em.
 *  These are the conventional defaults, not measured per family: FamilyMetrics
 *  carries advances and vertical metrics, not the post/OS-2 rule fields. If it
 *  ever gains them, read them here -- the shape of this code does not change. */
const RULE_THICKNESS = 0.06;
const UNDERLINE_DROP = 0.11;   // below the baseline, to the top of the rule
const STRIKE_RISE = 0.28;      // above the baseline, to the centre of the rule

function textRules(n: any, lines: readonly { text: string; width: number; x: number; y: number }[], anchor: string): string {
  const size = n.fontSize;
  const thickness = round(size * RULE_THICKNESS);
  if (thickness <= 0) return '';

  const parts: string[] = [];
  for (const ln of lines) {
    // A blank line has no glyphs to underline. Ruling it draws a floating dash
    // in the gap between paragraphs, which no word processor does either.
    if (ln.text === '' || ln.width <= 0) continue;
    const left = round(n.x + ln.x - (anchor === 'middle' ? ln.width / 2 : anchor === 'end' ? ln.width : 0));
    const width = round(ln.width);
    const baseline = n.y + ln.y;
    if (n.underline) parts.push(`M${left} ${round(baseline + size * UNDERLINE_DROP)}h${width}v${thickness}h${-width}Z`);
    if (n.strikethrough) parts.push(`M${left} ${round(baseline - size * STRIKE_RISE - thickness / 2)}h${width}v${thickness}h${-width}Z`);
  }
  return parts.join('');
}
