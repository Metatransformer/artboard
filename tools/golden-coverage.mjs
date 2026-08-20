#!/usr/bin/env node
/**
 * Answers the one question the golden oracle cannot answer about itself:
 * **what does it never look at?**
 *
 *   node tools/golden-coverage.mjs
 *
 * `artboard golden` proves that what the renderer draws today matches what it
 * drew yesterday — but only along the paths some fixture actually walks. A
 * feature with no fixture behind it is not "passing", it is unobserved, and a
 * green oracle reads downstream as "checked". Three separate regressions this
 * project shipped were hiding in exactly that gap.
 *
 * ── how the checklist is built ────────────────────────────────────────────
 * DERIVED FROM THE SCHEMA, not hand-listed. Every node schema in `Node` is
 * introspected and each field turned into the render paths it can select:
 * an enum becomes one dimension per option, a boolean one dimension, a
 * nullable/optional one "is it set". Add `z.enum(['a','b'])` to the schema and
 * both values appear here on the next run with nobody remembering to add them.
 *
 * The only hand-maintained list is IGNORED below — an *exclusion* list, which
 * is the safe polarity: forgetting to exclude something shows up as noise in
 * the report, where forgetting to include something would show up as nothing
 * at all. Anything this script cannot classify is reported as UNCLASSIFIED
 * rather than silently dropped, so a field of a novel shape is loud.
 *
 * This is a report, not a gate: it always exits 0. Uncovered paths are a
 * prompt to judge whether a fixture is worth it, and often it is not — seven
 * blend modes down one `mix-blend-mode` emission buy nothing that the first
 * one did not already buy.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'golden');

/**
 * Fields that carry content rather than select a render path. Their value
 * changes what you see but not which branch of the renderer runs, so "is it
 * set" says nothing about coverage.
 */
const IGNORED = new Set([
  'id', 'name', 'kind', 'text', 'd', 'assetId', 'raw', 'originalKind', 'children',
  'x', 'y', 'width', 'height', 'color', 'fontFamily', 'fontSize', 'fontWeight',
  'viewBox', 'frameD', 'frameBox', 'stops', 'angle', 'cx', 'cy', 'r', 'offset',
  'locked', 'lineHeight',
]);

/* ── schema introspection ─────────────────────────────────────────────────── */

const { register } = await import('tsx/esm/api');
register();
const S = await import('@artboard/schema');

const tn = (s) => s?._def?.typeName;
const unwrapLazy = (s) => (tn(s) === 'ZodLazy' ? s._def.getter() : s);

/** Every dimension the schema can express, as `label -> probe(value, node)`. */
const dims = new Map();
const unclassified = [];
const add = (label, probe) => { if (!dims.has(label)) dims.set(label, probe); };

/** Turn one schema field into zero or more coverage dimensions. */
function classify(prefix, key, schema) {
  if (IGNORED.has(key)) return;
  const t = tn(schema);

  if (t === 'ZodDefault') {
    const inner = schema._def.innerType;
    const it = tn(inner);
    const dflt = schema._def.defaultValue();
    if (it === 'ZodEnum') {
      for (const opt of inner.options) add(`${prefix}.${key}=${opt}`, (v) => (v ?? dflt) === opt);
      return;
    }
    if (it === 'ZodBoolean') { add(`${prefix}.${key}`, (v) => v === true); return; }
    if (it === 'ZodNumber')  { add(`${prefix}.${key}≠${dflt}`, (v) => v !== undefined && v !== dflt); return; }
    if (it === 'ZodArray')   { add(`${prefix}.${key} non-empty`, (v) => Array.isArray(v) && v.length > 0); return; }
    if (it === 'ZodString')  { add(`${prefix}.${key} non-empty`, (v) => typeof v === 'string' && v !== ''); return; }
    if (it === 'ZodNullable'){ add(`${prefix}.${key} set`, (v) => v !== undefined && v !== null); return; }
    if (it === 'ZodObject')  { descend(`${prefix}.${key}`, inner); return; }
    unclassified.push(`${prefix}.${key} (ZodDefault<${it}>)`);
    return;
  }
  if (t === 'ZodOptional') { add(`${prefix}.${key} set`, (v) => v !== undefined && v !== null); return; }
  if (t === 'ZodDiscriminatedUnion') { descendUnion(`${prefix}.${key}`, schema); return; }
  if (t === 'ZodObject') { descend(`${prefix}.${key}`, schema); return; }
  if (t === 'ZodArray') {
    // effects[] — the element union's members are the real dimensions
    const el = unwrapLazy(schema._def.type);
    if (tn(el) === 'ZodDiscriminatedUnion') {
      for (const opt of el.options) {
        const k = opt.shape.kind._def.value;
        add(`${prefix}.${key}:${k}`, (v) => Array.isArray(v) && v.some((e) => e?.kind === k));
      }
      return;
    }
    unclassified.push(`${prefix}.${key} (ZodArray)`);
    return;
  }
  if (t === 'ZodString' || t === 'ZodNumber') return;   // required content field
  unclassified.push(`${prefix}.${key} (${t})`);
}

function descend(prefix, obj) {
  for (const [k, v] of Object.entries(obj.shape)) classify(prefix, k, v);
}

/** A `Fill`-shaped union: each member kind is a dimension, plus its own fields. */
function descendUnion(prefix, union) {
  for (const opt of union.options) {
    const k = opt.shape.kind._def.value;
    add(`${prefix}:${k}`, (v) => v?.kind === k);
    for (const [fk, fv] of Object.entries(opt.shape)) {
      if (IGNORED.has(fk) || fk === 'kind') continue;
      const inner = tn(fv) === 'ZodDefault' ? fv._def.innerType : fv;
      if (tn(inner) === 'ZodEnum') {
        const dflt = tn(fv) === 'ZodDefault' ? fv._def.defaultValue() : undefined;
        for (const o of inner.options) add(`${prefix}:${k}.${fk}=${o}`, (v) => v?.kind === k && (v[fk] ?? dflt) === o);
      }
    }
  }
}

const nodeSchemas = new Map();
for (const opt of unwrapLazy(S.Node).options) {
  const kind = opt.shape.kind._def.value;
  nodeSchemas.set(kind, opt);
  add(`kind:${kind}`, () => false);          // probed against the node itself, below
  descend(kind, opt);
}
descendUnion('artboard.background', S.Fill);

/* ── walk the fixtures ────────────────────────────────────────────────────── */

const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const seen = new Map();                       // label -> Set(fixture)
const mark = (label, f) => { if (!seen.has(label)) seen.set(label, new Set()); seen.get(label).add(f); };

function visit(node, file) {
  if (!node || typeof node !== 'object') return;
  mark(`kind:${node.kind}`, file);
  for (const [label, probe] of dims) {
    if (!label.startsWith(`${node.kind}.`)) continue;
    const path = label.slice(node.kind.length + 1).split(/[.=:≠]/)[0];
    let value = node[path];
    // one level of nesting: `rect.stroke.cap=round` reads node.stroke.cap
    const rest = label.slice(node.kind.length + 1);
    if (rest.includes('.')) {
      const [outer, innerKey] = rest.split('.');
      const leaf = innerKey.split(/[=≠ ]/)[0];
      value = node[outer]?.[leaf];
    }
    if (probe(value, node)) mark(label, file);
  }
  for (const child of node.children ?? []) visit(child, file);
}

for (const f of files) {
  const doc = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
  for (const ab of doc.artboards ?? []) {
    for (const [label, probe] of dims) {
      if (label.startsWith('artboard.background') && probe(ab.background ?? { kind: 'solid' })) mark(label, f);
    }
    for (const n of ab.nodes ?? []) visit(n, f);
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */

const labels = [...dims.keys()].sort();
const missing = labels.filter((l) => !seen.has(l));
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

console.log(`golden coverage  ${files.length} fixtures  ${labels.length - missing.length}/${labels.length} render paths exercised\n`);

if (missing.length) {
  console.log('NOT EXERCISED BY ANY FIXTURE');
  let group = '';
  for (const m of missing) {
    const g = m.split(/[.:]/)[0];
    if (g !== group) { group = g; console.log(`  ${group}`); }
    console.log(`    ${m}`);
  }
} else console.log('every derived render path has at least one fixture behind it.');

if (unclassified.length) {
  console.log('\nUNCLASSIFIED — this script does not know how to probe these, so they are');
  console.log('counted as neither covered nor missing. Teach it, or add them to IGNORED:');
  for (const u of unclassified) console.log(`    ${u}`);
}

console.log(`\n${pad('thinnest coverage', 20)} (paths riding on a single fixture)`);
const thin = labels.filter((l) => seen.get(l)?.size === 1).slice(0, 12);
for (const t of thin) console.log(`    ${pad(t, 34)} ${[...seen.get(t)][0]}`);
