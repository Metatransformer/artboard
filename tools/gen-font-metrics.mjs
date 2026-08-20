#!/usr/bin/env node
/**
 * Generates `packages/engine/src/metrics.ts` — real per-glyph advance widths for
 * the five families the renderer ships.
 *
 * Run offline at build time only:  npm run metrics
 *
 * Why generated-and-committed: `@artboard/engine` must have ZERO runtime
 * dependencies and must never touch the network or the filesystem, so the
 * numbers have to be baked into source. `fontkit` is a `--no-save` dev
 * dependency of THIS SCRIPT, never of the engine.
 *
 * Determinism: the font binaries are pinned to a google/fonts commit, the
 * codepoint set is a fixed literal, every number is emitted at exactly 4
 * decimal places and every key is sorted by codepoint. Running this twice must
 * produce a byte-identical file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'engine', 'src', 'metrics.ts');
const CACHE = join(tmpdir(), 'artboard-font-cache');

/** Pinned so a regeneration a year from now still produces the same table. */
const FONTS_REF = '3b1480ea4b6e15fed70a42f4cb29216476a044ed';
const RAW = (path) => `https://raw.githubusercontent.com/google/fonts/${FONTS_REF}/${path}`;

/**
 * Every weight the weight picker in `Inspector.tsx` can produce. Content only
 * uses 400–800, but 300 and 900 are one click away, and a weight the user can
 * select but we cannot measure is exactly the disagreement this table exists to
 * remove — the browser would render a real 900 while we measured an 800.
 */
const USED_WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

/**
 * The five families in `Inspector.tsx` / `LeftRail.tsx` / `@artboard/templates`.
 *
 * `ttf` is what we MEASURE (pinned, full, unsubsetted). `css` is the Google
 * Fonts request we BUNDLE from — the same upstream design, served as woff2.
 * Both must describe the same faces or the metrics stop being true.
 */
const FAMILIES = [
  { family: 'Inter',            file: 'ofl/inter/Inter%5Bopsz,wght%5D.ttf',            css: 'Inter:wght@100..900' },
  { family: 'Playfair Display', file: 'ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf', css: 'Playfair+Display:wght@400..900' },
  { family: 'DM Serif Display', file: 'ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf',  css: 'DM+Serif+Display' },
  { family: 'Space Grotesk',    file: 'ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf',    css: 'Space+Grotesk:wght@300..700' },
  { family: 'JetBrains Mono',   file: 'ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',  css: 'JetBrains+Mono:wght@100..800' },
];

/** Where the bundled woff2 files land. Vite copies `public/` verbatim into `dist/`. */
const FONT_OUT = join(ROOT, 'apps', 'studio', 'public', 'fonts');

/**
 * Subsets to bundle. `latin` carries U+0000–00FF and U+2000–206F, i.e. all of
 * Latin-1 plus every dash, quote, bullet and ellipsis we measured; `latin-ext`
 * adds the remaining European accents. Everything else Google slices out
 * (cyrillic, greek, vietnamese) is dropped — see docs/FONT-METRICS.md.
 */
const KEEP_SUBSETS = ['latin', 'latin-ext'];

/** Google serves woff2 only to a browser-shaped UA; Node's default gets TTF. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Latin-1 plus the typographic marks the editor and templates can actually
 * emit. Kerning is deliberately NOT sampled — see docs/FONT-METRICS.md.
 */
const EXTRA_CODEPOINTS = [
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, // hyphens and dashes
  0x2018, 0x2019, 0x201a, 0x201b,                 // single quotes
  0x201c, 0x201d, 0x201e, 0x201f,                 // double quotes
  0x2020, 0x2021, 0x2022, 0x2023, 0x2026,         // daggers, bullets, ellipsis
  0x2030, 0x2032, 0x2033, 0x2039, 0x203a, 0x2044, // permille, primes, guillemets, fraction slash
  0x20a3, 0x20a8, 0x20ac, 0x20b9, 0x20bd,         // currency
  0x2116, 0x2122, 0x2126, 0x212e,                 // numero, trademark, ohm, estimated
  0x2190, 0x2191, 0x2192, 0x2193,                 // arrows
  0x2212, 0x2215, 0x2248, 0x2260, 0x2264, 0x2265, // maths (× and ÷ live in Latin-1)
];

const CODEPOINTS = [
  ...range(0x20, 0x7e),   // ASCII printable
  ...range(0xa0, 0xff),   // Latin-1 supplement
  ...EXTRA_CODEPOINTS,
].sort((a, b) => a - b);

function range(lo, hi) {
  const out = [];
  for (let c = lo; c <= hi; c++) out.push(c);
  return out;
}

async function load(file) {
  mkdirSync(CACHE, { recursive: true });
  const key = join(CACHE, `${FONTS_REF}-${createHash('sha1').update(file).digest('hex')}.ttf`);
  if (existsSync(key)) return readFileSync(key);
  const res = await fetch(RAW(file));
  if (!res.ok) throw new Error(`GET ${RAW(file)} -> ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(key, buf);
  return buf;
}

/** 4 dp, always. `toFixed` is the whole determinism story for the numbers. */
const fx = (n) => (Math.abs(n) < 0.00005 ? 0 : n).toFixed(4);

/** ASCII-only source: everything above `~` becomes a \uXXXX escape. */
function keyLiteral(cp) {
  const ch = String.fromCodePoint(cp);
  if (cp >= 0x20 && cp <= 0x7e) return JSON.stringify(ch);
  return `"\\u${cp.toString(16).padStart(4, '0')}"`;
}

/* ── web font bundling ──────────────────────────────────────────────────────
 *
 * The editor must render with the same binaries we measured, offline. A CDN
 * link fails both halves of that: the desktop shell's CSP refuses it, and if
 * the OS substitutes a font, the measured wrap and the painted wrap disagree —
 * which is the exact bug the metrics table exists to remove.
 */

const slug = (family) => family.toLowerCase().replace(/\s+/g, '-');

/**
 * Downloads the woff2 faces into `apps/studio/public/fonts/` and returns the
 * `@font-face` stylesheet that points at them. Upright only: the metrics table
 * has no italic advances, so a bundled italic would render in a face we never
 * measured. Leaving it out makes the browser synthesize an oblique, which
 * shears the upright and keeps its advance widths — so the wrap stays correct.
 */
async function bundleWebFonts(measured) {
  mkdirSync(FONT_OUT, { recursive: true });
  // Drop faces from a previous run so a removed subset cannot linger in `dist/`.
  for (const f of readdirSync(FONT_OUT)) if (f.endsWith('.woff2')) rmSync(join(FONT_OUT, f));

  const css = [];
  const files = [];

  for (const { family, css: query } of FAMILIES) {
    // Clamp the descriptor to the weights we actually measured, rather than
    // echoing the font's full axis. A weight the browser can render but the
    // table cannot measure is the disagreement we are here to remove; clamping
    // makes the browser snap into our range instead.
    const weights = measured.find((m) => m.family === family).weights.map((w) => w.weight);
    const range = weights.length > 1 ? `${weights[0]} ${weights[weights.length - 1]}` : `${weights[0]}`;
    const url = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    const sheet = await res.text();

    // Google emits `/* subset */` immediately before each @font-face block.
    const blocks = [...sheet.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
    if (!blocks.length) throw new Error(`no @font-face blocks parsed from ${url}`);

    for (const subset of KEEP_SUBSETS) {
      const block = blocks.find(([, name]) => name === subset);
      if (!block) continue;                          // family has no such subset
      const body = block[2];
      const pick = (prop) => (body.match(new RegExp(`${prop}:\\s*([^;]+);`)) ?? [])[1]?.trim();
      const style = pick('font-style');
      if (style !== 'normal') continue;              // upright only, deliberately
      const href = (body.match(/src:\s*url\(([^)]+)\)/) ?? [])[1];
      if (!href) throw new Error(`no src url in the ${subset} face of ${family}`);

      const woff2 = await fetch(href, { headers: { 'User-Agent': BROWSER_UA } });
      if (!woff2.ok) throw new Error(`GET ${href} -> ${woff2.status}`);
      const bytes = Buffer.from(await woff2.arrayBuffer());
      const name = `${slug(family)}-${subset}.woff2`;
      writeFileSync(join(FONT_OUT, name), bytes);
      files.push({ family, subset, name, bytes: bytes.length });

      css.push(
        '@font-face {',
        `  font-family: '${family}';`,
        '  font-style: normal;',
        `  font-weight: ${range};`,
        '  font-display: swap;',
        `  src: url('/fonts/${name}') format('woff2');`,
        `  unicode-range: ${pick('unicode-range')};`,
        '}',
      );
    }
  }
  return { css: css.join('\n'), files };
}

async function main() {
  const fontkit = await import(join(ROOT, 'node_modules', 'fontkit', 'dist', 'module.mjs'))
    .catch(() => { throw new Error('fontkit is missing. Run: npm i -D --no-save fontkit'); });

  const families = [];

  for (const { family, file } of FAMILIES) {
    const font = fontkit.create(await load(file));
    const upm = font.unitsPerEm;
    const axis = font.variationAxes?.wght;

    // Which of the used weights this family can actually supply. A static font
    // supplies exactly one; a variable font supplies its wght axis range.
    const weights = axis
      ? USED_WEIGHTS.filter((w) => w >= axis.min && w <= axis.max)
      : [font['OS/2']?.usWeightClass ?? 400];

    const perWeight = [];
    for (const weight of weights) {
      const inst = axis ? font.getVariation({ wght: weight }) : font;
      const advances = [];
      for (const cp of CODEPOINTS) {
        if (!inst.hasGlyphForCodePoint(cp)) continue;  // let the mean cover it
        advances.push([cp, inst.glyphForCodePoint(cp).advanceWidth / upm]);
      }
      const mean = advances.reduce((s, [, a]) => s + a, 0) / advances.length;
      perWeight.push({ weight, mean, advances });
    }

    families.push({
      family,
      upm,
      ascender: font.ascent / upm,
      descender: font.descent / upm,
      lineGap: font.lineGap / upm,
      // Family-level mean of the per-weight means: the last-resort width when
      // even the weight table cannot be picked.
      mean: perWeight.reduce((s, w) => s + w.mean, 0) / perWeight.length,
      weights: perWeight,
    });
  }

  writeFileSync(OUT, emit(families));

  const total = families.reduce((s, f) => s + f.weights.reduce((t, w) => t + w.advances.length, 0), 0);
  const kb = (Buffer.byteLength(readFileSync(OUT, 'utf8')) / 1024).toFixed(1);
  console.log(`wrote ${OUT}`);
  console.log(`${families.length} families, ${families.reduce((s, f) => s + f.weights.length, 0)} family+weight tables, ${total} advances, ${kb} KB`);
  for (const f of families) console.log(`  ${f.family.padEnd(18)} upm=${f.upm} weights=[${f.weights.map((w) => w.weight).join(', ')}]`);

  const { css, files } = await bundleWebFonts(families);
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  console.log(`\nwrote ${files.length} woff2 faces to ${FONT_OUT} (${(bytes / 1024).toFixed(1)} KB total)`);
  for (const f of files) console.log(`  ${f.name.padEnd(34)} ${(f.bytes / 1024).toFixed(1).padStart(6)} KB`);
  console.log('\n' + '='.repeat(72));
  console.log('@font-face block — append verbatim to the END of apps/studio/src/styles.css');
  console.log('(between the ARTBOARD FONTS markers; see docs/FONT-METRICS.md)');
  console.log('='.repeat(72));
  console.log(css);
}

function emit(families) {
  const L = [];
  L.push('/* eslint-disable */');
  L.push('/**');
  L.push(' * GENERATED FILE — DO NOT EDIT BY HAND.');
  L.push(' *');
  L.push(' * Regenerate with `npm run metrics` (see tools/gen-font-metrics.mjs and');
  L.push(' * docs/FONT-METRICS.md). Real per-glyph advance widths measured from the');
  L.push(` * Google Fonts binaries at google/fonts@${FONTS_REF.slice(0, 12)}, normalised to a`);
  L.push(' * fraction of the em so they are font-size independent.');
  L.push(' *');
  L.push(' * Committed on purpose: @artboard/engine has zero runtime dependencies and');
  L.push(' * never reads a file or the network, so the numbers have to live in source.');
  L.push(' */');
  L.push('');
  L.push('/** Advance width of one codepoint, as a fraction of the em. */');
  L.push('export type AdvanceTable = Readonly<Record<string, number>>;');
  L.push('');
  L.push('export interface WeightMetrics {');
  L.push('  /** Mean advance over every sampled codepoint — used for anything not in `advances`. */');
  L.push('  readonly fallbackWidth: number;');
  L.push('  readonly advances: AdvanceTable;');
  L.push('}');
  L.push('');
  L.push('export interface FamilyMetrics {');
  L.push('  /** unitsPerEm of the source binary. Provenance only; every number below is already divided by it. */');
  L.push('  readonly unitsPerEm: number;');
  L.push('  /** hhea ascender / descender / lineGap, as a fraction of the em. `descender` is negative. */');
  L.push('  readonly ascender: number;');
  L.push('  readonly descender: number;');
  L.push('  readonly lineGap: number;');
  L.push('  /** Natural line height (ascender - descender + lineGap), as a multiple of the font size. */');
  L.push('  readonly naturalLineHeight: number;');
  L.push('  /** Mean of the per-weight means. Last resort when no weight table can be chosen. */');
  L.push('  readonly fallbackWidth: number;');
  L.push('  /** Only the weights this family can actually supply, ascending. */');
  L.push('  readonly weights: Readonly<Record<number, WeightMetrics>>;');
  L.push('}');
  L.push('');
  L.push('/** The weights the product uses. A family only lists the ones it can supply. */');
  L.push(`export const SAMPLED_WEIGHTS: readonly number[] = [${USED_WEIGHTS.join(', ')}];`);
  L.push('');
  L.push('export const FONT_METRICS: Readonly<Record<string, FamilyMetrics>> = {');
  for (const f of families) {
    const natural = f.ascender - f.descender + f.lineGap;
    L.push(`  ${JSON.stringify(f.family)}: {`);
    L.push(`    unitsPerEm: ${f.upm},`);
    L.push(`    ascender: ${fx(f.ascender)},`);
    L.push(`    descender: ${fx(f.descender)},`);
    L.push(`    lineGap: ${fx(f.lineGap)},`);
    L.push(`    naturalLineHeight: ${fx(natural)},`);
    L.push(`    fallbackWidth: ${fx(f.mean)},`);
    L.push('    weights: {');
    for (const w of f.weights) {
      L.push(`      ${w.weight}: {`);
      L.push(`        fallbackWidth: ${fx(w.mean)},`);
      L.push('        advances: {');
      // Wrapped at a fixed column so the diff of a regeneration stays readable.
      let line = '';
      for (const [cp, adv] of w.advances) {
        const entry = `${keyLiteral(cp)}:${fx(adv)},`;
        if (line.length + entry.length > 96) { L.push(`          ${line}`); line = ''; }
        line += entry;
      }
      if (line) L.push(`          ${line}`);
      L.push('        },');
      L.push('      },');
    }
    L.push('    },');
    L.push('  },');
  }
  L.push('};');
  L.push('');
  L.push('/** The family every unknown family falls back to. */');
  L.push("export const DEFAULT_FAMILY = 'Inter';");
  L.push('');
  return L.join('\n');
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
