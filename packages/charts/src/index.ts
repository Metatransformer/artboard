import { buildNode, type Node } from '@artboard/schema';

/**
 * @artboard/charts — tabular data in, Artboard nodes out.
 *
 * `buildChart` is a pure function of its spec: the same spec always produces
 * the same flat array of nodes, with the same ids, in the same order. No
 * Math.random, no Date, no DOM, no measuring — the geometry here is arithmetic
 * on the numbers the caller passed in. That is what makes a chart diffable in a
 * golden test and re-creatable by a user who lost their file.
 *
 * The output is deliberately *dumb*: plain rects, ellipses, lines, paths and
 * text. Nothing in the document knows it used to be a chart, so every mark can
 * be nudged, recoloured or deleted in the editor like any other shape.
 */

/* ── public API ─────────────────────────────────────────────────────────── */

export type ChartKind = 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'stacked-bar';

export interface Series {
  name: string;
  values: number[];
  /** Overrides the palette slot for this series. */
  color?: string;
}

export interface ChartSpec {
  kind: ChartKind;
  labels: string[];
  series: Series[];
  width: number;
  height: number;
  x?: number;
  y?: number;
  title?: string;
  palette?: string[];
  /** Gridlines behind the marks. Default true for the cartesian kinds, ignored by pie/donut. */
  showGrid?: boolean;
  /** Print the number on each mark. Default false — it is noise on a dense chart. */
  showValues?: boolean;
  /** Default true when there is more than one thing to name (series, or slices on a pie). */
  showLegend?: boolean;
  fontFamily?: string;
}

/** Bad data is a message, never a crash and never a silently empty chart. */
export class ChartDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartDataError';
  }
}

/** The app's accent family. Eight slots, then it wraps. */
export const CHART_PALETTE: string[] = [
  '#4f46e5', // indigo — the app accent
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#22d3ee', // cyan
  '#8b5cf6', // violet
  '#ef4444', // red
  '#3b82f6', // blue
];

/* ── ink ────────────────────────────────────────────────────────────────── */

const INK_TITLE = '#111827';
const INK_LABEL = '#374151';
const INK_MUTED = '#6b7280';
const INK_GRID = '#e5e7eb';
const INK_ZERO = '#9ca3af';

/* ── small maths ────────────────────────────────────────────────────────── */

/** Every coordinate that reaches a node goes through this. Stable strings, stable diffs. */
const r2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);
/** Kills float noise like 0.30000000000000004 before it can reach a label. */
const clean = (n: number): number => Number(n.toPrecision(12));

/**
 * Cheap, deterministic text width. The engine owns real measurement; charts only
 * need enough to reserve a gutter, and must never differ between Node and the
 * browser.
 */
const estWidth = (text: string, size: number): number => text.length * size * 0.56;

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** The smallest 1/2/2.5/5 × 10ⁿ value that is at least `v`. */
function niceUp(v: number): number {
  if (!(v > 0)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / base;
  for (const n of NICE_STEPS) if (f <= n + 1e-9) return clean(n * base);
  return clean(10 * base);
}

interface Axis {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
}

/**
 * A value axis that always contains zero, always lands on a nice step, and
 * always has 4–6 gridlines. Because `lo` is a whole multiple of `step`, zero is
 * itself a tick — which is what puts the baseline in the right place when the
 * data goes negative.
 */
function buildAxis(dataLo: number, dataHi: number): Axis {
  const lo = Math.min(0, dataLo);
  let hi = Math.max(0, dataHi);
  if (lo === 0 && hi === 0) hi = 1;

  let step = niceUp((hi - lo) / 5);
  let aLo = 0;
  let aHi = 0;
  for (let guard = 0; guard < 16; guard++) {
    aLo = clean(Math.floor(lo / step) * step);
    aHi = clean(Math.ceil(hi / step) * step);
    if (aHi === aLo) aHi = clean(aLo + step);
    if (Math.round((aHi - aLo) / step) + 1 <= 6) break;
    step = niceUp(step * 1.5);
  }

  const ticks: number[] = [];
  const count = Math.round((aHi - aLo) / step);
  for (let i = 0; i <= count; i++) ticks.push(clean(aLo + i * step));
  return { lo: aLo, hi: aHi, step, ticks };
}

/** Locale-free number formatting — `Intl` would make the output machine-dependent. */
function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return trimNum(v / 1e9) + 'B';
  if (a >= 1e6) return trimNum(v / 1e6) + 'M';
  if (a >= 1e4) return trimNum(v / 1e3) + 'k';
  return trimNum(v);
}
const trimNum = (n: number): string => String(Math.round(clean(n) * 100) / 100);

/** `#abc` / `#aabbcc` / `#aabbccdd` → `#aabbcc` + the given alpha byte. */
function withAlpha(hex: string, alpha: string): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length >= 6) h = h.slice(0, 6);
  return `#${h}${alpha}`;
}

/* ── node builders (every field explicit — nothing relies on schema defaults) ─ */

interface Base {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Identity + geometry only. Every other field is filled in by `buildNode`,
 * which parses through the schema — so a new field on `NodeBase` can never
 * silently break chart output the way a hand-maintained default list does.
 */
const base = (id: string, name: string, x: number, y: number, width: number, height: number) => ({
  id,
  name,
  x: r2(x),
  y: r2(y),
  width: r2(Math.max(0, width)),
  height: r2(Math.max(0, height)),
});

const NO_STROKE = { color: '#000000', width: 0, dash: [] as number[] };

const rect = (b: Base, fill: string, radius = 0): Node => buildNode({
  ...base(b.id, b.name, b.x, b.y, b.width, b.height),
  kind: 'rect',
  fill: { kind: 'solid', color: fill },
  stroke: NO_STROKE,
  radius: r2(radius),
});

const ellipse = (b: Base, fill: string, strokeColor?: string, strokeWidth = 0): Node => buildNode({
  ...base(b.id, b.name, b.x, b.y, b.width, b.height),
  kind: 'ellipse',
  fill: { kind: 'solid', color: fill },
  stroke: strokeColor ? { color: strokeColor, width: r2(strokeWidth), dash: [] } : NO_STROKE,
});

/** The renderer draws a `line` horizontally through the middle of its box, so this is always a rule. */
const hline = (id: string, name: string, x: number, y: number, w: number, color: string, width: number, dash: number[] = []): Node => buildNode({
  ...base(id, name, x, y, w, 0),
  kind: 'line',
  stroke: { color, width: r2(width), dash },
});

interface TextOpts {
  size: number;
  color: string;
  font: string;
  weight?: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
}

const text = (b: Base, content: string, o: TextOpts): Node => buildNode({
  ...base(b.id, b.name, b.x, b.y, b.width, b.height),
  kind: 'text',
  text: content,
  fontFamily: o.font,
  fontSize: r2(o.size),
  fontWeight: o.weight ?? 500,
  italic: false,
  lineHeight: 1.2,
  letterSpacing: 0,
  align: o.align ?? 'left',
  valign: o.valign ?? 'top',
  color: o.color,
  uppercase: false,
});

/**
 * A path whose `d` is written in the node's own coordinate space. Setting the
 * viewBox to the node size makes the renderer's scale exactly 1, so stroke
 * widths and arc radii come out as authored.
 */
const path = (
  b: Base,
  d: string,
  o: { fill?: string; stroke?: string; strokeWidth?: number },
): Node => buildNode({
  ...base(b.id, b.name, b.x, b.y, b.width, b.height),
  kind: 'path',
  d,
  viewBox: [r2(Math.max(1, b.width)), r2(Math.max(1, b.height))] as [number, number],
  fill: o.fill ? { kind: 'solid', color: o.fill } : { kind: 'none' },
  stroke: o.stroke ? { color: o.stroke, width: r2(o.strokeWidth ?? 2), dash: [] } : NO_STROKE,
});

/* ── validation ─────────────────────────────────────────────────────────── */

const EXAMPLE = `{ kind: 'column', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', values: [12, 18, 9] }], width: 640, height: 400 }`;

function validate(spec: ChartSpec): void {
  if (!Array.isArray(spec.series) || spec.series.length === 0) {
    throw new ChartDataError(
      `Chart has no series, so there is nothing to draw. Pass at least one series with a name and one value per label — e.g. ${EXAMPLE}.`,
    );
  }
  if (!Array.isArray(spec.labels) || spec.labels.length === 0) {
    throw new ChartDataError(
      `Chart has no labels, so no data point has a category. Pass one label per value — e.g. labels: ['Q1', 'Q2', 'Q3'] alongside values: [12, 18, 9].`,
    );
  }
  for (const [si, s] of spec.series.entries()) {
    const who = s?.name ? `"${s.name}"` : `at index ${si}`;
    if (!s || !Array.isArray(s.values)) {
      throw new ChartDataError(
        `Series ${who} has no values array. Every series looks like { name: 'Revenue', values: [12, 18, 9] }, with one number per label.`,
      );
    }
    if (s.values.length !== spec.labels.length) {
      throw new ChartDataError(
        `Series ${who} has ${s.values.length} value${s.values.length === 1 ? '' : 's'} but there are ${spec.labels.length} labels. ` +
          `Every series needs exactly one value per label — e.g. labels: ['Q1', 'Q2', 'Q3'] with values: [12, 18, 9].`,
      );
    }
    for (const [vi, v] of s.values.entries()) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ChartDataError(
          `Series ${who} value at index ${vi} is ${String(v)}, which cannot be plotted. ` +
            `Every value must be a finite number — e.g. values: [12, 18, 9]. Replace missing readings with 0 before building the chart.`,
        );
      }
    }
  }
  if (!Number.isFinite(spec.width) || spec.width < MIN_SIZE || !Number.isFinite(spec.height) || spec.height < MIN_SIZE) {
    throw new ChartDataError(
      `Chart box is ${spec.width}×${spec.height}, which is too small to hold axes and labels. ` +
        `Both width and height must be at least ${MIN_SIZE} — e.g. width: 640, height: 400.`,
    );
  }
  if (spec.kind === 'pie' || spec.kind === 'donut') {
    const first = spec.series[0]!;
    for (const [vi, v] of first.values.entries()) {
      if (v < 0) {
        throw new ChartDataError(
          `A ${spec.kind} chart cannot show the negative value ${v} at index ${vi} of series "${first.name}" — a slice has no negative size. ` +
            `Use only values of 0 or more — e.g. values: [42, 31, 18, 9] — or switch to kind: 'column', which handles negatives.`,
        );
      }
    }
    const total = first.values.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      throw new ChartDataError(
        `A ${spec.kind} chart whose values add up to 0 has no slices to draw. Give at least one value above zero — e.g. values: [42, 31, 18, 9].`,
      );
    }
  }
}

const MIN_SIZE = 80;

/* ── layout ─────────────────────────────────────────────────────────────── */

const CARTESIAN: ReadonlySet<ChartKind> = new Set<ChartKind>(['bar', 'column', 'line', 'area', 'stacked-bar']);
/** Kinds whose value axis runs left→right; the category axis is the vertical one. */
const HORIZONTAL: ReadonlySet<ChartKind> = new Set<ChartKind>(['bar', 'stacked-bar']);

interface Type {
  title: number;
  label: number;
  value: number;
  legend: number;
  pad: number;
  scale: number;
  font: string;
}

/**
 * One scale factor drives every size in the chart, so a 400px chart and a
 * 1200px chart are the same design at two sizes rather than two designs.
 */
function typography(spec: ChartSpec): Type {
  const scale = clamp(Math.sqrt(spec.width * spec.height) / 420, 0.55, 2.6);
  return {
    scale,
    title: r2(21 * scale),
    label: r2(12 * scale),
    value: r2(11 * scale),
    legend: r2(12 * scale),
    pad: r2(14 * scale),
    font: spec.fontFamily ?? 'Inter',
  };
}

interface LegendItem { name: string; color: string }
interface PlacedLegendItem extends LegendItem { dx: number; row: number; labelW: number }
interface LegendPlan { placed: PlacedLegendItem[]; rows: number; rowH: number; height: number; swatch: number; gap: number }

/**
 * Wraps the legend to as many rows as it needs and records where every item
 * lands, so the height reserved here is exactly the height drawn later. Working
 * it out twice from the same rule is how legends end up overlapping the plot.
 */
function planLegend(items: LegendItem[], innerW: number, t: Type): LegendPlan {
  const swatch = t.legend * 0.85;
  const gap = t.legend * 0.45;
  const between = t.legend * 1.2;
  const rowH = t.legend * 1.8;
  if (items.length === 0) return { placed: [], rows: 0, rowH, height: 0, swatch, gap };

  const placed: PlacedLegendItem[] = [];
  let row = 0;
  let cursor = 0;
  for (const item of items) {
    const labelW = estWidth(item.name, t.legend);
    const w = swatch + gap + labelW + between;
    if (cursor > 0 && cursor + w > innerW) {
      row += 1;
      cursor = 0;
    }
    placed.push({ ...item, dx: cursor, row, labelW });
    cursor += w;
  }
  const rows = row + 1;
  return { placed, rows, rowH, height: r2(rows * rowH), swatch, gap };
}

/* ── the builder ────────────────────────────────────────────────────────── */

export function buildChart(spec: ChartSpec): Node[] {
  validate(spec);

  const kind = spec.kind;
  const originX = spec.x ?? 0;
  const originY = spec.y ?? 0;
  const { width, height, labels, series } = spec;
  const palette = spec.palette && spec.palette.length > 0 ? spec.palette : CHART_PALETTE;
  const t = typography(spec);
  const isPie = kind === 'pie' || kind === 'donut';
  const showGrid = spec.showGrid ?? true;
  const showValues = spec.showValues ?? false;

  const counters: Record<string, number> = {};
  /** `chart-<kind>-<role>-<index>` — the index is emission order, which is fixed. */
  const nid = (role: string): string => {
    const n = counters[role] ?? 0;
    counters[role] = n + 1;
    return `chart-${kind}-${role}-${n}`;
  };

  const nodes: Node[] = [];
  const colorOf = (i: number): string => series[i]?.color ?? palette[i % palette.length] ?? CHART_PALETTE[0]!;
  const sliceColor = (i: number): string => palette[i % palette.length] ?? CHART_PALETTE[0]!;

  /* title */
  const titleH = spec.title ? r2(t.title * 1.45) : 0;
  if (spec.title) {
    nodes.push(
      text(
        { id: nid('title'), name: 'Chart title', x: originX + t.pad, y: originY + t.pad, width: width - t.pad * 2, height: titleH },
        spec.title,
        { size: t.title, color: INK_TITLE, font: t.font, weight: 700, align: 'left', valign: 'top' },
      ),
    );
  }

  /* legend — planned before the plot, because it eats height */
  const legendItems: LegendItem[] = isPie
    ? labels.map((name, i) => ({ name, color: sliceColor(i) }))
    : series.map((s, i) => ({ name: s.name, color: colorOf(i) }));
  const legendOn = spec.showLegend ?? legendItems.length > 1;
  const legend = planLegend(legendOn ? legendItems : [], width - t.pad * 2, t);

  const topInset = t.pad + titleH + (spec.title ? t.pad * 0.35 : 0);

  /* ── pie & donut ───────────────────────────────────────────────────────── */
  if (isPie) {
    const bottomInset = t.pad + legend.height;
    const boxW = Math.max(1, width - t.pad * 2);
    const boxH = Math.max(1, height - topInset - bottomInset);
    const radius = Math.max(1, (Math.min(boxW, boxH) / 2) * 0.94);
    const cx = originX + t.pad + boxW / 2;
    const cy = originY + topInset + boxH / 2;
    const inner = kind === 'donut' ? radius * 0.58 : 0;

    // The path node's box is the circle's bounding box; `d` is written relative to it.
    const boxX = cx - radius;
    const boxY = cy - radius;
    const lcx = radius;
    const lcy = radius;

    const first = series[0]!;
    const total = first.values.reduce((a, b) => a + b, 0);
    const START = -Math.PI / 2;
    let angle = START;

    for (const [i, raw] of first.values.entries()) {
      const value = raw;
      const sweep = (value / total) * Math.PI * 2;
      if (sweep <= 0) continue; // a zero slice draws nothing; skipping keeps the SVG honest
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;

      const full = sweep >= Math.PI * 2 - 1e-9;
      const d = full
        ? kind === 'donut'
          ? fullRing(lcx, lcy, radius, inner)
          : fullDisc(lcx, lcy, radius)
        : kind === 'donut'
          ? annularSector(lcx, lcy, radius, inner, a0, a1)
          : pieSector(lcx, lcy, radius, a0, a1);

      nodes.push(
        path(
          { id: nid('slice'), name: labels[i] ?? `Slice ${i + 1}`, x: boxX, y: boxY, width: radius * 2, height: radius * 2 },
          d,
          { fill: sliceColor(i) },
        ),
      );

      if (showValues) {
        const mid = (a0 + a1) / 2;
        const rLabel = kind === 'donut' ? (radius + inner) / 2 : radius * 0.64;
        const lx = cx + Math.cos(mid) * rLabel;
        const ly = cy + Math.sin(mid) * rLabel;
        const w = Math.max(estWidth(fmt(value), t.value) * 1.6, t.value * 3);
        nodes.push(
          text(
            { id: nid('value'), name: `${labels[i] ?? ''} value`, x: lx - w / 2, y: ly - t.value, width: w, height: t.value * 2 },
            fmt(value),
            { size: t.value, color: '#ffffff', font: t.font, weight: 700, align: 'center', valign: 'middle' },
          ),
        );
      }
    }

    pushLegend(nodes, nid, legend, originX + t.pad, originY + height - t.pad - legend.height, t);
    return nodes;
  }

  /* ── cartesian kinds ───────────────────────────────────────────────────── */
  const horizontal = HORIZONTAL.has(kind);
  const stacked = kind === 'stacked-bar';

  /* value domain */
  let dataLo = 0;
  let dataHi = 0;
  if (stacked) {
    for (let ci = 0; ci < labels.length; ci++) {
      let pos = 0;
      let neg = 0;
      for (const s of series) {
        const v = s.values[ci] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      dataHi = Math.max(dataHi, pos);
      dataLo = Math.min(dataLo, neg);
    }
  } else {
    for (const s of series) {
      for (const v of s.values) {
        dataHi = Math.max(dataHi, v);
        dataLo = Math.min(dataLo, v);
      }
    }
  }
  const axis = buildAxis(dataLo, dataHi);
  const tickText = axis.ticks.map(fmt);

  /* insets */
  const valueGutter = Math.max(...tickText.map((s) => estWidth(s, t.label)));
  const catGutter = Math.min(
    Math.max(...labels.map((s) => estWidth(s, t.label))),
    width * 0.34,
  );
  const tickAreaH = t.label * 1.7;
  const leftInset = t.pad + (horizontal ? catGutter : valueGutter) + t.pad * 0.4;
  const rightInset = t.pad + (horizontal ? (estWidth(tickText[tickText.length - 1] ?? '', t.label) / 2) : 0);
  const bottomInset = t.pad + legend.height + tickAreaH;

  const plotX = originX + leftInset;
  const plotY = originY + topInset;
  const plotW = Math.max(1, width - leftInset - rightInset);
  const plotH = Math.max(1, height - topInset - bottomInset);

  const span = axis.hi - axis.lo;
  const vToX = (v: number): number => plotX + ((v - axis.lo) / span) * plotW;
  const vToY = (v: number): number => plotY + plotH - ((v - axis.lo) / span) * plotH;

  /* gridlines + tick labels */
  if (showGrid) {
    for (const [i, tick] of axis.ticks.entries()) {
      const isZero = tick === 0;
      const color = isZero ? INK_ZERO : INK_GRID;
      const w = isZero ? 1.5 * t.scale : 1 * t.scale;
      if (horizontal) {
        const tx = vToX(tick);
        // A `line` node can only be horizontal, so a vertical rule is a hairline rect.
        nodes.push(
          rect({ id: nid('grid'), name: `Gridline ${tickText[i]}`, x: tx - w / 2, y: plotY, width: w, height: plotH }, color),
        );
        nodes.push(
          text(
            { id: nid('gridlabel'), name: `Axis ${tickText[i]}`, x: tx - plotW / 2, y: plotY + plotH + t.pad * 0.3, width: plotW, height: tickAreaH },
            tickText[i] ?? '',
            { size: t.label, color: INK_MUTED, font: t.font, align: 'center', valign: 'top' },
          ),
        );
      } else {
        const ty = vToY(tick);
        nodes.push(hline(nid('grid'), `Gridline ${tickText[i]}`, plotX, ty, plotW, color, w));
        nodes.push(
          text(
            { id: nid('gridlabel'), name: `Axis ${tickText[i]}`, x: originX + t.pad, y: ty - t.label, width: valueGutter, height: t.label * 2 },
            tickText[i] ?? '',
            { size: t.label, color: INK_MUTED, font: t.font, align: 'right', valign: 'middle' },
          ),
        );
      }
    }
  }

  /* category labels */
  const slots = labels.length;
  const slotSize = (horizontal ? plotH : plotW) / slots;
  const slotCenter = (ci: number): number => (horizontal ? plotY : plotX) + slotSize * (ci + 0.5);

  for (const [ci, label] of labels.entries()) {
    const c = slotCenter(ci);
    if (horizontal) {
      nodes.push(
        text(
          { id: nid('cat'), name: `Category ${label}`, x: originX + t.pad, y: c - t.label, width: catGutter, height: t.label * 2 },
          label,
          { size: t.label, color: INK_LABEL, font: t.font, align: 'right', valign: 'middle' },
        ),
      );
    } else {
      nodes.push(
        text(
          { id: nid('cat'), name: `Category ${label}`, x: c - slotSize / 2, y: plotY + plotH + t.pad * 0.3, width: slotSize, height: tickAreaH },
          label,
          { size: t.label, color: INK_LABEL, font: t.font, align: 'center', valign: 'top' },
        ),
      );
    }
  }

  /* marks */
  if (kind === 'line' || kind === 'area') {
    buildSeriesLines();
  } else if (stacked) {
    buildStackedBars();
  } else {
    buildGroupedBars();
  }

  pushLegend(nodes, nid, legend, originX + t.pad, originY + height - t.pad - legend.height, t);
  return nodes;

  /* ── mark builders (closures over the layout above) ───────────────────── */

  function buildGroupedBars(): void {
    const groupExtent = slotSize * 0.74;
    const thickness = groupExtent / series.length;
    const gap = Math.min(thickness * 0.18, 3 * t.scale);
    const drawn = Math.max(1, thickness - gap);
    const zero = horizontal ? vToX(0) : vToY(0);

    for (const [ci, label] of labels.entries()) {
      const start = slotCenter(ci) - groupExtent / 2;
      for (const [si, s] of series.entries()) {
        const v = s.values[ci] ?? 0;
        const off = start + si * thickness + gap / 2;
        const at = horizontal ? vToX(v) : vToY(v);
        const lo = Math.min(zero, at);
        const size = Math.abs(at - zero);
        const radius = Math.min(3 * t.scale, drawn / 2, Math.max(0, size / 2));
        const name = `${s.name} — ${label}`;

        nodes.push(
          horizontal
            ? rect({ id: nid('bar'), name, x: lo, y: off, width: size, height: drawn }, colorOf(si), radius)
            : rect({ id: nid('bar'), name, x: off, y: lo, width: drawn, height: size }, colorOf(si), radius),
        );

        if (showValues) {
          const label2 = fmt(v);
          const pad = t.value * 0.45;
          if (horizontal) {
            const w = Math.max(estWidth(label2, t.value) * 1.4, t.value * 2.5);
            const tx = v >= 0 ? at + pad : at - pad - w;
            nodes.push(
              text(
                { id: nid('value'), name: `${name} value`, x: tx, y: off + drawn / 2 - t.value, width: w, height: t.value * 2 },
                label2,
                { size: t.value, color: INK_MUTED, font: t.font, weight: 600, align: v >= 0 ? 'left' : 'right', valign: 'middle' },
              ),
            );
          } else {
            const ty = v >= 0 ? at - pad - t.value * 1.3 : at + pad;
            nodes.push(
              text(
                { id: nid('value'), name: `${name} value`, x: off - thickness / 2, y: ty, width: drawn + thickness, height: t.value * 1.4 },
                label2,
                { size: t.value, color: INK_MUTED, font: t.font, weight: 600, align: 'center', valign: 'middle' },
              ),
            );
          }
        }
      }
    }
  }

  function buildStackedBars(): void {
    const thickness = slotSize * 0.66;
    for (const [ci, label] of labels.entries()) {
      const off = slotCenter(ci) - thickness / 2;
      let pos = 0;
      let neg = 0;
      for (const [si, s] of series.entries()) {
        const v = s.values[ci] ?? 0;
        if (v === 0) continue;
        const from = v >= 0 ? pos : neg;
        const to = from + v;
        if (v >= 0) pos = to;
        else neg = to;

        const a = vToX(from);
        const b = vToX(to);
        const name = `${s.name} — ${label}`;
        nodes.push(
          rect({ id: nid('bar'), name, x: Math.min(a, b), y: off, width: Math.abs(b - a), height: thickness }, colorOf(si)),
        );

        if (showValues && Math.abs(b - a) > estWidth(fmt(v), t.value) * 1.2) {
          nodes.push(
            text(
              { id: nid('value'), name: `${name} value`, x: Math.min(a, b), y: off + thickness / 2 - t.value, width: Math.abs(b - a), height: t.value * 2 },
              fmt(v),
              { size: t.value, color: '#ffffff', font: t.font, weight: 700, align: 'center', valign: 'middle' },
            ),
          );
        }
      }
    }
  }

  function buildSeriesLines(): void {
    const zeroY = vToY(0);
    for (const [si, s] of series.entries()) {
      const color = colorOf(si);
      const pts = labels.map((_, ci) => ({ x: slotCenter(ci), y: vToY(s.values[ci] ?? 0) }));
      const lx = (p: { x: number }) => r2(p.x - plotX);
      const ly = (p: { y: number }) => r2(p.y - plotY);

      if (kind === 'area' && pts.length >= 2) {
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        const d =
          `M ${lx(first)} ${r2(zeroY - plotY)} ` +
          pts.map((p) => `L ${lx(p)} ${ly(p)}`).join(' ') +
          ` L ${lx(last)} ${r2(zeroY - plotY)} Z`;
        nodes.push(
          path({ id: nid('area'), name: `${s.name} area`, x: plotX, y: plotY, width: plotW, height: plotH }, d, {
            fill: withAlpha(color, '38'),
          }),
        );
      }

      if (pts.length >= 2) {
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${lx(p)} ${ly(p)}`).join(' ');
        nodes.push(
          path({ id: nid('line'), name: `${s.name} line`, x: plotX, y: plotY, width: plotW, height: plotH }, d, {
            stroke: color,
            strokeWidth: r2(2.5 * t.scale),
          }),
        );
      }

      const dot = Math.max(2, 3.6 * t.scale);
      for (const [ci, p] of pts.entries()) {
        nodes.push(
          ellipse(
            { id: nid('point'), name: `${s.name} — ${labels[ci] ?? ''}`, x: p.x - dot, y: p.y - dot, width: dot * 2, height: dot * 2 },
            '#ffffff',
            color,
            r2(2 * t.scale),
          ),
        );
        if (showValues) {
          const v = s.values[ci] ?? 0;
          const w = slotSize;
          nodes.push(
            text(
              { id: nid('value'), name: `${s.name} — ${labels[ci] ?? ''} value`, x: p.x - w / 2, y: p.y - dot - t.value * 1.7, width: w, height: t.value * 1.4 },
              fmt(v),
              { size: t.value, color: INK_MUTED, font: t.font, weight: 600, align: 'center', valign: 'middle' },
            ),
          );
        }
      }
    }
  }
}

/* ── legend ─────────────────────────────────────────────────────────────── */

function pushLegend(
  nodes: Node[],
  nid: (role: string) => string,
  plan: LegendPlan,
  x: number,
  y: number,
  t: Type,
): void {
  const { swatch, gap } = plan;
  for (const item of plan.placed) {
    const itemX = x + item.dx;
    const itemY = y + item.row * plan.rowH;
    nodes.push(
      rect(
        { id: nid('legendswatch'), name: `${item.name} swatch`, x: itemX, y: itemY + (plan.rowH - swatch) / 2, width: swatch, height: swatch },
        item.color,
        swatch * 0.28,
      ),
    );
    nodes.push(
      text(
        { id: nid('legendlabel'), name: `${item.name} legend`, x: itemX + swatch + gap, y: itemY, width: item.labelW + t.legend, height: plan.rowH },
        item.name,
        { size: t.legend, color: INK_LABEL, font: t.font, align: 'left', valign: 'middle' },
      ),
    );
  }
}

/* ── arc geometry ───────────────────────────────────────────────────────── */

const px = (cx: number, r: number, a: number): number => r2(cx + r * Math.cos(a));
const py = (cy: number, r: number, a: number): number => r2(cy + r * Math.sin(a));

function pieSector(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${r2(cx)} ${r2(cy)} L ${px(cx, r, a0)} ${py(cy, r, a0)} A ${r2(r)} ${r2(r)} 0 ${large} 1 ${px(cx, r, a1)} ${py(cy, r, a1)} Z`;
}

/**
 * A 100% slice is 360°, and an arc from a point back to itself is degenerate —
 * SVG renders it as nothing. Two half-arcs draw the real circle.
 */
function fullDisc(cx: number, cy: number, r: number): string {
  return `M ${r2(cx)} ${r2(cy - r)} A ${r2(r)} ${r2(r)} 0 1 1 ${r2(cx)} ${r2(cy + r)} A ${r2(r)} ${r2(r)} 0 1 1 ${r2(cx)} ${r2(cy - r)} Z`;
}

function annularSector(cx: number, cy: number, r: number, ri: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return (
    `M ${px(cx, r, a0)} ${py(cy, r, a0)} ` +
    `A ${r2(r)} ${r2(r)} 0 ${large} 1 ${px(cx, r, a1)} ${py(cy, r, a1)} ` +
    `L ${px(cx, ri, a1)} ${py(cy, ri, a1)} ` +
    `A ${r2(ri)} ${r2(ri)} 0 ${large} 0 ${px(cx, ri, a0)} ${py(cy, ri, a0)} Z`
  );
}

/**
 * A whole ring: outer circle clockwise, inner circle counter-clockwise. Under
 * the default nonzero fill rule the two windings cancel, so the hole is a real
 * hole — whatever is behind the chart shows through it.
 */
function fullRing(cx: number, cy: number, r: number, ri: number): string {
  return (
    `M ${r2(cx)} ${r2(cy - r)} A ${r2(r)} ${r2(r)} 0 1 1 ${r2(cx)} ${r2(cy + r)} A ${r2(r)} ${r2(r)} 0 1 1 ${r2(cx)} ${r2(cy - r)} Z ` +
    `M ${r2(cx)} ${r2(cy - ri)} A ${r2(ri)} ${r2(ri)} 0 1 0 ${r2(cx)} ${r2(cy + ri)} A ${r2(ri)} ${r2(ri)} 0 1 0 ${r2(cx)} ${r2(cy - ri)} Z`
  );
}

/* ── sample data ────────────────────────────────────────────────────────── */

/**
 * Real-shaped numbers, not lorem. These are meant to be handed straight to a
 * template picker: every one of them renders as a chart somebody could ship.
 */
export const SAMPLE_DATA: Record<ChartKind, ChartSpec> = {
  bar: {
    kind: 'bar',
    title: 'Sessions by traffic source',
    labels: ['Organic search', 'Direct', 'Referral', 'Social', 'Email', 'Paid ads'],
    series: [{ name: 'Sessions', values: [48200, 31400, 18700, 12900, 8600, 5300] }],
    width: 800,
    height: 500,
    showValues: true,
  },
  column: {
    kind: 'column',
    title: 'Quarterly revenue',
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: '2024', values: [412000, 468000, 501000, 590000] },
      { name: '2025', values: [503000, 561000, 624000, 712000] },
    ],
    width: 800,
    height: 500,
  },
  line: {
    kind: 'line',
    title: 'Monthly active users',
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    series: [
      { name: 'Mobile', values: [21400, 23100, 25600, 27900, 31200, 34800] },
      { name: 'Desktop', values: [18900, 19200, 18700, 19800, 20400, 21100] },
    ],
    width: 800,
    height: 500,
  },
  area: {
    kind: 'area',
    title: 'Net cash flow',
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
    series: [{ name: 'Net cash flow', values: [-42000, -18000, 9000, 24000, 17000, -6000, 38000, 61000] }],
    width: 800,
    height: 500,
  },
  pie: {
    kind: 'pie',
    title: 'Traffic sources',
    labels: ['Organic search', 'Direct', 'Referral', 'Social', 'Email'],
    series: [{ name: 'Share of sessions', values: [42, 24, 15, 12, 7] }],
    width: 640,
    height: 560,
    showValues: true,
  },
  donut: {
    kind: 'donut',
    title: 'Storage used by file type',
    labels: ['Images', 'Video', 'Documents', 'Fonts', 'Other'],
    series: [{ name: 'Gigabytes', values: [128, 96, 34, 12, 9] }],
    width: 640,
    height: 560,
    showValues: true,
  },
  'stacked-bar': {
    kind: 'stacked-bar',
    title: 'Revenue by region and product line',
    labels: ['North America', 'Europe', 'Asia Pacific', 'Latin America'],
    series: [
      { name: 'Subscriptions', values: [1840000, 1210000, 760000, 290000] },
      { name: 'Services', values: [620000, 480000, 310000, 140000] },
      { name: 'Marketplace', values: [310000, 190000, 220000, 80000] },
    ],
    width: 900,
    height: 520,
  },
};
