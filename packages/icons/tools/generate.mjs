/**
 * Regenerates `src/data.ts` from an extracted `lucide-static` tarball.
 *
 * Run:
 *   npm pack lucide-static@<version>   &&  tar xzf lucide-static-<version>.tgz
 *   node packages/icons/tools/generate.mjs <path-to-extracted>/package
 *
 * This is a BUILD-TIME script and is never imported by the package itself —
 * `@artboard/icons` ships the generated data and nothing else, so it has no
 * runtime dependency on Node, the filesystem or the network.
 *
 * Lucide draws each icon from several primitives (`path`, `circle`, `rect`,
 * `line`, `polyline`, `polygon`, `ellipse`). Artboard's `PathNode` holds a
 * single `d` string, so every primitive is converted to path commands and the
 * subpaths concatenated. That is exact for stroked icons: an `M` starts a new
 * subpath, and with `fill: none` there is no winding rule to get wrong.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, PICKS } from './icon-list.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { console.error('usage: node generate.mjs <extracted lucide-static>/package'); process.exit(1); }

const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
const tags = JSON.parse(readFileSync(join(src, 'tags.json'), 'utf8'));
const available = new Set(readdirSync(join(src, 'icons')).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4)));

/* ── number + geometry helpers ───────────────────────────────────────────── */

/** 3-dp, no `-0`, no trailing zeros — the same string every run. */
const n = v => {
  const r = Math.round(Number(v) * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};

const circleD = (cx, cy, rx, ry) =>
  `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(rx * 2)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-rx * 2)} 0`;

function rectD(x, y, w, h, rx, ry) {
  const r = Math.min(rx || ry || 0, w / 2, h / 2);
  if (r <= 0) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  return [
    `M${n(x + r)} ${n(y)}`,
    `h${n(w - 2 * r)}`, `a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}`,
    `v${n(h - 2 * r)}`, `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}`,
    `h${n(-(w - 2 * r))}`, `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}`,
    `v${n(-(h - 2 * r))}`, `a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}`,
    'Z',
  ].join('');
}

const pointsD = (points, close) => {
  const nums = points.trim().split(/[\s,]+/).map(Number);
  const parts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) parts.push(`${i === 0 ? 'M' : 'L'}${n(nums[i])} ${n(nums[i + 1])}`);
  return parts.join('') + (close ? 'Z' : '');
};

// The name class must allow digits, or `x1`/`y1` silently go missing and every
// `<line>` in the set turns into `M NaN NaN`.
const attrs = tag => {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};

/**
 * Make a `d` safe to append to another one.
 *
 * A standalone path that opens with a RELATIVE `m` is relative to the origin,
 * because that is where the current point starts. Concatenated after another
 * subpath it would instead be relative to that subpath's last point, which
 * silently flings the second half of the icon off the artboard. Rewrite the
 * opening command to an absolute `M`.
 *
 * Only the OPENING command changes. Any coordinate pairs that were riding on
 * the `m` as implicit repeats are relative linetos, so they get an explicit
 * `l` — promoting them to absolute along with the `M` would fold the icon in
 * half, which is exactly the kind of quiet damage a screenshot catches late.
 */
function absoluteStart(d) {
  if (d.startsWith('M')) return d;
  const m = /^m[\s,]*(-?(?:\d*\.\d+|\d+))[\s,]*(-?(?:\d*\.\d+|\d+))/.exec(d);
  if (!m) throw new Error(`path does not open with a moveto: ${d.slice(0, 24)}`);
  const rest = d.slice(m[0].length).replace(/^[\s,]+/, '');
  return `M${n(m[1])} ${n(m[2])}${/^[-.\d]/.test(rest) ? 'l' : ''}${rest}`;
}

/** Every drawn primitive in one lucide file, in document order, as one `d`. */
function toPathData(svg) {
  const parts = [];
  for (const m of svg.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b[^>]*>/g)) {
    const a = attrs(m[0]);
    switch (m[1]) {
      case 'path': parts.push(absoluteStart(a.d.replace(/\s+/g, ' ').trim())); break;
      case 'circle': parts.push(circleD(+a.cx, +a.cy, +a.r, +a.r)); break;
      case 'ellipse': parts.push(circleD(+a.cx, +a.cy, +a.rx, +a.ry)); break;
      case 'rect': parts.push(rectD(+a.x || 0, +a.y || 0, +a.width, +a.height, +a.rx || 0, +a.ry || 0)); break;
      case 'line': parts.push(`M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`); break;
      case 'polyline': parts.push(pointsD(a.points, false)); break;
      case 'polygon': parts.push(pointsD(a.points, true)); break;
    }
  }
  if (parts.length === 0) throw new Error('no drawable primitives');
  return parts.join('');
}

/** `arrow-up-right` -> `Arrow Up Right`. */
const title = id => id.split('-').map(w => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');

/* ── build ───────────────────────────────────────────────────────────────── */

const missing = [];
const seen = new Set();
const rows = [];

for (const { id: category } of CATEGORIES) {
  for (const name of PICKS[category] ?? []) {
    if (!available.has(name)) { missing.push(name); continue; }
    const id = seen.has(name) ? `${name}-${category}` : name;   // `star` lives in two categories
    seen.add(name);
    const svg = readFileSync(join(src, 'icons', `${name}.svg`), 'utf8');
    const words = new Set([...name.split('-'), ...(tags[name] ?? [])].filter(w => w.length > 1));
    rows.push({ id, name: title(name), category, tags: [...words].sort(), d: toPathData(svg) });
  }
}

if (missing.length) {
  console.error(`\n${missing.length} name(s) not in lucide ${pkg.version}:\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}

const esc = s => JSON.stringify(s);
const body = rows.map(r =>
  `  { id: ${esc(r.id)}, name: ${esc(r.name)}, category: ${esc(r.category)}, stroke: true,\n` +
  `    tags: [${r.tags.map(esc).join(', ')}],\n` +
  `    d: ${esc(r.d)} },`).join('\n');

const out = `/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  lucide-static v${pkg.version} (ISC) — https://lucide.dev
 * Script:  packages/icons/tools/generate.mjs
 *
 * Every icon here is an OUTLINE icon: the artwork is the stroke, not a filled
 * silhouette, so \`stroke: true\` on all ${rows.length} rows. Render them with
 * \`fill: none\` and a stroke width of ${'`ICON_STROKE_WIDTH`'} in viewBox units — filling
 * a lucide path instead turns it into a black blob.
 */
import type { Icon } from './index';

export const ICONS: readonly Icon[] = [
${body}
];
`;

const dest = join(HERE, '..', 'src', 'data.ts');
writeFileSync(dest, out);

const byCat = {};
for (const r of rows) byCat[r.category] = (byCat[r.category] ?? 0) + 1;
console.log(`wrote ${dest}`);
console.log(`${rows.length} icons, ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB`);
console.log(Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join(' '));
