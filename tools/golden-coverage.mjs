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
import { readdirSync, readFileSync } from 'node:fs';
// This report gets piped to `head` and `grep` constantly; a closed stdout is
// the reader having seen enough, not an error worth a stack trace.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const visit = (n, f) => { record(n, f, false); for (const c of n.children ?? []) visit(c, f); };
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
  for (const ab of doc.artboards ?? []) { record(ab, f, true); for (const n of ab.nodes ?? []) visit(n, f); }
}

/* -- report ---------------------------------------------------------------- */
const hits = (d) => new Set([...d.seen].map((s) => s.slice(0, s.lastIndexOf(' '))));
let total = 0, covered = 0;
const gaps = [];
for (const [label, d] of [...dims].sort(([a], [b]) => a.localeCompare(b))) {
  if (d.values) {
    const hit = hits(d);
    total += d.values.size;
    covered += [...d.values].filter((v) => hit.has(v)).length;
    const miss = [...d.values].filter((v) => !hit.has(v));
    if (miss.length) gaps.push([label, miss.join(', '), miss.length === d.values.size]);
  } else {
    total += 1;
    if (d.seen.size) covered += 1;
    else gaps.push([label, '(never set)', true]);
  }
}

console.log(`golden coverage  ${files.length} fixtures  ${covered}/${total} render paths exercised\n`);
if (!gaps.length) console.log('every schema-expressible render path has a fixture behind it.');
else {
  console.log('NOT EXERCISED BY ANY FIXTURE   (* = nothing in this dimension at all)');
  const w = Math.max(...gaps.map(([l]) => l.length));
  for (const [label, miss, whole] of gaps) console.log(`  ${whole ? '*' : ' '} ${label.padEnd(w)}  ${miss}`);
}
if (unclassified.length) {
  console.log('\nUNCLASSIFIED -- not probed, so counted as neither covered nor missing.');
  console.log('Teach this script the shape, or add the field to IGNORED:');
  for (const u of unclassified) console.log(`    ${u}`);
}
const thin = [...dims].filter(([, d]) => !d.values && d.seen.size === 1);
if (thin.length) {
  console.log('\nRIDING ON A SINGLE FIXTURE  (delete it and the path goes unobserved)');
  for (const [label, d] of thin) console.log(`    ${label.padEnd(22)} ${[...d.seen][0].trim()}`);
}
