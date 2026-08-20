/**
 * @artboard/icons — the bundled element library.
 *
 * Everything here is DATA and pure functions over it: no network, no
 * filesystem, no `Date`, no `Math.random`, no runtime dependencies. The whole
 * library ships inside the app, so the Elements drawer works on a plane and a
 * `.artboard.json` made today still opens in five years — nothing in a saved
 * document points at a CDN.
 *
 * Two catalogues live here, and they render differently:
 *
 *   • `ICONS`  — 375 Lucide outline icons. The artwork IS the stroke, so they
 *     are inserted with `fill: none` and a stroke. Filling one instead paints
 *     the union of its outlines: a black blob.
 *   • `SHAPES` — ~40 geometric shapes. Solid silhouettes, inserted with a fill
 *     and no stroke. Outlining one loses it.
 *
 * `iconNodeStyle()` / `shapeNodeStyle()` below are the single place that
 * decision is encoded, so no caller has to remember it.
 *
 * Licensing: Lucide is ISC, which requires only that the copyright notice
 * travels with the copy. It does, in `LICENSE-ICONS` next to this file, and
 * the provenance is recorded in `docs/ICONS.md`. There is nothing an Artboard
 * user has to attribute when they export a design.
 */
import { ICONS } from './data';

export { ICONS };
export { SHAPES, polygonPath, starPath, circlePath } from './shapes';
export type { Shape } from './shapes';

/** Icon path data is authored in a 24×24 box; shapes in a 100×100 one. */
export const ICON_VIEWBOX: readonly [number, number] = [24, 24];
export const SHAPE_VIEWBOX: readonly [number, number] = [100, 100];

/**
 * Stroke width in *viewBox* units, which is what makes an icon scale honestly:
 * the renderer scales a path node by `width / viewBox`, so the stroke grows
 * with the icon instead of thinning out at poster size.
 */
export const ICON_STROKE_WIDTH = 2;

export type IconCategory =
  | 'arrows' | 'ui' | 'media' | 'communication' | 'files'
  | 'commerce' | 'social' | 'weather' | 'nature' | 'symbols';

export interface Icon {
  /** Stable id. Also the key the drawer uses, so it must not be reused. */
  id: string;
  /** Human label, shown as the button tooltip. */
  name: string;
  category: IconCategory;
  /** Lower-case search terms, including the words of the name. */
  tags: readonly string[];
  /** Path data in the 24×24 box. Several subpaths concatenated. */
  d: string;
  /** Always `true` for this set — outline artwork. See the note above. */
  stroke: boolean;
}

export const ICON_CATEGORIES: readonly { id: IconCategory; label: string }[] = [
  { id: 'arrows', label: 'Arrows' },
  { id: 'ui', label: 'Interface' },
  { id: 'media', label: 'Media' },
  { id: 'communication', label: 'Comms' },
  { id: 'files', label: 'Files' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'social', label: 'Social' },
  { id: 'weather', label: 'Weather' },
  { id: 'nature', label: 'Nature' },
  { id: 'symbols', label: 'Symbols' },
];

/**
 * Filter the library. An empty query and a null category return everything, so
 * the caller never needs a special case for "nothing typed yet".
 *
 * Matching is substring, not prefix: someone hunting for a bin will type
 * "trash" and the icon is called `trash-2`, while someone typing "cart" should
 * still find `shopping-cart`. Results keep catalogue order — that order is
 * editorial (the useful arrows are first), and re-sorting by relevance would
 * throw it away for no gain at this size.
 */
export function searchIcons(query: string, category: IconCategory | null = null): readonly Icon[] {
  const q = query.trim().toLowerCase();
  if (!q && !category) return ICONS;
  return ICONS.filter(i =>
    (!category || i.category === category) &&
    (!q || i.id.includes(q) || i.name.toLowerCase().includes(q) || i.tags.some(t => t.includes(q))));
}

/** How many icons sit in each category. Handy for a "Files (38)" chip. */
export function countByCategory(): Record<IconCategory, number> {
  const out = {} as Record<IconCategory, number>;
  for (const { id } of ICON_CATEGORIES) out[id] = 0;
  for (const i of ICONS) out[i.category]++;
  return out;
}

/**
 * The paint half of a `path` node for an icon: outline, no fill.
 *
 * Returned as a plain object to spread into `buildNode`, rather than building
 * the node here — `@artboard/schema` owns what a node is, and a package that
 * hand-rolls node literals goes stale the moment the schema grows a field.
 */
export function iconNodeStyle(color = '#111111'): Record<string, unknown> {
  return {
    viewBox: [...ICON_VIEWBOX],
    fill: { kind: 'none' },
    stroke: { color, width: ICON_STROKE_WIDTH, dash: [] },
  };
}

/** The paint half of a `path` node for a geometric shape: solid, no outline. */
export function shapeNodeStyle(color = '#4f46e5'): Record<string, unknown> {
  return {
    viewBox: [...SHAPE_VIEWBOX],
    fill: { kind: 'solid', color },
    stroke: { color: '#000000', width: 0, dash: [] },
  };
}
