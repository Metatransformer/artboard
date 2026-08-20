/**
 * Parametric shape generators.
 *
 * Pure functions in, path `d` strings out — no schema, no scene, no DOM. The
 * editor calls these when inserting a polygon/star and stores the result as an
 * ordinary `PathNode.d`, so the document stays plain data and the renderer
 * stays ignorant of "shape kinds".
 *
 * Every shape is drawn in a **0..100 box** (`PathNode.viewBox = [100, 100]`)
 * centred on (50, 50), first vertex at 12 o'clock, wound clockwise on screen.
 * Coordinates are rounded to 3 dp so the same call always produces the same
 * string — these feed golden tests like everything else.
 */

const CENTER = 50;

/** 3-dp rounding with no `-0`, formatted without trailing zeros. */
const r3 = (v: number): number => {
  const n = Math.round(v * 1000) / 1000;
  return Object.is(n, -0) ? 0 : n;
};

const pt = (cx: number, cy: number, radius: number, angle: number): [number, number] =>
  [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];

/** Vertices of a regular n-gon, starting at the top and going clockwise. */
function corners(sides: number, radius: number): Array<[number, number]> {
  const n = Math.max(3, Math.floor(sides));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push(pt(CENTER, CENTER, radius, -Math.PI / 2 + (i * 2 * Math.PI) / n));
  return out;
}

const poly = (points: Array<[number, number]>): string =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r3(x)} ${r3(y)}`).join(' ') + ' Z';

/**
 * A regular polygon. `polygonPath(3, 50)` is the triangle, `6` the hexagon.
 * `sides` is clamped to at least 3; `r` is the circumradius in box units.
 */
export function polygonPath(sides: number, r: number = 50): string {
  return poly(corners(sides, r));
}

/**
 * A star with `points` spikes. `outerR` is the tip radius, `innerR` the radius
 * of the valleys between them (Canva's default look is innerR ≈ 0.4·outerR).
 */
export function starPath(points: number, outerR: number = 50, innerR: number = 20): string {
  const n = Math.max(3, Math.floor(points));
  const verts: Array<[number, number]> = [];
  for (let i = 0; i < n * 2; i++) {
    const radius = i % 2 === 0 ? outerR : innerR;
    verts.push(pt(CENTER, CENTER, radius, -Math.PI / 2 + (i * Math.PI) / n));
  }
  return poly(verts);
}

/**
 * A regular polygon with rounded corners: each vertex is cut back along both of
 * its edges by as much as `corner` allows, and the gap bridged with a circular
 * arc. `corner` is the corner radius in box units; it is clamped so adjacent
 * corners can never overrun each other (a large value gives a near-circle).
 */
export function roundedPolygonPath(sides: number, r: number = 50, corner: number = 8): string {
  const v = corners(sides, r);
  const n = v.length;
  if (corner <= 0) return poly(v);

  // Half the interior angle: how far back along an edge a corner of radius
  // `corner` must start. Capped at half the edge so two corners never meet.
  const half = Math.PI / 2 - Math.PI / n;               // = interiorAngle / 2
  const edge = 2 * r * Math.sin(Math.PI / n);
  const cut = Math.min(corner / Math.tan(half), edge / 2);
  const rad = cut * Math.tan(half);                     // the radius actually used

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = v[(i - 1 + n) % n]!, cur = v[i]!, next = v[(i + 1) % n]!;
    const toPrev = unit(cur, prev), toNext = unit(cur, next);
    const a: [number, number] = [cur[0] + toPrev[0] * cut, cur[1] + toPrev[1] * cut];
    const b: [number, number] = [cur[0] + toNext[0] * cut, cur[1] + toNext[1] * cut];
    parts.push(`${i === 0 ? 'M' : 'L'}${r3(a[0])} ${r3(a[1])}`);
    parts.push(`A${r3(rad)} ${r3(rad)} 0 0 1 ${r3(b[0])} ${r3(b[1])}`);
  }
  return parts.join(' ') + ' Z';
}

function unit(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}
