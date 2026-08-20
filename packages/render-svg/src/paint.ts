import type { Fill } from '@artboard/schema';
import { round } from '@artboard/engine';

/** Structural mirror of the scene node in `index.ts` (kept local to avoid a cycle). */
export interface SceneNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SceneNode[];
  text?: string;
  nodeId?: string;
}

/** Mints the deterministic ids the renderer hands out (`nextGradId`). */
export type IdMinter = (prefix: string) => string;

/**
 * A `Fill` as a paint string, pushing any gradient it needs into `<defs>`.
 *
 * Gradients are in objectBoundingBox units, so one def paints whatever box it
 * is attached to — a rect, a photo frame or a headline — without recomputing.
 */
export function fillToPaint(fill: Fill | undefined, defs: SceneNode[], nextId: IdMinter): string {
  if (!fill || fill.kind === 'none') return 'none';
  if (fill.kind === 'solid') return fill.color;
  const id = nextId('grad');
  const stops = fill.stops.map(s => ({ tag: 'stop', attrs: { offset: round(s.offset), 'stop-color': s.color } }));

  if ((fill as any).type === 'radial') {
    const cx = (fill as any).cx ?? 0.5, cy = (fill as any).cy ?? 0.5, r = (fill as any).r ?? 0.5;
    defs.push({
      tag: 'radialGradient',
      attrs: { id, cx: `${round(cx * 100)}%`, cy: `${round(cy * 100)}%`, r: `${round(r * 100)}%` },
      children: stops,
    });
    return `url(#${id})`;
  }

  // angle is the compass bearing the gradient travels along: 90 = left→right.
  const a = ((fill.angle - 90) * Math.PI) / 180;
  const x1 = round(50 - Math.cos(a) * 50), y1 = round(50 - Math.sin(a) * 50);
  const x2 = round(50 + Math.cos(a) * 50), y2 = round(50 + Math.sin(a) * 50);
  defs.push({
    tag: 'linearGradient',
    attrs: { id, x1: `${x1}%`, y1: `${y1}%`, x2: `${x2}%`, y2: `${y2}%` },
    children: stops,
  });
  return `url(#${id})`;
}

/* ── arrowheads ─────────────────────────────────────────────────────────────
 * One `<marker>` per decorated end. Geometry lives in a 0..10 box and is
 * mirrored for the start end rather than relying on SVG 2's
 * `orient="auto-start-reverse"`, which not every rasteriser implements.
 *
 * Colour: `style="fill:context-stroke"` wins in renderers that support SVG 2
 * context paint; everywhere else the declaration is dropped as invalid and the
 * `fill` presentation attribute — the node's own stroke colour — takes over.
 * Either way the arrowhead matches the line it belongs to.
 * ------------------------------------------------------------------------ */

type MarkerShape = 'none' | 'arrow' | 'dot' | 'bar';

interface MarkerSpec { refX: number; refY: number; w: number; h: number; child: SceneNode }

function markerSpec(shape: Exclude<MarkerShape, 'none'>, start: boolean, color: string): MarkerSpec {
  const paint = { fill: color, style: 'fill:context-stroke' };
  if (shape === 'arrow') {
    return start
      ? { refX: 0, refY: 5, w: 5, h: 5, child: { tag: 'path', attrs: { d: 'M10,0 L0,5 L10,10 Z', ...paint } } }
      : { refX: 10, refY: 5, w: 5, h: 5, child: { tag: 'path', attrs: { d: 'M0,0 L10,5 L0,10 Z', ...paint } } };
  }
  if (shape === 'dot') {
    return { refX: 5, refY: 5, w: 4, h: 4, child: { tag: 'circle', attrs: { cx: 5, cy: 5, r: 4.5, ...paint } } };
  }
  // bar: a perpendicular tick, the classic dimension-line end
  return { refX: 5, refY: 5, w: 3, h: 3, child: { tag: 'rect', attrs: { x: 3, y: 0, width: 4, height: 10, ...paint } } };
}

/**
 * `marker-start` / `marker-end` attributes for a stroke, pushing the defs.
 * Returns `{}` when the stroke is invisible or carries no markers, so nothing
 * about today's output changes for a document that never asked for arrowheads.
 */
export function markerAttrs(stroke: any, defs: SceneNode[], nextId: IdMinter, forced = false): Record<string, string> {
  if (!stroke) return {};
  if (!stroke.width && !forced) return {};
  const out: Record<string, string> = {};
  for (const end of ['Start', 'End'] as const) {
    const shape = stroke[`marker${end}`] as MarkerShape | undefined;
    if (!shape || shape === 'none') continue;
    const spec = markerSpec(shape, end === 'Start', stroke.color ?? '#000000');
    const id = nextId('mk');
    defs.push({
      tag: 'marker',
      attrs: {
        id, viewBox: '0 0 10 10',
        refX: spec.refX, refY: spec.refY,
        markerWidth: spec.w, markerHeight: spec.h,
        markerUnits: 'strokeWidth',
        orient: 'auto',
      },
      children: [spec.child],
    });
    out[`marker-${end.toLowerCase()}`] = `url(#${id})`;
  }
  return out;
}
