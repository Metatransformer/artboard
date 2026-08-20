/**
 * @artboard/templates — the starting points.
 *
 * A template is a pure function of nothing: `build()` must return the same
 * document every time it is called. No Math.random, no Date.now, no counters.
 * That determinism is what makes golden tests possible, and it is what lets a
 * user re-create a design they lost.
 *
 * Every node id is prefixed with its template id, so ids stay unique when a
 * template is dropped into a document that already has content.
 */

/* ── local structural types ─────────────────────────────────────────────── */
/** Mirrors @artboard/schema's Fill. Kept structural so this package stays dependency-free. */
export type TemplateFill =
  | { kind: 'solid'; color: string }
  | { kind: 'none' }
  | { kind: 'gradient'; angle: number; stops: Array<{ offset: number; color: string }> };

export interface TemplateStroke { color: string; width: number; dash: number[] }

export interface TemplateMeta {
  id: string;
  name: string;
  category: string;
  width: number;
  height: number;
}

export interface Template extends TemplateMeta {
  build(): { width: number; height: number; background: any; nodes: any[] };
}

/* ── fills ──────────────────────────────────────────────────────────────── */
const solid = (color: string): TemplateFill => ({ kind: 'solid', color });
const none: TemplateFill = { kind: 'none' };
const grad = (angle: number, ...stops: Array<[number, string]>): TemplateFill => ({
  kind: 'gradient', angle, stops: stops.map(([offset, color]) => ({ offset, color })),
});
const NO_STROKE: TemplateStroke = { color: '#000000', width: 0, dash: [] };
const stroke = (color: string, width: number, dash: number[] = []): TemplateStroke => ({ color, width, dash });

/* ── node builders (every field explicit — no reliance on schema defaults) ── */
type AnyNode = Record<string, any>;

const base = (id: string, x: number, y: number, width: number, height: number) => ({
  id, name: '', x, y, width, height,
  rotation: 0, opacity: 1, visible: true, locked: false, shadow: null as null,
});

interface TextOpts {
  text: string;
  font?: 'Inter' | 'Playfair Display' | 'DM Serif Display' | 'Space Grotesk' | 'JetBrains Mono';
  size?: number; weight?: number; lh?: number; ls?: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  color?: string; upper?: boolean; italic?: boolean;
  rotation?: number; opacity?: number;
}

/** text */
const T = (id: string, x: number, y: number, w: number, h: number, o: TextOpts): AnyNode => ({
  ...base(id, x, y, w, h),
  kind: 'text',
  text: o.text,
  fontFamily: o.font ?? 'Inter',
  fontSize: o.size ?? 48,
  fontWeight: o.weight ?? 600,
  italic: o.italic ?? false,
  lineHeight: o.lh ?? 1.2,
  letterSpacing: o.ls ?? 0,
  align: o.align ?? 'left',
  valign: o.valign ?? 'top',
  color: o.color ?? '#111111',
  uppercase: o.upper ?? false,
  rotation: o.rotation ?? 0,
  opacity: o.opacity ?? 1,
});

interface ShapeOpts { fill?: TemplateFill; stroke?: TemplateStroke; radius?: number; rotation?: number; opacity?: number }

/** rect */
const R = (id: string, x: number, y: number, w: number, h: number, o: ShapeOpts = {}): AnyNode => ({
  ...base(id, x, y, w, h),
  kind: 'rect',
  fill: o.fill ?? solid('#111111'),
  stroke: o.stroke ?? NO_STROKE,
  radius: o.radius ?? 0,
  rotation: o.rotation ?? 0,
  opacity: o.opacity ?? 1,
});

/** ellipse */
const E = (id: string, x: number, y: number, w: number, h: number, o: ShapeOpts = {}): AnyNode => ({
  ...base(id, x, y, w, h),
  kind: 'ellipse',
  fill: o.fill ?? solid('#111111'),
  stroke: o.stroke ?? NO_STROKE,
  rotation: o.rotation ?? 0,
  opacity: o.opacity ?? 1,
});

/** line — drawn horizontally through the vertical centre of its box */
const L = (id: string, x: number, y: number, w: number, o: { color: string; width: number; dash?: number[]; opacity?: number }): AnyNode => ({
  ...base(id, x, y, w, 0),
  kind: 'line',
  stroke: stroke(o.color, o.width, o.dash ?? []),
  opacity: o.opacity ?? 1,
});

/** path — `d` is drawn in viewBox units and scaled to the node box */
const P = (
  id: string, x: number, y: number, w: number, h: number,
  o: { d: string; viewBox: [number, number]; fill?: TemplateFill; stroke?: TemplateStroke; rotation?: number; opacity?: number },
): AnyNode => ({
  ...base(id, x, y, w, h),
  kind: 'path',
  d: o.d,
  viewBox: o.viewBox,
  fill: o.fill ?? solid('#111111'),
  stroke: o.stroke ?? NO_STROKE,
  rotation: o.rotation ?? 0,
  opacity: o.opacity ?? 1,
});

/** An organic blob, in a 100×100 viewBox. Used as a composition mass, never as decoration for its own sake. */
const BLOB = 'M50 3 C72 3 97 22 97 48 C97 74 76 97 50 97 C24 97 3 76 3 50 C3 24 28 3 50 3 Z';
const BLOB_SOFT = 'M54 2 C80 6 99 26 96 52 C93 78 72 98 46 97 C20 96 2 76 3 50 C4 24 28 -2 54 2 Z';

/* ── preset canvas sizes ────────────────────────────────────────────────── */
export const PRESET_SIZES: Array<{ name: string; width: number; height: number; category: string }> = [
  { name: 'Instagram Post',    width: 1080, height: 1080, category: 'Social' },
  { name: 'Instagram Story',   width: 1080, height: 1920, category: 'Social' },
  { name: 'Facebook Post',     width: 1200, height:  630, category: 'Social' },
  { name: 'Twitter/X Post',    width: 1600, height:  900, category: 'Social' },
  { name: 'LinkedIn Banner',   width: 1584, height:  396, category: 'Social' },
  { name: 'YouTube Thumbnail', width: 1280, height:  720, category: 'Video' },
  { name: 'Presentation',      width: 1920, height: 1080, category: 'Presentation' },
  { name: 'A4 Poster',         width: 2480, height: 3508, category: 'Print' },
  { name: 'Business Card',     width: 1050, height:  600, category: 'Print' },
  { name: 'Flyer',             width: 1275, height: 1650, category: 'Print' },
  { name: 'Logo',              width:  800, height:  800, category: 'Brand' },
  { name: 'Desktop Wallpaper', width: 1920, height: 1080, category: 'Screen' },
];

/* ════════════════════════════════════════════════════════════════════════ */
/* SOCIAL — 1080 × 1080                                                     */
/* ════════════════════════════════════════════════════════════════════════ */

const socialGradientLaunch: Template = {
  id: 'social-gradient-launch', name: 'Launch Week', category: 'Social', width: 1080, height: 1080,
  build: () => ({
    width: 1080, height: 1080,
    background: grad(135, [0, '#4338ca'], [0.55, '#7c3aed'], [1, '#db2777']),
    nodes: [
      P('social-gradient-launch-blob', 600, -180, 700, 700, { d: BLOB_SOFT, viewBox: [100, 100], fill: solid('#ffffff'), opacity: 0.1 }),
      E('social-gradient-launch-orb', -220, 640, 560, 560, { fill: solid('#fbbf24'), opacity: 0.18 }),
      T('social-gradient-launch-label', 96, 248, 888, 40, { text: 'Launch Week · 2026', font: 'Space Grotesk', size: 26, weight: 600, ls: 4, upper: true, color: '#fde68a' }),
      R('social-gradient-launch-bar', 96, 306, 88, 8, { fill: solid('#fbbf24'), radius: 4 }),
      T('social-gradient-launch-headline', 96, 356, 888, 400, { text: 'Ship your\nnext idea\nin a weekend.', font: 'Space Grotesk', size: 118, weight: 700, lh: 1.05, ls: -3, color: '#ffffff' }),
      T('social-gradient-launch-sub', 96, 792, 760, 120, { text: 'A design tool that gets out of the way. Free, open source, yours.', size: 34, weight: 400, lh: 1.45, color: '#e9d5ff' }),
      R('social-gradient-launch-cta', 96, 940, 320, 76, { fill: solid('#ffffff'), radius: 38 }),
      T('social-gradient-launch-cta-label', 96, 940, 320, 76, { text: 'Get started free', size: 26, weight: 600, align: 'center', valign: 'middle', color: '#4338ca' }),
    ],
  }),
};

const socialEditorialQuote: Template = {
  id: 'social-editorial-quote', name: 'Editorial Quote', category: 'Social', width: 1080, height: 1080,
  build: () => ({
    width: 1080, height: 1080,
    background: solid('#faf5ef'),
    nodes: [
      L('social-editorial-quote-rule-top', 120, 120, 840, { color: '#d6cbbb', width: 2 }),
      T('social-editorial-quote-kicker', 120, 152, 840, 40, { text: 'Field Notes', size: 22, weight: 600, ls: 6, upper: true, color: '#c2410c' }),
      E('social-editorial-quote-ring', 812, 726, 148, 148, { fill: none, stroke: stroke('#d6cbbb', 2) }),
      T('social-editorial-quote-body', 120, 300, 840, 340, { text: '“Good design is\nas little design\nas possible.”', font: 'Playfair Display', size: 88, weight: 400, lh: 1.2, ls: -1, color: '#1c1917' }),
      R('social-editorial-quote-accent', 120, 700, 72, 6, { fill: solid('#c2410c') }),
      T('social-editorial-quote-name', 120, 744, 600, 44, { text: 'Dieter Rams', size: 30, weight: 600, color: '#1c1917' }),
      T('social-editorial-quote-role', 120, 792, 600, 40, { text: 'Industrial designer, 1976', size: 24, weight: 400, color: '#78716c' }),
      T('social-editorial-quote-mark', 812, 726, 148, 148, { text: '10', font: 'Playfair Display', size: 46, weight: 400, align: 'center', valign: 'middle', color: '#c2410c' }),
      L('social-editorial-quote-rule-bottom', 120, 944, 840, { color: '#d6cbbb', width: 2 }),
      T('social-editorial-quote-footer', 120, 968, 840, 40, { text: 'The Artboard Review', size: 22, weight: 500, ls: 4, upper: true, color: '#a8a29e' }),
    ],
  }),
};

const socialMonoStat: Template = {
  id: 'social-mono-stat', name: 'Big Number', category: 'Social', width: 1080, height: 1080,
  build: () => ({
    width: 1080, height: 1080,
    background: solid('#0a0a0a'),
    nodes: [
      R('social-mono-stat-topbar', 0, 0, 1080, 14, { fill: solid('#d9f99d') }),
      T('social-mono-stat-label', 88, 140, 904, 40, { text: 'Annual Report / 03', font: 'JetBrains Mono', size: 24, weight: 500, ls: 4, upper: true, color: '#a3a3a3' }),
      T('social-mono-stat-number', 88, 300, 904, 340, { text: '97%', font: 'Space Grotesk', size: 300, weight: 700, lh: 1, ls: -12, color: '#fafafa' }),
      L('social-mono-stat-rule', 88, 680, 904, { color: '#262626', width: 1 }),
      T('social-mono-stat-body', 88, 724, 620, 170, { text: 'of teams shipped faster after moving to a single source of truth.', size: 38, weight: 400, lh: 1.4, color: '#d4d4d4' }),
      T('social-mono-stat-source', 712, 724, 280, 120, { text: 'Source:\nArtboard Index', font: 'JetBrains Mono', size: 20, weight: 400, lh: 1.6, align: 'right', color: '#737373' }),
      R('social-mono-stat-accent', 88, 940, 140, 8, { fill: solid('#d9f99d') }),
      T('social-mono-stat-footer', 88, 976, 904, 40, { text: 'artboard.design', font: 'JetBrains Mono', size: 22, weight: 500, ls: 2, color: '#a3a3a3' }),
    ],
  }),
};

const socialPastelTips: Template = {
  id: 'social-pastel-tips', name: 'Three Tips', category: 'Social', width: 1080, height: 1080,
  build: () => {
    const cards: Array<{ n: string; title: string; body: string }> = [
      { n: '1', title: 'Give it room', body: 'Whitespace is a decision, not leftover space.' },
      { n: '2', title: 'Two sizes, not five', body: 'Pick a type ratio and hold it everywhere.' },
      { n: '3', title: 'Colour comes last', body: 'If it works in grey, it will work in colour.' },
    ];
    return {
      width: 1080, height: 1080,
      background: solid('#eef2ea'),
      nodes: [
        E('social-pastel-tips-orb', 760, -140, 460, 460, { fill: solid('#d8a7a0'), opacity: 0.35 }),
        T('social-pastel-tips-label', 88, 110, 904, 36, { text: 'Three small habits', size: 22, weight: 600, ls: 5, upper: true, color: '#7d8b7f' }),
        T('social-pastel-tips-headline', 88, 160, 740, 190, { text: 'Design calmer\ninterfaces', font: 'Playfair Display', size: 76, weight: 400, lh: 1.12, color: '#2f3e35' }),
        ...cards.flatMap((c, i) => {
          const y = 380 + i * 176;
          const id = `social-pastel-tips-card-${i + 1}`;
          return [
            R(id, 88, y, 904, 150, { fill: solid('#ffffff'), radius: 24 }),
            E(`${id}-badge`, 128, y + 40, 68, 68, { fill: solid('#d8a7a0') }),
            T(`${id}-number`, 128, y + 40, 68, 68, { text: c.n, size: 30, weight: 700, align: 'center', valign: 'middle', color: '#ffffff' }),
            T(`${id}-title`, 224, y + 38, 680, 44, { text: c.title, size: 34, weight: 600, color: '#2f3e35' }),
            T(`${id}-body`, 224, y + 86, 700, 44, { text: c.body, size: 24, weight: 400, color: '#64766a' }),
          ];
        }),
        L('social-pastel-tips-rule', 88, 944, 904, { color: '#cfd8cd', width: 2 }),
        T('social-pastel-tips-footer', 88, 972, 904, 40, { text: '@artboard', size: 24, weight: 500, ls: 2, color: '#7d8b7f' }),
      ],
    };
  },
};

const socialDarkPodcast: Template = {
  id: 'social-dark-podcast', name: 'Podcast Episode', category: 'Social', width: 1080, height: 1080,
  build: () => {
    const heights = [28, 56, 96, 140, 72, 118, 44, 88, 32];
    return {
      width: 1080, height: 1080,
      background: grad(160, [0, '#0f172a'], [1, '#1e293b']),
      nodes: [
        E('social-dark-podcast-glow', -180, -180, 760, 760, { fill: solid('#38bdf8'), opacity: 0.12 }),
        R('social-dark-podcast-tick', 88, 132, 10, 64, { fill: solid('#38bdf8'), radius: 5 }),
        T('social-dark-podcast-show', 124, 136, 700, 32, { text: 'The Build Log', font: 'Space Grotesk', size: 26, weight: 600, ls: 4, upper: true, color: '#38bdf8' }),
        T('social-dark-podcast-episode', 124, 176, 700, 32, { text: 'Episode 42', size: 22, weight: 400, ls: 1, color: '#94a3b8' }),
        T('social-dark-podcast-title', 88, 352, 904, 360, { text: 'Why your tool\nshould be\nboring.', font: 'Space Grotesk', size: 110, weight: 700, lh: 1.06, ls: -2, color: '#f1f5f9' }),
        L('social-dark-podcast-rule', 88, 760, 904, { color: '#334155', width: 1 }),
        ...heights.map((h, i) => R(`social-dark-podcast-bar-${i}`, 88 + i * 30, 940 - h, 14, h, { fill: solid('#38bdf8'), radius: 7, opacity: 0.45 + (i % 3) * 0.2 })),
        T('social-dark-podcast-guest', 520, 826, 472, 40, { text: 'With Mira Okonkwo', size: 28, weight: 500, align: 'right', color: '#cbd5e1' }),
        T('social-dark-podcast-guest-role', 520, 874, 472, 36, { text: 'Head of Design, Northwind', size: 22, weight: 400, align: 'right', color: '#64748b' }),
      ],
    };
  },
};

/* ════════════════════════════════════════════════════════════════════════ */
/* STORY — 1080 × 1920                                                      */
/* ════════════════════════════════════════════════════════════════════════ */

const storySaleGradient: Template = {
  id: 'story-sale-gradient', name: 'Sale Story', category: 'Story', width: 1080, height: 1920,
  build: () => ({
    width: 1080, height: 1920,
    background: grad(160, [0, '#f97316'], [0.5, '#f43f5e'], [1, '#db2777']),
    nodes: [
      E('story-sale-gradient-orb-a', 700, -220, 640, 640, { fill: solid('#ffffff'), opacity: 0.12 }),
      E('story-sale-gradient-orb-b', -260, 1240, 900, 900, { fill: solid('#fef08a'), opacity: 0.18 }),
      R('story-sale-gradient-pill', 100, 220, 360, 64, { fill: solid('#ffffff'), radius: 32, opacity: 0.2 }),
      T('story-sale-gradient-pill-label', 100, 220, 360, 64, { text: 'Spring Sale', size: 26, weight: 600, ls: 3, upper: true, align: 'center', valign: 'middle', color: '#ffffff' }),
      T('story-sale-gradient-number', 100, 380, 880, 600, { text: '50%\nOFF', font: 'Space Grotesk', size: 300, weight: 700, lh: 0.98, ls: -8, upper: true, color: '#ffffff' }),
      T('story-sale-gradient-scope', 100, 1000, 880, 100, { text: 'Everything in store', font: 'Space Grotesk', size: 68, weight: 500, ls: -1, color: '#fff7ed' }),
      L('story-sale-gradient-rule', 100, 1140, 880, { color: '#ffffff', width: 2, opacity: 0.4 }),
      T('story-sale-gradient-detail', 100, 1190, 700, 190, { text: 'Two weeks only. Use code SPRING50 at checkout — it applies to every plan and every add-on.', size: 34, weight: 400, lh: 1.45, color: '#ffe4e6' }),
      R('story-sale-gradient-cta', 100, 1560, 880, 112, { fill: solid('#ffffff'), radius: 56 }),
      T('story-sale-gradient-cta-label', 100, 1560, 880, 112, { text: 'Shop the sale', size: 38, weight: 700, align: 'center', valign: 'middle', color: '#db2777' }),
      T('story-sale-gradient-swipe', 100, 1740, 880, 44, { text: 'Swipe up for details', size: 26, weight: 500, ls: 2, upper: true, align: 'center', color: '#ffe4e6' }),
    ],
  }),
};

const storyMinimalQuote: Template = {
  id: 'story-minimal-quote', name: 'Quiet Story', category: 'Story', width: 1080, height: 1920,
  build: () => ({
    width: 1080, height: 1920,
    background: solid('#f5f3ef'),
    nodes: [
      R('story-minimal-quote-spine', 100, 260, 3, 1400, { fill: solid('#d6d3d1') }),
      E('story-minimal-quote-ring', 740, 1400, 240, 240, { fill: none, stroke: stroke('#ded9d2', 2) }),
      T('story-minimal-quote-kicker', 148, 260, 800, 36, { text: 'Issue Twelve', size: 22, weight: 600, ls: 6, upper: true, color: '#78716c' }),
      T('story-minimal-quote-body', 148, 460, 820, 580, { text: 'Simplicity is\nnot the absence\nof clutter — it\nis the result\nof care.', font: 'DM Serif Display', size: 96, weight: 400, lh: 1.14, ls: -1, color: '#171717' }),
      R('story-minimal-quote-accent', 148, 1100, 64, 4, { fill: solid('#a8a29e') }),
      T('story-minimal-quote-attrib', 148, 1148, 700, 44, { text: 'Notes on making things', size: 30, weight: 600, color: '#292524' }),
      T('story-minimal-quote-meta', 148, 1200, 700, 40, { text: 'Volume 3 · Autumn', size: 24, weight: 400, color: '#78716c' }),
      T('story-minimal-quote-footer', 148, 1740, 800, 40, { text: 'artboard.design', size: 24, weight: 500, ls: 3, upper: true, color: '#a8a29e' }),
    ],
  }),
};

const storyDarkEvent: Template = {
  id: 'story-dark-event', name: 'Event Story', category: 'Story', width: 1080, height: 1920,
  build: () => ({
    width: 1080, height: 1920,
    background: grad(165, [0, '#020617'], [1, '#1e3a8a']),
    nodes: [
      E('story-dark-event-ring', -160, 140, 520, 520, { fill: none, stroke: stroke('#1e40af', 3) }),
      P('story-dark-event-blob', 680, 1240, 560, 560, { d: BLOB, viewBox: [100, 100], fill: grad(120, [0, '#22d3ee'], [1, '#3b82f6']), opacity: 0.25 }),
      T('story-dark-event-label', 96, 280, 888, 40, { text: 'Live · Online', font: 'Space Grotesk', size: 24, weight: 600, ls: 5, upper: true, color: '#22d3ee' }),
      T('story-dark-event-title', 96, 380, 888, 500, { text: 'Design\nSystems\nSummit', font: 'Space Grotesk', size: 152, weight: 700, lh: 1.02, ls: -4, color: '#f8fafc' }),
      L('story-dark-event-rule', 96, 920, 888, { color: '#1e40af', width: 2 }),
      T('story-dark-event-date', 96, 976, 560, 64, { text: '14 – 15 November', size: 44, weight: 600, color: '#e2e8f0' }),
      T('story-dark-event-time', 96, 1054, 560, 48, { text: '09:00 – 17:00 GMT', font: 'JetBrains Mono', size: 28, weight: 400, color: '#93c5fd' }),
      T('story-dark-event-body', 96, 1180, 560, 240, { text: 'Two days of talks on tokens, theming, and the unglamorous work of keeping a system alive.', size: 32, weight: 400, lh: 1.5, color: '#cbd5e1' }),
      R('story-dark-event-cta', 96, 1620, 520, 104, { fill: grad(90, [0, '#22d3ee'], [1, '#3b82f6']), radius: 12 }),
      T('story-dark-event-cta-label', 96, 1620, 520, 104, { text: 'Reserve a seat', size: 34, weight: 700, align: 'center', valign: 'middle', color: '#04121f' }),
      T('story-dark-event-footer', 96, 1776, 888, 40, { text: 'Free for members · artboard.design/summit', size: 22, weight: 400, color: '#94a3b8' }),
    ],
  }),
};

/* ════════════════════════════════════════════════════════════════════════ */
/* PRESENTATION — 1920 × 1080                                               */
/* ════════════════════════════════════════════════════════════════════════ */

const deckTitleCool: Template = {
  id: 'deck-title-cool', name: 'Deck Title', category: 'Presentation', width: 1920, height: 1080,
  build: () => ({
    width: 1920, height: 1080,
    background: grad(150, [0, '#0f172a'], [1, '#1e40af']),
    nodes: [
      E('deck-title-cool-glow', 1240, -260, 940, 940, { fill: solid('#3b82f6'), opacity: 0.18 }),
      E('deck-title-cool-ring', 1420, 460, 420, 420, { fill: none, stroke: stroke('#1d4ed8', 2) }),
      T('deck-title-cool-label', 140, 240, 900, 36, { text: 'Q3 Product Review', font: 'Space Grotesk', size: 22, weight: 600, ls: 5, upper: true, color: '#93c5fd' }),
      R('deck-title-cool-bar', 140, 300, 96, 8, { fill: solid('#60a5fa'), radius: 4 }),
      T('deck-title-cool-title', 140, 360, 1180, 300, { text: 'The year we\nmade it boring', font: 'Space Grotesk', size: 128, weight: 700, lh: 1.08, ls: -3, color: '#f8fafc' }),
      T('deck-title-cool-sub', 140, 700, 900, 140, { text: 'How we cut the surface area of the product in half and doubled activation.', size: 34, weight: 400, lh: 1.45, color: '#bfdbfe' }),
      L('deck-title-cool-rule', 140, 900, 1640, { color: '#1e40af', width: 2 }),
      T('deck-title-cool-presenter', 140, 936, 800, 40, { text: 'Mira Okonkwo · Head of Design', size: 24, weight: 500, color: '#cbd5e1' }),
      T('deck-title-cool-page', 1580, 936, 200, 40, { text: '01 / 24', font: 'JetBrains Mono', size: 24, weight: 400, align: 'right', color: '#60a5fa' }),
    ],
  }),
};

const deckSectionMono: Template = {
  id: 'deck-section-mono', name: 'Section Divider', category: 'Presentation', width: 1920, height: 1080,
  build: () => ({
    width: 1920, height: 1080,
    background: solid('#111111'),
    nodes: [
      R('deck-section-mono-panel', 0, 0, 760, 1080, { fill: solid('#fafafa') }),
      T('deck-section-mono-number', 80, 280, 600, 460, { text: '02', font: 'Space Grotesk', size: 380, weight: 700, lh: 1, ls: -20, color: '#111111' }),
      R('deck-section-mono-accent', 80, 800, 180, 10, { fill: solid('#ef4444') }),
      T('deck-section-mono-caption', 80, 846, 600, 40, { text: 'Section', size: 22, weight: 600, ls: 6, upper: true, color: '#737373' }),
      T('deck-section-mono-title', 880, 380, 940, 280, { text: 'Rendering\n& fidelity', font: 'Space Grotesk', size: 110, weight: 700, lh: 1.1, ls: -2, color: '#fafafa' }),
      L('deck-section-mono-rule', 880, 700, 940, { color: '#3f3f46', width: 2 }),
      T('deck-section-mono-body', 880, 744, 820, 180, { text: 'One renderer, one code path. What the editor draws is exactly what the exporter writes.', size: 30, weight: 400, lh: 1.5, color: '#a1a1aa' }),
      T('deck-section-mono-page', 1620, 976, 200, 40, { text: '02 / 24', font: 'JetBrains Mono', size: 22, weight: 400, align: 'right', color: '#71717a' }),
    ],
  }),
};

const deckStatTrio: Template = {
  id: 'deck-stat-trio', name: 'Three Stats', category: 'Presentation', width: 1920, height: 1080,
  build: () => {
    const cols: Array<{ value: string; label: string; body: string }> = [
      { value: '3.2×', label: 'Faster to first draft', body: 'Measured from empty canvas to a shareable export.' },
      { value: '97%',  label: 'Files open clean',      body: 'Documents from older builds load with no repair step.' },
      { value: '40ms', label: 'Cold start',            body: 'Time to an interactive canvas on a mid-range laptop.' },
    ];
    return {
      width: 1920, height: 1080,
      background: solid('#ffffff'),
      nodes: [
        R('deck-stat-trio-topbar', 0, 0, 1920, 10, { fill: solid('#2563eb') }),
        T('deck-stat-trio-label', 140, 140, 900, 36, { text: 'By the numbers', size: 22, weight: 600, ls: 5, upper: true, color: '#2563eb' }),
        T('deck-stat-trio-headline', 140, 196, 1200, 120, { text: 'A quieter tool, measured', font: 'Space Grotesk', size: 76, weight: 700, ls: -2, color: '#0f172a' }),
        ...cols.flatMap((c, i) => {
          const x = 140 + i * 590;
          const id = `deck-stat-trio-col-${i + 1}`;
          return [
            L(`${id}-rule`, x, 420, 470, { color: '#e2e8f0', width: 2 }),
            T(`${id}-value`, x, 460, 470, 180, { text: c.value, font: 'Space Grotesk', size: 132, weight: 700, lh: 1, ls: -4, color: '#0f172a' }),
            T(`${id}-label`, x, 650, 470, 40, { text: c.label, size: 22, weight: 600, ls: 4, upper: true, color: '#2563eb' }),
            T(`${id}-body`, x, 700, 430, 150, { text: c.body, size: 24, weight: 400, lh: 1.5, color: '#64748b' }),
          ];
        }),
        L('deck-stat-trio-rule-bottom', 140, 940, 1640, { color: '#e2e8f0', width: 2 }),
        T('deck-stat-trio-footer', 140, 976, 900, 40, { text: 'Internal benchmark · n = 1,240 documents', size: 22, weight: 400, color: '#94a3b8' }),
        T('deck-stat-trio-page', 1580, 976, 200, 40, { text: '03 / 24', font: 'JetBrains Mono', size: 22, weight: 400, align: 'right', color: '#94a3b8' }),
      ],
    };
  },
};

/* ════════════════════════════════════════════════════════════════════════ */
/* POSTER — A4, 2480 × 3508                                                 */
/* ════════════════════════════════════════════════════════════════════════ */

const posterEditorialWarm: Template = {
  id: 'poster-editorial-warm', name: 'Editorial Poster', category: 'Poster', width: 2480, height: 3508,
  build: () => ({
    width: 2480, height: 3508,
    background: solid('#f7f1e8'),
    nodes: [
      L('poster-editorial-warm-rule-top', 200, 200, 2080, { color: '#d6c7b0', width: 4 }),
      T('poster-editorial-warm-kicker', 200, 250, 2080, 70, { text: 'The Artboard Review · Issue 04', size: 42, weight: 600, ls: 8, upper: true, color: '#b45309' }),
      T('poster-editorial-warm-headline', 200, 600, 2080, 1760, { text: 'Making\nthings\nby hand,\nagain', font: 'Playfair Display', size: 420, weight: 400, lh: 1.02, ls: -8, color: '#1b1917' }),
      R('poster-editorial-warm-accent', 200, 2440, 240, 12, { fill: solid('#b45309') }),
      T('poster-editorial-warm-deck', 200, 2520, 1500, 400, { text: 'A field guide to slow tools, honest defaults, and software that does not ask for your attention.', font: 'Playfair Display', size: 76, weight: 400, lh: 1.35, color: '#3f3a35' }),
      E('poster-editorial-warm-ring', 1900, 2500, 380, 380, { fill: none, stroke: stroke('#b45309', 4) }),
      T('poster-editorial-warm-number', 1900, 2500, 380, 380, { text: '04', font: 'DM Serif Display', size: 130, weight: 400, align: 'center', valign: 'middle', color: '#b45309' }),
      L('poster-editorial-warm-rule-bottom', 200, 3150, 2080, { color: '#d6c7b0', width: 2 }),
      T('poster-editorial-warm-colophon', 200, 3210, 1000, 140, { text: 'Printed in Lisbon\nEdition of 300', size: 38, weight: 400, lh: 1.5, color: '#6b6257' }),
      T('poster-editorial-warm-site', 1480, 3210, 800, 60, { text: 'artboard.design', size: 38, weight: 500, ls: 4, align: 'right', color: '#6b6257' }),
    ],
  }),
};

const posterSwissGrid: Template = {
  id: 'poster-swiss-grid', name: 'Swiss Grid Poster', category: 'Poster', width: 2480, height: 3508,
  build: () => ({
    width: 2480, height: 3508,
    background: solid('#f4f4f5'),
    nodes: [
      ...[200, 720, 1240, 1760, 2280].map((x, i) => R(`poster-swiss-grid-column-${i}`, x, 200, 2, 3108, { fill: solid('#e0e0e3') })),
      R('poster-swiss-grid-block', 1240, 200, 1040, 1040, { fill: solid('#dc2626') }),
      T('poster-swiss-grid-block-label', 1320, 1000, 880, 160, { text: 'Vol. 09', size: 96, weight: 700, ls: -2, color: '#ffffff' }),
      T('poster-swiss-grid-headline', 200, 1400, 2080, 1100, { text: 'Form\nfollows\nfunction', size: 340, weight: 800, lh: 1.02, ls: -10, upper: true, color: '#09090b' }),
      L('poster-swiss-grid-rule', 200, 2600, 2080, { color: '#09090b', width: 4 }),
      T('poster-swiss-grid-body', 200, 2680, 980, 460, { text: 'A retrospective of Swiss typographic method, 1957 to 1972. Posters, grids, and the discipline of the modular scale.', size: 46, weight: 400, lh: 1.5, color: '#3f3f46' }),
      T('poster-swiss-grid-meta', 1320, 2680, 960, 460, { text: '12 March – 30 June\nKunsthalle, Basel\nDaily 10:00 – 18:00', font: 'JetBrains Mono', size: 44, weight: 400, lh: 1.7, color: '#09090b' }),
      R('poster-swiss-grid-tick', 200, 3240, 200, 14, { fill: solid('#dc2626') }),
      T('poster-swiss-grid-footer', 440, 3226, 1840, 60, { text: 'Free entry', size: 40, weight: 600, ls: 4, upper: true, color: '#09090b' }),
    ],
  }),
};

const posterGradientMusic: Template = {
  id: 'poster-gradient-music', name: 'Music Night Poster', category: 'Poster', width: 2480, height: 3508,
  build: () => ({
    width: 2480, height: 3508,
    background: grad(145, [0, '#7c3aed'], [0.55, '#4f46e5'], [1, '#06b6d4']),
    nodes: [
      E('poster-gradient-music-orb-a', 1500, 200, 1200, 1200, { fill: solid('#f0abfc'), opacity: 0.32 }),
      E('poster-gradient-music-orb-b', 180, 980, 820, 820, { fill: solid('#22d3ee'), opacity: 0.28 }),
      E('poster-gradient-music-ring', 1620, 180, 760, 760, { fill: none, stroke: stroke('#ffffff', 6), opacity: 0.5 }),
      T('poster-gradient-music-label', 200, 260, 1200, 80, { text: 'Night Programme', font: 'Space Grotesk', size: 44, weight: 600, ls: 10, upper: true, color: '#f5d0fe' }),
      T('poster-gradient-music-title', 200, 1500, 2080, 1120, { text: 'Sound\nand\nsilence', font: 'Space Grotesk', size: 360, weight: 700, lh: 1, ls: -12, upper: true, color: '#ffffff' }),
      L('poster-gradient-music-rule', 200, 2700, 2080, { color: '#ffffff', width: 4, opacity: 0.6 }),
      T('poster-gradient-music-lineup', 200, 2780, 1200, 420, { text: 'Kaia Vance\nThe Long Room\nOrenda\nNilüfer Ash', size: 62, weight: 500, lh: 1.5, color: '#ffffff' }),
      T('poster-gradient-music-info', 1560, 2780, 720, 420, { text: 'Sat 21 June\n20:00\nPier 4, Rotterdam\n€24', font: 'JetBrains Mono', size: 48, weight: 400, lh: 1.6, align: 'right', color: '#e9d5ff' }),
      T('poster-gradient-music-footer', 200, 3320, 2080, 70, { text: 'Tickets at artboard.design/sound', size: 40, weight: 500, ls: 4, upper: true, color: '#ffffff' }),
    ],
  }),
};

/* ════════════════════════════════════════════════════════════════════════ */
/* MARKETING                                                                */
/* ════════════════════════════════════════════════════════════════════════ */

const marketingOgProduct: Template = {
  id: 'marketing-og-product', name: 'Link Preview Card', category: 'Marketing', width: 1200, height: 630,
  build: () => ({
    width: 1200, height: 630,
    background: solid('#f1f5f9'),
    nodes: [
      R('marketing-og-product-panel', 760, 0, 440, 630, { fill: grad(135, [0, '#2563eb'], [1, '#06b6d4']) }),
      E('marketing-og-product-orb-a', 880, 180, 280, 280, { fill: solid('#ffffff'), opacity: 0.16 }),
      E('marketing-og-product-orb-b', 792, 392, 180, 180, { fill: solid('#ffffff'), opacity: 0.1 }),
      T('marketing-og-product-badge', 880, 180, 280, 280, { text: 'MIT', font: 'Space Grotesk', size: 96, weight: 700, ls: -2, align: 'center', valign: 'middle', color: '#ffffff' }),
      R('marketing-og-product-bar', 72, 96, 64, 6, { fill: solid('#2563eb'), radius: 3 }),
      T('marketing-og-product-label', 72, 126, 620, 32, { text: 'Open source', size: 18, weight: 600, ls: 4, upper: true, color: '#2563eb' }),
      T('marketing-og-product-headline', 72, 190, 640, 180, { text: 'The design tool\nthat opens fast.', font: 'Space Grotesk', size: 62, weight: 700, lh: 1.12, ls: -1.5, color: '#0f172a' }),
      T('marketing-og-product-sub', 72, 400, 600, 110, { text: 'Vector editing, real typography, MIT licensed. No account required.', size: 24, weight: 400, lh: 1.45, color: '#475569' }),
      L('marketing-og-product-rule', 72, 520, 620, { color: '#cbd5e1', width: 2 }),
      T('marketing-og-product-footer', 72, 544, 620, 36, { text: 'artboard.design', size: 20, weight: 600, ls: 2, color: '#0f172a' }),
    ],
  }),
};

const marketingYoutubeThumb: Template = {
  id: 'marketing-yt-thumb', name: 'Video Thumbnail', category: 'Marketing', width: 1280, height: 720,
  build: () => ({
    width: 1280, height: 720,
    background: solid('#18181b'),
    nodes: [
      E('marketing-yt-thumb-glow', 880, -140, 560, 560, { fill: solid('#ef4444'), opacity: 0.28 }),
      R('marketing-yt-thumb-badge', 1050, 110, 180, 180, { fill: solid('#ef4444'), radius: 28, rotation: 12 }),
      T('marketing-yt-thumb-badge-label', 1050, 110, 180, 180, { text: '07', font: 'Space Grotesk', size: 76, weight: 800, align: 'center', valign: 'middle', color: '#ffffff', rotation: 12 }),
      T('marketing-yt-thumb-kicker', 80, 88, 800, 48, { text: 'Tutorial', size: 28, weight: 700, ls: 6, upper: true, color: '#facc15' }),
      T('marketing-yt-thumb-headline', 80, 168, 940, 380, { text: 'Build a\ncanvas editor\nin a weekend', font: 'Space Grotesk', size: 104, weight: 800, lh: 1.08, ls: -2, upper: true, color: '#ffffff' }),
      R('marketing-yt-thumb-band', 0, 612, 1280, 108, { fill: solid('#facc15') }),
      T('marketing-yt-thumb-band-label', 80, 612, 1120, 108, { text: 'artboard.design · full build, no fluff', size: 34, weight: 700, ls: 2, upper: true, valign: 'middle', color: '#18181b' }),
    ],
  }),
};

const marketingWebinar: Template = {
  id: 'marketing-webinar', name: 'Webinar Announcement', category: 'Marketing', width: 1600, height: 900,
  build: () => ({
    width: 1600, height: 900,
    background: solid('#efe9e4'),
    nodes: [
      E('marketing-webinar-orb', 1240, -260, 560, 560, { fill: solid('#c98b6b'), opacity: 0.35 }),
      R('marketing-webinar-spine', 0, 0, 18, 900, { fill: solid('#7c6a5a') }),
      T('marketing-webinar-kicker', 120, 120, 900, 40, { text: 'Live webinar', size: 22, weight: 600, ls: 6, upper: true, color: '#b06a44' }),
      T('marketing-webinar-headline', 120, 200, 1000, 260, { text: 'Designing with\nfewer decisions', font: 'Playfair Display', size: 96, weight: 400, lh: 1.12, ls: -1, color: '#2b2724' }),
      L('marketing-webinar-rule', 120, 540, 1000, { color: '#d5c9bf', width: 2 }),
      T('marketing-webinar-body', 120, 576, 860, 150, { text: 'A 45-minute session on constraint-led design systems, with a live teardown of three real products.', size: 28, weight: 400, lh: 1.5, color: '#5b5147' }),
      T('marketing-webinar-date', 120, 762, 760, 60, { text: 'Thu 12 Feb · 16:00 CET', size: 30, weight: 600, color: '#2b2724' }),
      E('marketing-webinar-avatar', 1180, 260, 200, 200, { fill: solid('#7c6a5a') }),
      T('marketing-webinar-initials', 1180, 260, 200, 200, { text: 'MO', font: 'Playfair Display', size: 76, weight: 400, align: 'center', valign: 'middle', color: '#efe9e4' }),
      T('marketing-webinar-speaker', 1100, 494, 360, 40, { text: 'Mira Okonkwo', size: 26, weight: 600, align: 'center', color: '#2b2724' }),
      T('marketing-webinar-speaker-role', 1100, 538, 360, 40, { text: 'Head of Design, Northwind', size: 20, weight: 400, align: 'center', color: '#6b6157' }),
      R('marketing-webinar-cta', 1140, 740, 340, 88, { fill: solid('#2b2724'), radius: 44 }),
      T('marketing-webinar-cta-label', 1140, 740, 340, 88, { text: 'Save my seat', size: 28, weight: 600, align: 'center', valign: 'middle', color: '#f7f2ed' }),
    ],
  }),
};

const marketingFlyerBold: Template = {
  id: 'marketing-flyer-bold', name: 'Workshop Flyer', category: 'Marketing', width: 1275, height: 1650,
  build: () => ({
    width: 1275, height: 1650,
    background: solid('#fffdf7'),
    nodes: [
      R('marketing-flyer-bold-header', 0, 0, 1275, 560, { fill: grad(140, [0, '#0f766e'], [1, '#65a30d']) }),
      E('marketing-flyer-bold-orb', 900, -160, 520, 520, { fill: solid('#fef9c3'), opacity: 0.25 }),
      T('marketing-flyer-bold-kicker', 100, 110, 1000, 40, { text: 'Two-day workshop', size: 24, weight: 600, ls: 6, upper: true, color: '#d9f99d' }),
      T('marketing-flyer-bold-title', 100, 190, 1000, 280, { text: 'Print for\nscreen people', font: 'Space Grotesk', size: 108, weight: 700, lh: 1.08, ls: -2, color: '#ffffff' }),
      T('marketing-flyer-bold-body', 100, 640, 820, 200, { text: 'Grids, ink limits, bleed, and the joy of a thing you can hold. Bring a laptop and one idea worth printing.', size: 30, weight: 400, lh: 1.5, color: '#3f3f46' }),
      L('marketing-flyer-bold-rule', 100, 860, 1075, { color: '#d4d4d8', width: 2 }),
      ...[
        { k: 'When', v: 'Sat 8 – Sun 9 March\n10:00 – 16:00' },
        { k: 'Where', v: 'Studio Fourteen\n14 Mill Lane, Bristol' },
        { k: 'Cost', v: '£180 · materials included\nTen places only' },
      ].flatMap((row, i) => {
        const y = 910 + i * 170;
        const id = `marketing-flyer-bold-row-${i + 1}`;
        return [
          T(`${id}-key`, 100, y, 260, 40, { text: row.k, size: 22, weight: 600, ls: 4, upper: true, color: '#0f766e' }),
          T(`${id}-value`, 400, y - 6, 775, 120, { text: row.v, size: 30, weight: 400, lh: 1.5, color: '#27272a' }),
        ];
      }),
      R('marketing-flyer-bold-cta', 100, 1470, 480, 96, { fill: solid('#0f766e'), radius: 12 }),
      T('marketing-flyer-bold-cta-label', 100, 1470, 480, 96, { text: 'Book a place', size: 32, weight: 700, align: 'center', valign: 'middle', color: '#ffffff' }),
      T('marketing-flyer-bold-footer', 640, 1470, 535, 96, { text: 'studiofourteen.co.uk', font: 'JetBrains Mono', size: 26, weight: 400, ls: 1, align: 'right', valign: 'middle', color: '#71717a' }),
    ],
  }),
};

/* ════════════════════════════════════════════════════════════════════════ */
/* BUSINESS                                                                 */
/* ════════════════════════════════════════════════════════════════════════ */

const businessCardMono: Template = {
  id: 'business-card-mono', name: 'Card — Monochrome', category: 'Business', width: 1050, height: 600,
  build: () => ({
    width: 1050, height: 600,
    background: solid('#101010'),
    nodes: [
      R('business-card-mono-spine', 88, 88, 2, 424, { fill: solid('#333333') }),
      T('business-card-mono-name', 130, 176, 600, 84, { text: 'Mira Okonkwo', font: 'Space Grotesk', size: 58, weight: 700, ls: -1, color: '#fafafa' }),
      T('business-card-mono-role', 130, 266, 600, 44, { text: 'Head of Design', size: 26, weight: 400, ls: 3, upper: true, color: '#a3a3a3' }),
      L('business-card-mono-rule', 130, 344, 200, { color: '#525252', width: 2 }),
      T('business-card-mono-contact', 130, 386, 600, 140, { text: 'mira@northwind.co\n+31 6 1234 5678\nnorthwind.co', font: 'JetBrains Mono', size: 22, weight: 400, lh: 1.7, color: '#d4d4d4' }),
      E('business-card-mono-mark', 820, 176, 140, 140, { fill: none, stroke: stroke('#fafafa', 2) }),
      T('business-card-mono-mark-label', 820, 176, 140, 140, { text: 'N', font: 'Space Grotesk', size: 60, weight: 700, align: 'center', valign: 'middle', color: '#fafafa' }),
      T('business-card-mono-studio', 650, 470, 310, 40, { text: 'Northwind Studio', size: 20, weight: 500, ls: 3, upper: true, align: 'right', color: '#737373' }),
    ],
  }),
};

const businessCardWarm: Template = {
  id: 'business-card-warm', name: 'Card — Warm Serif', category: 'Business', width: 1050, height: 600,
  build: () => ({
    width: 1050, height: 600,
    background: solid('#fdfaf5'),
    nodes: [
      R('business-card-warm-band-top', 0, 0, 1050, 14, { fill: solid('#a16207') }),
      T('business-card-warm-name', 110, 168, 620, 96, { text: 'Elias Moreau', font: 'DM Serif Display', size: 62, weight: 400, color: '#2a2118' }),
      T('business-card-warm-role', 110, 268, 620, 44, { text: 'Bookbinder & Printer', size: 22, weight: 500, ls: 4, upper: true, color: '#a16207' }),
      L('business-card-warm-rule', 110, 344, 160, { color: '#ddd0ba', width: 2 }),
      T('business-card-warm-contact', 110, 386, 620, 140, { text: 'atelier@moreau.paris\n+33 1 45 67 89 01\n12 Rue de la Presse, Paris', size: 21, weight: 400, lh: 1.7, color: '#5a4c3b' }),
      E('business-card-warm-mark', 800, 168, 150, 150, { fill: solid('#f4ead8') }),
      T('business-card-warm-mark-label', 800, 168, 150, 150, { text: 'EM', font: 'DM Serif Display', size: 58, weight: 400, align: 'center', valign: 'middle', color: '#a16207' }),
      T('business-card-warm-est', 760, 476, 190, 40, { text: 'Est. 1998', size: 18, weight: 500, ls: 3, upper: true, align: 'right', color: '#8b7a63' }),
      R('business-card-warm-band-bottom', 0, 586, 1050, 14, { fill: solid('#ddd0ba') }),
    ],
  }),
};

const businessLinkedinBanner: Template = {
  id: 'business-linkedin-banner', name: 'Profile Banner', category: 'Business', width: 1584, height: 396,
  build: () => ({
    width: 1584, height: 396,
    background: grad(120, [0, '#0f172a'], [1, '#155e75']),
    nodes: [
      E('business-linkedin-banner-orb-a', 1180, -120, 520, 520, { fill: solid('#22d3ee'), opacity: 0.16 }),
      E('business-linkedin-banner-orb-b', 980, 180, 300, 300, { fill: solid('#0ea5e9'), opacity: 0.14 }),
      T('business-linkedin-banner-label', 96, 86, 900, 32, { text: 'Northwind Studio', size: 18, weight: 600, ls: 5, upper: true, color: '#67e8f9' }),
      R('business-linkedin-banner-bar', 96, 124, 72, 6, { fill: solid('#22d3ee'), radius: 3 }),
      T('business-linkedin-banner-headline', 96, 160, 1000, 80, { text: 'Design systems that outlive redesigns', font: 'Space Grotesk', size: 48, weight: 700, ls: -1, color: '#f8fafc' }),
      T('business-linkedin-banner-sub', 96, 254, 900, 50, { text: 'Product design · Design systems · Brand · Amsterdam', size: 24, weight: 400, color: '#a5f3fc' }),
      T('business-linkedin-banner-site', 1120, 254, 368, 44, { text: 'northwind.co', font: 'JetBrains Mono', size: 24, weight: 500, align: 'right', color: '#67e8f9' }),
    ],
  }),
};

const businessLetterhead: Template = {
  id: 'business-letterhead', name: 'Letterhead', category: 'Business', width: 2480, height: 3508,
  build: () => ({
    width: 2480, height: 3508,
    background: solid('#ffffff'),
    nodes: [
      R('business-letterhead-band', 0, 0, 2480, 24, { fill: grad(90, [0, '#0f172a'], [1, '#0e7490']) }),
      T('business-letterhead-logo', 220, 240, 900, 90, { text: 'Northwind', font: 'Space Grotesk', size: 64, weight: 700, ls: -2, color: '#0f172a' }),
      T('business-letterhead-logo-sub', 220, 336, 900, 40, { text: 'Studio for design systems', size: 24, weight: 500, ls: 4, upper: true, color: '#0e7490' }),
      T('business-letterhead-contact', 1500, 240, 760, 160, { text: 'Keizersgracht 241\n1016 EA Amsterdam\nhello@northwind.co', font: 'JetBrains Mono', size: 26, weight: 400, lh: 1.7, align: 'right', color: '#475569' }),
      L('business-letterhead-rule', 220, 480, 2040, { color: '#e2e8f0', width: 3 }),
      T('business-letterhead-meta', 220, 620, 900, 120, { text: 'Amsterdam, 12 February 2026', size: 30, weight: 400, lh: 1.6, color: '#64748b' }),
      T('business-letterhead-subject', 220, 800, 1600, 90, { text: 'Statement of work — design system audit', font: 'Space Grotesk', size: 52, weight: 700, ls: -1, color: '#0f172a' }),
      T('business-letterhead-body', 220, 940, 1700, 900, { text: 'Dear Mira,\n\nThank you for the introduction last week. What follows is a short summary of the work we discussed, the shape it would take, and what it would cost.\n\nWe would begin with a two-week audit of the existing component library, mapping every component to its live usage and marking the ones that no longer earn their place. That inventory becomes the plan for everything after it.\n\nIf that sounds right, sign below and we will start on the first Monday that suits you.', size: 30, weight: 400, lh: 1.65, color: '#1e293b' }),
      L('business-letterhead-sign-rule', 220, 2140, 700, { color: '#cbd5e1', width: 2 }),
      T('business-letterhead-sign', 220, 2170, 700, 60, { text: 'Elias Moreau · Principal', size: 26, weight: 500, color: '#475569' }),
      L('business-letterhead-footer-rule', 220, 3260, 2040, { color: '#e2e8f0', width: 2 }),
      T('business-letterhead-footer', 220, 3300, 1200, 50, { text: 'Northwind Studio B.V. · KvK 12345678', size: 22, weight: 400, color: '#94a3b8' }),
      T('business-letterhead-page', 1900, 3300, 360, 50, { text: 'Page 1 of 1', font: 'JetBrains Mono', size: 22, weight: 400, align: 'right', color: '#94a3b8' }),
    ],
  }),
};

/* ── registry ───────────────────────────────────────────────────────────── */
export const TEMPLATES: Template[] = [
  socialGradientLaunch,
  socialEditorialQuote,
  socialMonoStat,
  socialPastelTips,
  socialDarkPodcast,
  storySaleGradient,
  storyMinimalQuote,
  storyDarkEvent,
  deckTitleCool,
  deckSectionMono,
  deckStatTrio,
  posterEditorialWarm,
  posterSwissGrid,
  posterGradientMusic,
  marketingOgProduct,
  marketingYoutubeThumb,
  marketingWebinar,
  marketingFlyerBold,
  businessCardMono,
  businessCardWarm,
  businessLinkedinBanner,
  businessLetterhead,
];

/** Category order is curated, not alphabetical — it is the order the picker shows. */
export const CATEGORIES: string[] = ['Social', 'Story', 'Presentation', 'Poster', 'Marketing', 'Business'];

export const getTemplate = (id: string): Template | undefined => TEMPLATES.find(t => t.id === id);
export const templatesInCategory = (category: string): Template[] => TEMPLATES.filter(t => t.category === category);
