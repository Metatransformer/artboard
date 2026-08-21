#!/usr/bin/env node
/**
 * Answers the one question the golden oracle cannot answer about itself:
 * **what does it never look at?**
 *
 *   node tools/golden-coverage.mjs
 *
 * `artboard golden` proves that what the renderer draws today matches what it
 * drew yesterday -- but only along the paths some fixture actually walks. A
 * feature with no fixture behind it is not "passing", it is unobserved, and a
 * green oracle reads downstream as "checked". Several regressions this project
 * shipped were hiding in exactly that gap: grouping, image fit modes, and the
 * first cut of markers/flips/gradients all had unit proof and no rendered proof.
 *
 * -- how the checklist is built --------------------------------------------
 * DERIVED FROM THE SCHEMA, never hand-listed. Every node schema in `Node` is
 * introspected and each field becomes the render paths it can select: an enum
 * contributes its options, a boolean contributes itself, a nullable or optional
 * contributes "is it set". Add a field to the schema and it appears here on the
 * next run with nobody having remembered to add it.
 *
 * Dimensions are keyed on the FIELD, not on node-kind x field, because that is
 * how the renderer is built -- `blend`, `rotation`, `flipX` and friends live on
 * `NodeBase` and are emitted by one shared code path for every kind. Keying on
 * the pair would report `ellipse.blend=hue` and 200 siblings: true, useless,
 * and the fastest way to make a report nobody reads.
 *
 * The only hand-maintained list is IGNORED -- an *exclusion* list, the safe
 * polarity: forgetting to exclude shows up as noise, where forgetting to
 * include would show up as nothing at all. Anything unrecognised is reported as
 * UNCLASSIFIED rather than dropped, so a field of a novel shape is loud.
 *
 * -- what it cannot tell you ------------------------------------------------
 * Coverage here means "a fixture sets this", not "the renderer branched on it".
 * The schema lets you put `markerStart` on an ellipse; the renderer only draws
 * markers for `line` and `path`. So a dimension can read covered from a node
 * that never renders it. It over-claims rather than under-claims, and only for
 * combinations nobody writes.
 *
 * A report, not a gate: always exits 0. An uncovered path is a prompt to judge
 * whether a fixture earns its place, and often it does not -- seven blend modes
 * down one shared `mix-blend-mode` emission buy nothing the first one did not.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// This report gets piped to `head` and `grep` constantly; a closed stdout is
// the reader having seen enough, not an error worth a stack trace.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');
/** `--dir <path>` mirrors `artboard golden --dir`, and makes this script's own
 *  claims testable: drop a fixture, re-run, and the paths it uniquely carried
 *  must flip to missing. */
const dirArg = process.argv.indexOf('--dir');
const FIXTURES = dirArg > -1 && process.argv[dirArg + 1]
  ? process.argv[dirArg + 1]
  : join(ROOT, 'tests', 'golden');

/**
 * Fields carrying content rather than selecting a render path: their value
 * changes what you see, not which branch runs. Geometry lives here too -- every
 * fixture sets x/y/width/height, so "is it set" says nothing about coverage.
 */
const IGNORED = new Set([
  'id', 'name', 'kind', 'text', 'd', 'assetId', 'raw', 'originalKind', 'children',
  'x', 'y', 'width', 'height', 'color', 'fontFamily', 'fontSize', 'fontWeight',
  'viewBox', 'frameD', 'frameBox', 'stops', 'offset', 'locked', 'lineHeight',
  'angle', 'cx', 'cy', 'r',
]);

/* -- schema introspection -------------------------------------------------- */
const { register } = await import('tsx/esm/api');
register();
const S = await import('@artboard/schema');

const tn = (s) => s?._def?.typeName;
const unlazy = (s) => (tn(s) === 'ZodLazy' ? s._def.getter() : s);

/** label -> { read, values: Set|null, seen: Set<"value file"> }. */
const dims = new Map();
const unclassified = [];
const dim = (label, read, values = null) => {
  if (!dims.has(label)) dims.set(label, { read, values: values && new Set(values), seen: new Set() });
};

/** Dotted path to a reader, so `stroke.cap` reads node.stroke.cap. */
const reader = (path) => (n) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), n);

function classify(path, key, schema) {
  if (IGNORED.has(key)) return;
  const full = path ? `${path}.${key}` : key;
  const read = reader(full);
  const t = tn(schema);

  if (t === 'ZodDefault') {
    const inner = schema._def.innerType, it = tn(inner), dflt = schema._def.defaultValue();
    if (it === 'ZodEnum')      return dim(full, (n) => read(n) ?? dflt, inner.options);
    // The interesting side of a boolean is whichever one is NOT the default:
    // `flipX` matters when true, `visible` matters when false.
    if (it === 'ZodBoolean')   return dim(`${full} = ${!dflt}`, (n) => read(n) === !dflt);
    if (it === 'ZodNumber')    return dim(`${full} != ${dflt}`, (n) => read(n) !== undefined && read(n) !== dflt);
    if (it === 'ZodArray')     return dim(`${full} non-empty`, (n) => (read(n)?.length ?? 0) > 0);
    if (it === 'ZodString')    return dim(`${full} non-empty`, (n) => !!read(n));
    if (it === 'ZodNullable')  return dim(`${full} set`, (n) => read(n) != null);
    if (it === 'ZodObject')    return descend(full, inner);
    // A defaulted union (every shape's `fill`) still selects a paint branch.
    if (it === 'ZodDiscriminatedUnion') return union(full, inner, (n) => read(n) ?? dflt);
    return void unclassified.push(`${full} (ZodDefault<${it}>)`);
  }
  if (t === 'ZodOptional')           return dim(`${full} set`, (n) => read(n) != null);
  if (t === 'ZodObject')             return descend(full, schema);
  if (t === 'ZodDiscriminatedUnion') return union(full, schema, read);
  if (t === 'ZodArray') {
    const el = unlazy(schema._def.type);
    if (tn(el) === 'ZodDiscriminatedUnion') {
      const kinds = el.options.map((o) => o.shape.kind._def.value);
      return dim(full, (n) => (read(n) ?? []).map((e) => e?.kind), kinds);
    }
    return void unclassified.push(`${full} (ZodArray)`);
  }
  if (t === 'ZodString' || t === 'ZodNumber') return;   // required content field
  unclassified.push(`${full} (${t})`);
}

const descend = (path, obj) => { for (const [k, v] of Object.entries(obj.shape)) classify(path, k, v); };

/** A `Fill`-shaped union: member kinds are the values; recurse for inner enums. */
function union(path, schema, read) {
  dim(path, (n) => read(n)?.kind, schema.options.map((o) => o.shape.kind._def.value));
  for (const opt of schema.options) {
    const k = opt.shape.kind._def.value;
    for (const [fk, fv] of Object.entries(opt.shape)) {
      if (IGNORED.has(fk) || fk === 'kind' || tn(fv) !== 'ZodDefault') continue;
      const inner = fv._def.innerType;
      if (tn(inner) !== 'ZodEnum') continue;
      const dflt = fv._def.defaultValue();
      dim(`${path}:${k}.${fk}`, (n) => (read(n)?.kind === k ? read(n)[fk] ?? dflt : undefined), inner.options);
    }
  }
}

dim('node kind', (n) => n.kind, unlazy(S.Node).options.map((o) => o.shape.kind._def.value));
for (const opt of unlazy(S.Node).options) descend('', opt);
union('artboard background', S.Fill, (ab) => ab.background ?? { kind: 'solid' });

/* -- walk the fixtures ----------------------------------------------------- */
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const isBg = (label) => label.startsWith('artboard background');

function record(subject, file, backgrounds) {
  for (const [label, d] of dims) {
    if (isBg(label) !== backgrounds) continue;
    let v;
    try { v = d.read(subject); } catch { continue; }
    if (v === undefined || v === null || v === false) continue;
    if (d.values) for (const x of Array.isArray(v) ? v : [v]) { if (d.values.has(x)) d.seen.add(`${x} ${file}`); }
    else if (v === true) d.seen.add(` ${file}`);
  }
}

// Which fixtures contain each node KIND.
//
// Tracked separately from `dims` because kind is not a field on a node the way
// `blend` or `rotation` is -- it selects which renderNode arm runs, so a kind
// with thin fixture backing means a whole rendering branch is thinly watched.
// Nothing here reported that at all: `group` was absent from every section of
// this report while group rendering rode on one fixture and a rotation-pivot
// bug sat inside it.
const kinds = new Map();
const visit = (n, f) => {
  if (n.kind) { if (!kinds.has(n.kind)) kinds.set(n.kind, new Set()); kinds.get(n.kind).add(f); }
  record(n, f, false);
  for (const c of n.children ?? []) visit(c, f);
};
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
  for (const ab of doc.artboards ?? []) { record(ab, f, true); for (const n of ab.nodes ?? []) visit(n, f); }
}

/* -- report ---------------------------------------------------------------- */
const hits = (d) => new Set([...d.seen].map((s) => s.slice(0, s.lastIndexOf(' '))));
let total = 0, covered = 0;
// Dimensions counted separately from enum VALUES, because they are not the
// same unit and reporting one number conflated them. `blend` has 16 values and
// one line of code behind them all -- `mix-blend-mode:${n.blend}`, read nowhere
// else -- so counting it as 16 made it 14 of the 21 "unexercised paths" and
// weighted a string interpolation above `group`, which is a whole renderNode
// arm and counted as one. A reader following that list writes 14 blend
// fixtures to prove an interpolation.
let dimTotal = 0, dimCovered = 0;
const gaps = [];
for (const [label, d] of [...dims].sort(([a], [b]) => a.localeCompare(b))) {
  if (d.values) {
    const hit = hits(d);
    total += d.values.size;
    covered += [...d.values].filter((v) => hit.has(v)).length;
    dimTotal += 1;
    if (hit.size) dimCovered += 1;
    const miss = [...d.values].filter((v) => !hit.has(v));
    if (miss.length) gaps.push([label, miss.join(', '), miss.length === d.values.size]);
  } else {
    total += 1;
    dimTotal += 1;
    if (d.seen.size) { covered += 1; dimCovered += 1; }
    else gaps.push([label, '(never set)', true]);
  }
}

console.log(`golden coverage  ${files.length} fixtures  ${dimCovered}/${dimTotal} dimensions, ${covered}/${total} schema values reached by a fixture\n`);
if (!gaps.length) console.log('every schema-expressible render path has a fixture behind it.');
else {
  console.log('NOT EXERCISED BY ANY FIXTURE   (* = nothing in this dimension at all)');
  console.log('This is the GOLDEN oracle\'s reach, not a to-do list. A value here is');
  console.log('unproven only if nothing ELSE covers it -- unit tests often do, and enum');
  console.log('values sharing one code path are one path however many are listed.');
  const w = Math.max(...gaps.map(([l]) => l.length));
  for (const [label, miss, whole] of gaps) console.log(`  ${whole ? '*' : ' '} ${label.padEnd(w)}  ${miss}`);
}
if (unclassified.length) {
  console.log('\nUNCLASSIFIED -- not probed, so counted as neither covered nor missing.');
  console.log('Teach this script the shape, or add the field to IGNORED:');
  for (const u of unclassified) console.log(`    ${u}`);
}
// Threshold 2, not 1, and the COUNT is printed rather than implied.
//
// This read `=== 1` and said nothing about a dimension with two fixtures
// behind it. `group` was exactly that: one fixture until insert-data landed,
// two after -- and a rotation-pivot bug sat inside that one fixture the whole
// time, reported as plain "covered". A binary check cannot tell two from
// twenty, so the number is the finding and hiding it behind a threshold is
// what let "covered" read as "safe".
console.log('\nFIXTURES PER NODE KIND  (each kind is its own renderNode arm)');
{
  const w = Math.max(...[...kinds.keys()].map((k) => k.length));
  for (const [k, set] of [...kinds].sort((a, b) => a[1].size - b[1].size || a[0].localeCompare(b[0]))) {
    // Names only where the count is actionable. Listing all 28 fixtures for
    // `text` buries the two lines that matter under three lines that do not.
    const thinEnough = set.size <= 2;
    console.log(`  ${thinEnough ? '!' : ' '} ${k.padEnd(w)}  ${String(set.size).padStart(2)}${thinEnough ? '  ' + [...set].join(', ') : ''}`);
  }
}

const thin = [...dims].filter(([, d]) => !d.values && d.seen.size >= 1 && d.seen.size <= 2)
  .sort((a, b) => a[1].seen.size - b[1].seen.size);
if (thin.length) {
  // Wording matters here. A "1 fixture" row is not a weak fixture -- it is
  // usually a strong one standing alone, and the risk is structural, not a
  // quality judgement on the file named. Say LOAD-BEARING, so nobody reads
  // this as "that fixture is thin" and goes looking for something to improve
  // in it. The thing to improve is the count.
  console.log('\nLOAD-BEARING  (so few fixtures that deleting one silently drops the dimension)');
  console.log('Not a criticism of the fixture named -- it is the only thing holding');
  console.log('that path up. A second fixture is the fix; editing this one is not.');
  for (const [label, d] of thin) {
    const n = d.seen.size;
    console.log(`  ${n === 1 ? '!' : ' '} ${label.padEnd(22)} ${String(n).padStart(2)} fixture${n === 1 ? ' ' : 's'}  ${[...d.seen].map(f => f.trim()).join(', ')}`);
  }
}

/* -- DIAGNOSTIC CODES ------------------------------------------------------
 *
 * Everything above this line reports on a dimension space read out of the
 * schema -- which is to say, on things that end up in the SVG. A diagnostic
 * does not. It is a second output of the same render, it has never been in a
 * baseline, and so no re-bake could ever notice one going missing. That is not
 * a dimension counted wrongly; it is a dimension the oracle could not
 * represent, which is a strictly worse failure because it is invisible.
 *
 * The `.diag` sidecars fixed the holding half. This fixes the reporting half:
 * which codes the corpus actually provokes, and which exist only in source.
 *
 * The scan is deliberately dumb -- a regex over `code:` in package sources --
 * and deliberately loud about its own blind spot. `CONTRAST_${opts.level}` is
 * a template literal that no literal-matching scanner can resolve, and the
 * honest move is to print it as unresolved rather than quietly omit it and
 * report a smaller, cleaner, wrong number. Same polarity as UNCLASSIFIED
 * above: unrecognised is reported, never dropped.
 * ---------------------------------------------------------------------- */
{
  const srcFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) srcFiles.push(full);
    }
  };
  for (const pkg of readdirSync(PKGS, { withFileTypes: true })) {
    const src = join(PKGS, pkg.name, 'src');
    if (pkg.isDirectory() && existsSync(src)) walk(src);
  }

  const declared = new Map();   // CODE -> Set<file>
  const unresolved = [];        // expressions this scanner cannot read
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bcode:\s*(?:'([A-Z0-9_]+)'|"([A-Z0-9_]+)"|(`[^`]*`))/g)) {
      const lit = m[1] ?? m[2];
      if (lit) {
        if (!declared.has(lit)) declared.set(lit, new Set());
        declared.get(lit).add(relative(ROOT, file));
      } else {
        unresolved.push(`${relative(ROOT, file)}  code: ${m[3]}`);
      }
    }
  }

  const emitted = new Map();    // CODE -> Set<fixture>
  for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith('.diag'))) {
    for (const line of readFileSync(join(FIXTURES, f), 'utf8').split('\n')) {
      const code = line.split(' ')[1];
      if (!code) continue;
      if (!emitted.has(code)) emitted.set(code, new Set());
      emitted.get(code).add(f.replace(/\.diag$/, ''));
    }
  }

  const all = [...new Set([...declared.keys(), ...emitted.keys()])].sort();
  const w = Math.max(...all.map((c) => c.length), 20);
  console.log(`\nDIAGNOSTIC CODES  ${[...emitted.keys()].length}/${all.length} provoked by some fixture`);
  console.log('Fixture reach, NOT a to-do list -- same reading as the section above. A');
  console.log('code here with no fixture is usually asserted by a unit test: six of the');
  console.log('seven renderer/schema/engine codes were, when this was measured. What a');
  console.log('fixture adds over a unit test is that a diagnostic vanishing from a real');
  console.log('document is caught by whoever runs `golden`, not by whoever remembers to');
  console.log('read render.test.ts. Worth having for one or two codes, not for all of');
  console.log('them. Check what else covers a line before writing a fixture for it.');
  for (const code of all) {
    const fx = emitted.get(code);
    const inSrc = declared.has(code);
    // Two different absences, and conflating them would hide the interesting
    // one. No source + emitted = built by a template literal (see above), not
    // a mystery. No fixture = a genuinely unobserved message.
    const mark = !fx ? '!' : !inSrc ? '~' : ' ';
    const detail = !fx
      ? '(no fixture provokes it)'
      : `${String(fx.size).padStart(2)} fixture${fx.size === 1 ? ' ' : 's'}${inSrc ? '' : '   built at runtime -- no literal in source'}`;
    console.log(`  ${mark} ${code.padEnd(w)}  ${detail}`);
  }
  if (unresolved.length) {
    console.log('\n  code: expressions this scanner cannot resolve (so the count above is a');
    console.log('  floor, not a total). Every one should show up as a ~ row if a fixture');
    console.log('  reaches it; a ~ row with no entry here is the surprising case:');
    for (const u of [...new Set(unresolved)]) console.log(`      ${u}`);
  }
}
