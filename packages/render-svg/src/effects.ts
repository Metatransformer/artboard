import type { Effect } from '@artboard/schema';

/**
 * Effects, compiled to SVG.
 *
 * Every effect in the schema is data. This module turns a node's effect list
 * into (a) filter primitives, (b) elements drawn behind the node, and (c)
 * elements drawn over it. Nothing here reads the DOM or measures anything, so
 * the CLI and the editor produce byte-identical output.
 *
 * Ordering is fixed and deliberate:
 *   1. adjust / duotone / blur   change the node's own pixels
 *   2. outline / glow / echo / shadow  paint *behind* it, furthest first
 * so a glow never washes out the thing it is glowing around.
 */

export interface SceneNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SceneNode[];
  text?: string;
  nodeId?: string;
}

const n = (v: number, dp = 4) => {
  const r = Number(v.toFixed(dp));
  return Object.is(r, -0) ? 0 : r;
};

/* ── colour helpers ─────────────────────────────────────────────────────── */

/** #rgb / #rrggbb / #rrggbbaa -> [r,g,b] in 0..1 plus alpha. */
export function rgba(hex: string): { r: number; g: number; b: number; a: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const int = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: int(0), g: int(2), b: int(4), a: h.length === 8 ? int(6) : 1 };
}

/* ── colour matrices ────────────────────────────────────────────────────── */

const SEPIA = [
  0.393, 0.769, 0.189, 0, 0,
  0.349, 0.686, 0.168, 0, 0,
  0.272, 0.534, 0.131, 0, 0,
  0, 0, 0, 1, 0,
];
const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

const lerpMatrix = (t: number) => IDENTITY.map((v, i) => n(v + (SEPIA[i]! - v) * t, 5)).join(' ');

/* ── filter compilation ─────────────────────────────────────────────────── */

interface Compiled {
  /** Primitives for the <filter>, in order. Empty means no filter is needed. */
  primitives: SceneNode[];
  /** Extra <defs> children (gradients used by vignette, etc.). */
  defs: SceneNode[];
  /** Drawn before the node, inside the same transform. */
  behind: SceneNode[];
  /** Drawn after the node, inside the same transform. */
  over: SceneNode[];
}

export function compileEffects(
  effects: readonly Effect[],
  box: { x: number; y: number; width: number; height: number },
  id: (prefix: string) => string,
): Compiled {
  const primitives: SceneNode[] = [];
  const defs: SceneNode[] = [];
  const behind: SceneNode[] = [];
  const over: SceneNode[] = [];

  let src = 'SourceGraphic';
  let step = 0;
  const next = () => `e${++step}`;
  const push = (tag: string, attrs: Record<string, string | number>, children?: SceneNode[]) => {
    const result = next();
    primitives.push({ tag, attrs: { ...attrs, result }, ...(children ? { children } : {}) });
    return result;
  };

  /* 1. pixel-changing effects, in schema order --------------------------- */
  for (const fx of effects) {
    if (fx.kind === 'adjust') {
      const { brightness, contrast, saturation, hue, sepia, invert } = fx;
      if (brightness !== 0 || contrast !== 0) {
        // slope/intercept is the standard linear transfer: contrast pivots on
        // mid-grey, brightness slides the whole ramp.
        const k = 1 + contrast / 100;
        const b = brightness / 100;
        const slope = n(k), intercept = n(0.5 - k * 0.5 + b);
        const fn = (ch: string) => ({ tag: `feFunc${ch}`, attrs: { type: 'linear', slope, intercept } });
        src = push('feComponentTransfer', { in: src }, [fn('R'), fn('G'), fn('B')]);
      }
      if (saturation !== 0) src = push('feColorMatrix', { in: src, type: 'saturate', values: n(1 + saturation / 100) });
      if (hue !== 0) src = push('feColorMatrix', { in: src, type: 'hueRotate', values: n(hue) });
      if (sepia > 0) src = push('feColorMatrix', { in: src, type: 'matrix', values: lerpMatrix(sepia / 100) });
      if (invert > 0) {
        const t = n(invert / 100);
        const fn = (ch: string) => ({ tag: `feFunc${ch}`, attrs: { type: 'table', tableValues: `${t} ${n(1 - t)}` } });
        src = push('feComponentTransfer', { in: src }, [fn('R'), fn('G'), fn('B')]);
      }
    } else if (fx.kind === 'duotone') {
      const d = rgba(fx.dark), l = rgba(fx.light);
      const grey = push('feColorMatrix', { in: src, type: 'saturate', values: 0 });
      const fn = (ch: string, a: number, b: number) =>
        ({ tag: `feFunc${ch}`, attrs: { type: 'table', tableValues: `${n(a, 4)} ${n(b, 4)}` } });
      src = push('feComponentTransfer', { in: grey }, [fn('R', d.r, l.r), fn('G', d.g, l.g), fn('B', d.b, l.b)]);
    } else if (fx.kind === 'blur') {
      if (fx.radius > 0) src = push('feGaussianBlur', { in: src, stdDeviation: n(fx.radius) });
    }
  }

  /* 2. layers painted behind, furthest first ----------------------------- */
  const layers: string[] = [];

  /** alpha -> flood -> composite: one solid-coloured copy of the silhouette. */
  const silhouette = (alphaIn: string, color: string, opacity: number) => {
    const c = rgba(color);
    const flood = push('feFlood', { 'flood-color': color, 'flood-opacity': n(opacity * c.a) });
    return push('feComposite', { in: flood, in2: alphaIn, operator: 'in' });
  };

  for (const fx of effects) {
    if (fx.kind === 'echo') {
      // Furthest copy first so nearer copies sit on top of it.
      for (let i = fx.count; i >= 1; i--) {
        const off = push('feOffset', { in: 'SourceAlpha', dx: n(fx.dx * i), dy: n(fx.dy * i) });
        layers.push(silhouette(off, fx.color, fx.opacity));
      }
    } else if (fx.kind === 'shadow') {
      let alpha = 'SourceAlpha';
      if (fx.spread !== 0) {
        alpha = push('feMorphology', {
          in: 'SourceAlpha',
          operator: fx.spread > 0 ? 'dilate' : 'erode',
          radius: n(Math.abs(fx.spread)),
        });
      }
      const off = push('feOffset', { in: alpha, dx: n(fx.x), dy: n(fx.y) });
      const blurred = fx.blur > 0 ? push('feGaussianBlur', { in: off, stdDeviation: n(fx.blur / 2) }) : off;
      layers.push(silhouette(blurred, fx.color, fx.opacity));
    } else if (fx.kind === 'glow') {
      const grown = push('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: n(Math.max(1, fx.blur / 4)) });
      const blurred = push('feGaussianBlur', { in: grown, stdDeviation: n(Math.max(0.5, fx.blur / 2)) });
      layers.push(silhouette(blurred, fx.color, fx.opacity));
    } else if (fx.kind === 'outline') {
      if (fx.width > 0) {
        const grown = push('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: n(fx.width) });
        layers.push(silhouette(grown, fx.color, 1));
      }
    } else if (fx.kind === 'background') {
      behind.push(textPlate(fx, box));
    } else if (fx.kind === 'vignette') {
      // A mask, not a filter primitive: filters would darken the shadow layers too.
      const gid = id('vig');
      const c = rgba(fx.color);
      defs.push({
        tag: 'radialGradient',
        attrs: { id: gid, cx: '50%', cy: '50%', r: '72%' },
        children: [
          { tag: 'stop', attrs: { offset: '55%', 'stop-color': fx.color, 'stop-opacity': 0 } },
          { tag: 'stop', attrs: { offset: '100%', 'stop-color': fx.color, 'stop-opacity': n(c.a * fx.amount / 100) } },
        ],
      });
      over.push({ tag: 'rect', attrs: { x: n(box.x), y: n(box.y), width: n(box.width), height: n(box.height), fill: `url(#${gid})`, 'pointer-events': 'none' } });
    }
  }

  if (layers.length) {
    primitives.push({
      tag: 'feMerge',
      attrs: {},
      children: [...layers, src].map(l => ({ tag: 'feMergeNode', attrs: { in: l } })),
    });
  } else if (src !== 'SourceGraphic') {
    // Nothing to merge, but the chain must still end at the filter output.
    const last = primitives[primitives.length - 1];
    if (last) delete last.attrs.result;
  }

  return { primitives, defs, behind, over };
}

/**
 * The text "background" effect is a real rectangle, not a filter - a filter
 * cannot know where the text block actually sits after layout.
 */
export function textPlate(
  fx: Extract<Effect, { kind: 'background' }>,
  block: { x: number; y: number; width: number; height: number },
): SceneNode {
  return {
    tag: 'rect',
    attrs: {
      x: n(block.x - fx.padding), y: n(block.y - fx.padding),
      width: n(block.width + fx.padding * 2), height: n(block.height + fx.padding * 2),
      rx: n(fx.radius), fill: fx.color,
      ...(fx.opacity < 1 ? { opacity: n(fx.opacity) } : {}),
    },
  };
}

/**
 * Curved text rides an arc. `amount` is a percentage where 100 bends hard;
 * positive bulges up, negative down.
 *
 * The arc is built so its MIDPOINT stays exactly on the original baseline -
 * the ends move, the centre does not. Without that the text walks out of its
 * own box as soon as you touch the slider, which is what every naive
 * implementation gets wrong.
 */
export function curvePath(amount: number, x0: number, width: number, baselineY: number): string {
  const sag = (amount / 100) * (width * 0.2);
  const x1 = x0 + width;
  if (Math.abs(sag) < 0.01) return `M ${n(x0)} ${n(baselineY)} L ${n(x1)} ${n(baselineY)}`;
  // Quadratic midpoint is (P0 + 2*C + P2) / 4, so ends at +sag and a control
  // at -sag put the midpoint back on baselineY exactly.
  return `M ${n(x0)} ${n(baselineY + sag)} Q ${n(x0 + width / 2)} ${n(baselineY - sag)} ${n(x1)} ${n(baselineY + sag)}`;
}

export const hasFilterEffects = (effects: readonly Effect[]): boolean =>
  effects.some(f => f.kind === 'adjust' || f.kind === 'duotone' || f.kind === 'blur'
    || f.kind === 'shadow' || f.kind === 'glow' || f.kind === 'echo' || f.kind === 'outline');
