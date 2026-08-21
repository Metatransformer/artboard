/**
 * artboard -- the Artboard command line.
 *
 *   artboard validate <file.json>
 *   artboard render   <file.json> [--out out.svg] [--artboard N]
 *   artboard export   <file.json> [--format svg|pdf|json] [--scale N] [--pages 1-3]
 *                                 [--transparent] [--zip] [--out path]
 *   artboard golden   [--update] [--dir tests/golden]
 *   artboard info     <file.json>
 *
 * `golden` is the oracle the autonomous build loop gates on: it re-renders
 * every fixture in tests/golden and diffs the SVG against a committed
 * baseline. Exit 0 means the renderer still draws what it drew before.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument, walk, type Diagnostic } from '@artboard/schema';
import { renderToString } from '@artboard/render-svg';
import { checkDocument } from '@artboard/diagnostics';

import {
  buildVectorExport, fileStem, HEADLESS_FORMATS, isFormat, parsePages,
  PageRangeError, type ExportFormat,
} from './format/options.js';
import { zipStore } from './format/zip.js';
import { DataError, fillTemplate, findPlaceholders, nameRows, parseData } from './bulk/data.js';

import {
  bold, cyan, describeError, dim, formatDiagnostic, green, hasErrors,
  pad, red, summarizeDiagnostics, yellow,
} from './term.js';

const OK = 0;
const FAILED = 1;
const USAGE = 2;

const HERE = dirname(fileURLToPath(import.meta.url));

/* -- errors (named, always) ---------------------------------------------- */
export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}
export class FileNotFoundError extends Error {
  constructor(public path: string) { super(`No such file: ${path}`); this.name = 'FileNotFoundError'; }
}
export class NoFixturesError extends Error {
  constructor(public dir: string) { super(`No *.json fixtures in ${dir} -- an oracle with nothing to check proves nothing.`); this.name = 'NoFixturesError'; }
}
export class ArtboardRangeError extends Error {
  constructor(public index: number, public count: number) { super(`Artboard ${index} does not exist (document has ${count}).`); this.name = 'ArtboardRangeError'; }
}

/* -- argv ----------------------------------------------------------------- */
const VALUE_FLAGS = new Set(['out', 'artboard', 'dir', 'format', 'scale', 'pages', 'quality', 'data', 'name', 'limit', 'delimiter', 'level']);

interface Argv { command: string; positionals: string[]; flags: Record<string, string | boolean> }

export function parseArgv(argv: readonly string[]): Argv {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key)) {
        if (next === undefined || next.startsWith('-')) throw new UsageError(`--${key} needs a value`);
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) { flags[arg.slice(1)] = true; continue; }
    positionals.push(arg);
  }

  const [command = '', ...rest] = positionals;
  return { command, positionals: rest, flags };
}

/* -- helpers -------------------------------------------------------------- */
function repoRoot(): string {
  let dir = HERE;
  for (let hop = 0; hop < 10; hop++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const parsed = readJson(manifest) as { name?: string; workspaces?: unknown } | null;
      if (parsed && (parsed.name === 'artboard' || parsed.workspaces !== undefined)) return dir;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    process.stderr.write(`${yellow('warn')} could not read ${path} -- ${describeError(e)}\n`);
    return null;
  }
}

function readSource(file: string): { path: string; raw: string } {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new FileNotFoundError(path);
  return { path, raw: readFileSync(path, 'utf8') };
}

function openDocument(file: string) {
  const { path, raw } = readSource(file);
  const result = parseDocument(raw);
  return { path, ...result };
}

const rel = (p: string): string => {
  const r = relative(process.cwd(), p);
  return r === '' || r.startsWith('..') ? p : r;
};

function writeOut(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function printDiagnostics(diagnostics: readonly Diagnostic[], out: NodeJS.WriteStream): void {
  for (const d of diagnostics) out.write(`${formatDiagnostic(d)}\n`);
}

/* -- validate ------------------------------------------------------------- */
function cmdValidate(argv: Argv): number {
  const file = argv.positionals[0];
  if (file === undefined) throw new UsageError('validate needs a file: artboard validate <file.json>');

  const { path, doc, readOnly } = openDocument(file);
  const diagnostics = doc.diagnostics;

  process.stdout.write(`${bold(rel(path))}\n`);
  if (readOnly) process.stdout.write(`  ${yellow('read-only')} document was written by a newer version\n`);
  printDiagnostics(diagnostics, process.stdout);
  process.stdout.write(`  ${dim('diagnostics:')} ${summarizeDiagnostics(diagnostics)}\n`);

  if (hasErrors(diagnostics)) {
    process.stdout.write(`${red('INVALID')} ${rel(path)}\n`);
    return FAILED;
  }
  process.stdout.write(`${green('VALID')} ${rel(path)}\n`);
  return OK;
}

/* -- render --------------------------------------------------------------- */
function cmdRender(argv: Argv): number {
  const file = argv.positionals[0];
  if (file === undefined) throw new UsageError('render needs a file: artboard render <file.json> [--out out.svg]');

  const { path, doc, diagnostics: openDiagnostics } = openDocument(file);

  const rawIndex = argv.flags.artboard;
  const index = rawIndex === undefined ? 0 : Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) throw new UsageError(`--artboard must be a non-negative integer, got "${String(rawIndex)}"`);
  if (index >= doc.artboards.length) throw new ArtboardRangeError(index, doc.artboards.length);

  const inlineAssets = argv.flags['no-assets'] !== true;
  const { svg, diagnostics: renderDiagnostics } = renderToString(doc, index, { inlineAssets });
  const diagnostics = [...openDiagnostics, ...renderDiagnostics];

  const out = argv.flags.out;
  if (typeof out === 'string') {
    const target = resolve(process.cwd(), out);
    writeOut(target, svg + '\n');
    process.stderr.write(`${green('wrote')} ${rel(target)} ${dim(`(${Buffer.byteLength(svg) + 1} bytes, artboard ${index} of ${rel(path)})`)}\n`);
  } else {
    process.stdout.write(svg + '\n');
  }

  printDiagnostics(diagnostics, process.stderr);
  if (diagnostics.length) process.stderr.write(`  ${dim('diagnostics:')} ${summarizeDiagnostics(diagnostics)}\n`);
  return hasErrors(diagnostics) ? FAILED : OK;
}

/* -- info ----------------------------------------------------------------- */
function cmdInfo(argv: Argv): number {
  const file = argv.positionals[0];
  if (file === undefined) throw new UsageError('info needs a file: artboard info <file.json>');

  const { path, doc, readOnly } = openDocument(file);

  const byKind = new Map<string, number>();
  let total = 0;
  walk(doc, (node) => {
    const kind = String((node as { kind?: unknown }).kind ?? 'unknown');
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    total += 1;
  });

  process.stdout.write(`${bold(rel(path))}\n`);
  process.stdout.write(`  ${dim('document')}   ${JSON.stringify(doc.name)} ${dim(`id=${doc.id} v${doc.version}`)}${readOnly ? ` ${yellow('(read-only)')}` : ''}\n`);
  process.stdout.write(`  ${dim('artboards')}  ${doc.artboards.length}\n`);
  doc.artboards.forEach((ab, i) => {
    process.stdout.write(`    ${dim(`[${i}]`)} ${pad(ab.name, 24)} ${cyan(`${ab.width}x${ab.height}`)} ${dim(`${ab.nodes.length} top-level node${ab.nodes.length === 1 ? '' : 's'}`)}\n`);
  });
  process.stdout.write(`  ${dim('nodes')}      ${total}\n`);
  for (const kind of [...byKind.keys()].sort()) {
    process.stdout.write(`    ${pad(kind, 10)} ${byKind.get(kind)}\n`);
  }
  process.stdout.write(`  ${dim('assets')}     ${Object.keys(doc.assets).length}\n`);
  process.stdout.write(`  ${dim('diagnostics')} ${summarizeDiagnostics(doc.diagnostics)}\n`);
  printDiagnostics(doc.diagnostics, process.stdout);
  return OK;
}

/* -- export ---------------------------------------------------------------
 *
 * The headless half of the Export dialog. Same options, same code underneath,
 * so `artboard export --format svg --scale 2` and the dialog's SVG at 2x are
 * the same bytes. PNG and JPG are deliberately absent: rasterising needs a
 * canvas, and a CLI that silently produced a different-looking PNG would be
 * worse than one that says it cannot.
 * ------------------------------------------------------------------------ */
async function cmdExport(argv: Argv): Promise<number> {
  const file = argv.positionals[0];
  if (file === undefined) throw new UsageError('export needs a file: artboard export <file.json> [--format svg]');

  const rawFormat = argv.flags.format === undefined ? 'svg' : String(argv.flags.format).toLowerCase();
  if (!isFormat(rawFormat)) {
    throw new UsageError(`--format must be one of ${HEADLESS_FORMATS.join(', ')} (got "${rawFormat}").`);
  }
  const format: ExportFormat = rawFormat;
  if (!HEADLESS_FORMATS.includes(format)) {
    throw new UsageError(`${format.toUpperCase()} export needs a canvas to rasterise. The editor can do it; a headless CLI cannot without a rasteriser dependency. Use --format svg or --format pdf.`);
  }

  const scale = argv.flags.scale === undefined ? 1 : Number(argv.flags.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new UsageError(`--scale must be between 0 and 10, got "${String(argv.flags.scale)}".`);

  const transparent = argv.flags.transparent === true ? true
    : argv.flags['no-transparent'] === true ? false
    : undefined;

  const { path, doc, diagnostics: openDiagnostics } = openDocument(file);
  const pages = parsePages(argv.flags.pages === undefined ? 'all' : String(argv.flags.pages), doc.artboards.length);

  const stem = fileStem(doc.name);
  const { files, notes } = await buildVectorExport(doc, { format, scale, transparent, pages, quality: 0.92 }, stem);

  const out = typeof argv.flags.out === 'string' ? argv.flags.out : undefined;
  const asZip = argv.flags.zip === true;

  const written: string[] = [];
  if (asZip) {
    const target = resolve(process.cwd(), out ?? `${stem}.zip`);
    writeBytes(target, zipStore(files.map(f => ({ name: f.name, data: toBytes(f.data) }))));
    written.push(target);
  } else if (files.length === 1) {
    const only = files[0]!;
    const target = resolve(process.cwd(), out ?? only.name);
    writeBytes(target, toBytes(only.data));
    written.push(target);
  } else {
    // Several pages, no --zip: --out names the directory they land in. An --out
    // that looks like a file is a mistake worth catching, not a directory to
    // make - unless it already exists as a directory, in which case there is
    // nothing to guess and `releases/v1.2` is a perfectly good name.
    const known = existsSync(out ?? '.') && statSync(out ?? '.').isDirectory();
    if (out !== undefined && !known && /\.[a-z0-9]+$/i.test(out)) {
      throw new UsageError(`This export is ${files.length} files, so --out names a directory. Drop the extension from "${out}", or add --zip to write one archive there.`);
    }
    const dir = resolve(process.cwd(), out ?? '.');
    for (const f of files) {
      const target = join(dir, f.name);
      writeBytes(target, toBytes(f.data));
      written.push(target);
    }
  }

  for (const target of written) {
    process.stderr.write(`${green('wrote')} ${rel(target)} ${dim(`(${statSync(target).size} bytes)`)}\n`);
  }
  for (const note of notes) process.stderr.write(`${yellow('note')} ${note}\n`);
  printDiagnostics(openDiagnostics, process.stderr);
  return hasErrors(openDiagnostics) ? FAILED : OK;
}

const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? new TextEncoder().encode(data) : data;

function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/* -- check -----------------------------------------------------------------
 *
 * The design review, as opposed to `validate`'s structural one. `validate`
 * answers "is this a document"; `check` answers "can anyone read it" --
 * contrast against whatever is actually painted behind the text, type that is
 * too small to print, lines too long to track.
 *
 * Its own command rather than a flag on `validate` because the two have
 * different failure semantics. A structural error means the file cannot be
 * opened; a contrast finding means a human should look. Folding advisory
 * findings into `validate` would either make a readable document exit 1 or
 * teach everyone to ignore its output.
 * ------------------------------------------------------------------------ */
function cmdCheck(argv: Argv): number {
  const file = argv.positionals[0];
  if (file === undefined) throw new UsageError('check needs a file: artboard check <file.json>');

  const rawLevel = argv.flags.level === undefined ? 'AA' : String(argv.flags.level).toUpperCase();
  if (rawLevel !== 'AA' && rawLevel !== 'AAA') throw new UsageError(`--level must be AA or AAA, got "${String(argv.flags.level)}".`);

  const { path, doc } = openDocument(file);
  const findings = checkDocument(doc, { level: rawLevel, reportUnknown: argv.flags.unknown === true });

  process.stdout.write(`${bold(rel(path))} ${dim(`WCAG ${rawLevel}`)}\n`);
  printDiagnostics(findings, process.stdout);

  const byCode = new Map<string, number>();
  for (const f of findings) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  for (const code of [...byCode.keys()].sort()) {
    process.stdout.write(`  ${pad(code, 20)} ${byCode.get(code)}\n`);
  }

  if (!findings.length) {
    // Said out loud, because "no output" is also what a broken check looks
    // like, and the two must not be indistinguishable.
    process.stdout.write(`${green('CLEAN')} ${rel(path)} -- nothing to report at WCAG ${rawLevel}\n`);
    return OK;
  }
  process.stdout.write(`${yellow('FINDINGS')} ${findings.length} in ${rel(path)}\n`);
  // Advisory by design: a low-contrast heading is a judgement call, not a
  // corrupt file, so this exits 0 unless something is genuinely an error.
  return hasErrors(findings) ? FAILED : OK;
}

/* -- bulk ------------------------------------------------------------------
 *
 * One template, one row of data, one file out. This is the CLI's reason to
 * exist: a hundred certificates or name badges is a loop over the export path
 * that nobody wants to run by hand in an editor.
 *
 * Every row is a full parse. That costs more than substituting into a
 * pre-parsed document, and it buys the thing that matters -- a row whose data
 * makes an invalid document is named and skipped instead of quietly rendering
 * a default in place of the value.
 * ------------------------------------------------------------------------ */
async function cmdBulk(argv: Argv): Promise<number> {
  const file = argv.positionals[0];
  if (file === undefined) throw new UsageError('bulk needs a template: artboard bulk <template.json> --data rows.csv [--out dir]');

  const dataFlag = argv.flags.data;
  if (typeof dataFlag !== 'string') throw new UsageError('bulk needs data: artboard bulk <template.json> --data rows.csv');

  const rawFormat = argv.flags.format === undefined ? 'svg' : String(argv.flags.format).toLowerCase();
  if (!isFormat(rawFormat)) throw new UsageError(`--format must be one of ${HEADLESS_FORMATS.join(', ')} (got "${rawFormat}").`);
  const format: ExportFormat = rawFormat;
  if (!HEADLESS_FORMATS.includes(format)) {
    throw new UsageError(`${format.toUpperCase()} needs a canvas to rasterise, which a headless CLI has not got. Use --format svg, pdf or json.`);
  }

  const scale = argv.flags.scale === undefined ? 1 : Number(argv.flags.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new UsageError(`--scale must be between 0 and 10, got "${String(argv.flags.scale)}".`);

  const transparent = argv.flags.transparent === true ? true
    : argv.flags['no-transparent'] === true ? false
    : undefined;

  const template = readSource(file);
  const data = readSource(dataFlag);

  const placeholders = findPlaceholders(template.raw);
  if (!placeholders.length) {
    throw new UsageError(`${rel(template.path)} has no {{placeholders}}, so every row would render the same file. Put {{column}} where the per-row values go.`);
  }

  const { columns, rows: allRows } = parseData(data.raw, data.path, typeof argv.flags.delimiter === 'string' ? argv.flags.delimiter : undefined);

  // Named up front, against the columns, rather than one row at a time: a
  // typo'd {{placeholder}} should fail before the first file is written, not
  // on row 1 of 500 with 0 written and a half-explained error.
  const unresolved = placeholders.filter(p => !columns.includes(p));
  if (unresolved.length) {
    throw new UsageError(
      `${unresolved.map(p => `{{${p}}}`).join(', ')} ${unresolved.length === 1 ? 'has no column' : 'have no columns'} in ${rel(data.path)}.\n` +
      `        columns: ${columns.join(', ')}`);
  }

  const limit = argv.flags.limit === undefined ? allRows.length : Number(argv.flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive integer, got "${String(argv.flags.limit)}".`);
  const rows = allRows.slice(0, limit);

  const nameColumn = typeof argv.flags.name === 'string' ? argv.flags.name : undefined;
  const stems = nameRows(rows, fileStem(template.path.split('/').pop()?.replace(/\.json$/i, '')), nameColumn);

  const out = typeof argv.flags.out === 'string' ? argv.flags.out : '.';
  const known = existsSync(out) && statSync(out).isDirectory();
  if (!known && /\.[a-z0-9]+$/i.test(out)) {
    throw new UsageError(`bulk writes one file per row, so --out names a directory. Drop the extension from "${out}".`);
  }
  const dir = resolve(process.cwd(), out);
  const dryRun = argv.flags['dry-run'] === true;

  const unused = columns.filter(c => !placeholders.includes(c) && c !== nameColumn);

  let written = 0;
  let bytes = 0;
  const failures: { row: number; stem: string; why: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const stem = stems[i]!;
    try {
      const filled = fillTemplate(template.raw, row);
      const { doc, diagnostics } = parseDocument(filled);
      if (hasErrors(diagnostics)) {
        // Deduped: one bad {{assetId}} is reported once by every image node
        // that used it, and eight copies of a sentence read as eight problems.
        const why = [...new Set(diagnostics.filter(d => d.level === 'error').map(d => d.message))];
        failures.push({ row: i + 1, stem, why: why.join('; ') });
        continue;
      }
      const pages = parsePages(argv.flags.pages === undefined ? 'all' : String(argv.flags.pages), doc.artboards.length);
      const { files } = await buildVectorExport(doc, { format, scale, transparent, pages, quality: 0.92 }, stem);
      for (const f of files) {
        const target = join(dir, f.name);
        const data = toBytes(f.data);
        if (!dryRun) writeBytes(target, data);
        bytes += data.byteLength;
        written += 1;
      }
    } catch (e) {
      failures.push({ row: i + 1, stem, why: describeError(e) });
    }
  }

  for (const f of failures.slice(0, 5)) {
    process.stderr.write(`${red('row ' + f.row)} ${dim(f.stem)} ${f.why}\n`);
  }
  if (failures.length > 5) process.stderr.write(`${red('...')} and ${failures.length - 5} more failed rows\n`);
  if (unused.length) process.stderr.write(`${yellow('note')} unused column${unused.length === 1 ? '' : 's'}: ${unused.join(', ')}\n`);
  if (limit < allRows.length) process.stderr.write(`${yellow('note')} --limit ${limit} of ${allRows.length} rows; ${allRows.length - limit} not rendered\n`);

  const verb = dryRun ? 'would write' : 'wrote';
  process.stdout.write(
    `${failures.length ? yellow('BULK PARTIAL') : green('BULK OK')} ${verb} ${written} file${written === 1 ? '' : 's'} ` +
    `${dim(`(${bytes} bytes)`)} from ${rows.length - failures.length}/${rows.length} rows into ${rel(dir)}\n`);

  return failures.length ? FAILED : OK;
}

/* -- golden (the oracle) --------------------------------------------------- */
type CaseStatus = 'pass' | 'fail' | 'created' | 'updated' | 'unchanged';

interface GoldenCase {
  fixture: string;
  artboard: number;
  baseline: string;
  status: CaseStatus;
  detail: string;
}

const normalize = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');

function baselineFor(dir: string, fixture: string, artboard: number): string {
  const stem = fixture.replace(/\.json$/, '');
  return join(dir, artboard === 0 ? `${stem}.svg` : `${stem}.a${artboard}.svg`);
}

const actualFor = (baseline: string): string => baseline.replace(/\.svg$/, '.actual.svg');

function unifiedish(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  let i = 0;
  while (i < e.length && i < a.length && e[i] === a[i]) i += 1;

  let differing = Math.abs(e.length - a.length);
  for (let k = 0; k < Math.min(e.length, a.length); k++) if (e[k] !== a[k]) differing += 1;

  const lines: string[] = [dim(`      @@ first difference at line ${i + 1} @@`)];
  for (let c = Math.max(0, i - 3); c < i; c++) lines.push(dim(`        ${e[c]}`));
  lines.push(red(`      - ${e[i] ?? '(end of baseline)'}`));
  lines.push(green(`      + ${a[i] ?? '(end of render)'}`));
  lines.push(dim(`      ${differing} line(s) differ; baseline ${e.length} lines, render ${a.length} lines`));
  return lines.join('\n');
}

function goldenCases(dir: string, fixture: string, update: boolean): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const source = join(dir, fixture);

  let doc;
  let openDiagnostics: Diagnostic[];
  try {
    const opened = parseDocument(readFileSync(source, 'utf8'));
    doc = opened.doc;
    openDiagnostics = opened.doc.diagnostics;
  } catch (e) {
    return [{ fixture, artboard: 0, baseline: baselineFor(dir, fixture, 0), status: 'fail', detail: `did not parse -- ${describeError(e)}` }];
  }

  for (let index = 0; index < doc.artboards.length; index++) {
    const baseline = baselineFor(dir, fixture, index);
    const actualPath = actualFor(baseline);

    let svg: string;
    let diagnostics: Diagnostic[];
    try {
      // inlineAssets:false keeps data: URIs out of the baselines -- fixtures stay diffable.
      const rendered = renderToString(doc, index, { inlineAssets: false });
      svg = rendered.svg;
      diagnostics = [...openDiagnostics, ...rendered.diagnostics];
    } catch (e) {
      cases.push({ fixture, artboard: index, baseline, status: 'fail', detail: `render threw -- ${describeError(e)}` });
      continue;
    }

    const errors = diagnostics.filter(d => d.level === 'error');
    if (errors.length) {
      const detail = errors.map(d => `${d.code}: ${d.message}`).join('; ');
      cases.push({ fixture, artboard: index, baseline, status: 'fail', detail: `error diagnostics -- ${detail}` });
      continue;
    }

    const rendered = svg + '\n';

    if (update) {
      const existed = existsSync(baseline);
      const same = existed && normalize(readFileSync(baseline, 'utf8')) === normalize(rendered);
      if (!same) writeOut(baseline, rendered);
      if (existsSync(actualPath)) rmSync(actualPath);
      cases.push({ fixture, artboard: index, baseline, status: existed ? (same ? 'unchanged' : 'updated') : 'created', detail: '' });
      continue;
    }

    if (!existsSync(baseline)) {
      writeOut(actualPath, rendered);
      // `npm run golden -- --update`, not `artboard golden --update`. The bin is
      // linked into node_modules/.bin by the workspace install, so the bare name
      // resolves inside an npm script and from `npx` -- but NOT in the plain
      // shell the reader of this message is standing in. A remedy that does not
      // run is worse than no remedy: it is emitted at the exact moment someone
      // is stuck, and it costs them a detour proving the tool lied.
      cases.push({ fixture, artboard: index, baseline, status: 'fail', detail: `no baseline -- run \`npm run golden -- --update\` (render saved to ${rel(actualPath)})` });
      continue;
    }

    const expected = normalize(readFileSync(baseline, 'utf8'));
    if (expected === normalize(rendered)) {
      if (existsSync(actualPath)) rmSync(actualPath);
      cases.push({ fixture, artboard: index, baseline, status: 'pass', detail: '' });
      continue;
    }

    writeOut(actualPath, rendered);
    cases.push({ fixture, artboard: index, baseline, status: 'fail', detail: unifiedish(expected, normalize(rendered)) });
  }

  return cases;
}

function cmdGolden(argv: Argv): number {
  const dirFlag = argv.flags.dir;
  const dir = typeof dirFlag === 'string'
    ? resolve(process.cwd(), dirFlag)
    : join(repoRoot(), 'tests', 'golden');
  const update = argv.flags.update === true;

  if (!existsSync(dir)) throw new NoFixturesError(dir);
  const fixtures = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (fixtures.length === 0) throw new NoFixturesError(dir);

  const cases: GoldenCase[] = [];
  for (const fixture of fixtures) cases.push(...goldenCases(dir, fixture, update));

  const label: Record<CaseStatus, string> = {
    pass: green('PASS'),
    fail: red('FAIL'),
    created: cyan('NEW '),
    updated: yellow('UPD '),
    unchanged: dim('SAME'),
  };

  process.stdout.write(`${bold('golden')} ${dim(rel(dir))} ${dim(`${fixtures.length} fixture${fixtures.length === 1 ? '' : 's'}, ${cases.length} artboard${cases.length === 1 ? '' : 's'}`)}\n`);
  for (const c of cases) {
    const name = `${c.fixture}[${c.artboard}]`;
    process.stdout.write(`  ${label[c.status]} ${pad(name, 28)} ${dim('->')} ${rel(c.baseline)}\n`);
    if (c.detail) process.stdout.write(`${c.detail.includes('\n') ? c.detail : `      ${c.detail}`}\n`);
  }

  const failed = cases.filter(c => c.status === 'fail');
  const changed = cases.filter(c => c.status === 'created' || c.status === 'updated');

  if (failed.length) {
    process.stdout.write(`${red('GOLDEN RED')} ${failed.length} of ${cases.length} drifted: ${failed.map(c => `${c.fixture}[${c.artboard}]`).join(', ')}\n`);
    return FAILED;
  }
  if (update) {
    process.stdout.write(`${green('GOLDEN UPDATED')} ${changed.length} baseline${changed.length === 1 ? '' : 's'} written, ${cases.length - changed.length} already current\n`);
    return OK;
  }
  process.stdout.write(`${green('GOLDEN GREEN')} ${cases.length} artboard${cases.length === 1 ? ' matches its baseline' : 's match their baselines'}\n`);
  return OK;
}

/* -- help ----------------------------------------------------------------- */
const HELP = `${bold('artboard')} -- the Artboard design-document CLI

${bold('USAGE')}
  artboard <command> [options]

${bold('COMMANDS')}
  validate <file.json>              Parse a document, print diagnostics. Exit 1 on any error diagnostic.
  render   <file.json>              Render an artboard to deterministic SVG.
      --out <path>                  Write to a file instead of stdout.
      --artboard <n>                Which artboard (default 0).
      --no-assets                   Emit asset:<id> refs instead of inline data: URIs.
  golden                            THE ORACLE: re-render every tests/golden fixture and diff the SVG.
      --update                      Rewrite the .svg baselines instead of failing.
      --dir <path>                  Fixture directory (default <repo>/tests/golden).
  export   <file.json>              Export a document. Same options as the editor's Export dialog.
      --format <fmt>                svg (default), pdf, or json. png/jpg need a canvas; use the editor.
      --scale <n>                   Output size multiplier: SVG width/height, PDF page size. Default 1.
      --pages <spec>                all (default), 3, 2-5, or 1,4,7-9. 1-based.
      --transparent                 Force every page's background to none.
      --no-transparent              Force an opaque white behind a page that has none.
      --zip                         Bundle the output into one stored .zip.
      --out <path>                  File to write (single output) or directory (several).
  check    <file.json>              Design review: text contrast against what is really behind it, type size, line length.
      --level <AA|AAA>              WCAG conformance level to hold text to. Default AA.
      --unknown                     Also report text whose backdrop could not be determined.
  bulk     <template.json>          Render one file per data row: mail merge for designs.
      --data <file>                 csv, tsv, or json array of objects. Its columns fill {{placeholders}}.
      --out <dir>                   Directory for the output (default the working directory).
      --name <column>               Name each file after this column instead of numbering them.
      --format <fmt>                svg (default), pdf, or json. Same renderer as export.
      --scale <n> --pages <spec>    As export. --transparent / --no-transparent too.
      --delimiter <char>            Override the separator (default , or a tab for .tsv).
      --limit <n>                   Only the first n rows -- check the shape before rendering 500.
      --dry-run                     Report what would be written without writing it.
  info     <file.json>              Artboard count, node counts by kind, asset count, diagnostics.

${bold('OPTIONS')}
  -h, --help                        This text.
  -v, --version                     Print the CLI version.

${bold('ENVIRONMENT')}
  NO_COLOR                          Set to any non-empty value to disable colour.
  FORCE_COLOR                       Set to force colour when stdout is not a TTY.

${bold('EXIT CODES')}
  0  success        1  failure (invalid document, golden drift)        2  bad usage
`;

function version(): string {
  const manifest = readJson(join(HERE, '..', 'package.json')) as { version?: string } | null;
  return manifest?.version ?? '0.0.0';
}

/* -- entry ---------------------------------------------------------------- */
export async function run(rawArgv: readonly string[]): Promise<number> {
  let argv: Argv;
  try {
    argv = parseArgv(rawArgv);
  } catch (e) {
    process.stderr.write(`${red('error')} ${describeError(e)}\n`);
    return USAGE;
  }

  // --version is checked first: it also arrives with an empty command.
  if (argv.flags.version === true || argv.flags.v === true || argv.command === 'version') {
    process.stdout.write(`${version()}\n`);
    return OK;
  }
  const askedForHelp = argv.flags.help === true || argv.flags.h === true || argv.command === 'help';
  if (askedForHelp || argv.command === '') {
    process.stdout.write(HELP);
    return askedForHelp ? OK : USAGE;
  }

  const commands: Record<string, (a: Argv) => number | Promise<number>> = {
    validate: cmdValidate,
    render: cmdRender,
    golden: cmdGolden,
    info: cmdInfo,
    export: cmdExport,
    bulk: cmdBulk,
    check: cmdCheck,
  };
  const handler = commands[argv.command];
  if (!handler) {
    process.stderr.write(`${red('error')} UsageError: unknown command "${argv.command}". Try \`artboard --help\`.\n`);
    return USAGE;
  }

  try {
    return await handler(argv);
  } catch (e) {
    process.stderr.write(`${red('error')} ${describeError(e)}\n`);
    return e instanceof UsageError || e instanceof PageRangeError || e instanceof DataError ? USAGE : FAILED;
  }
}
