/**
 * artboard -- the Artboard command line.
 *
 *   artboard validate <file.json>
 *   artboard render   <file.json> [--out out.svg] [--artboard N]
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
const VALUE_FLAGS = new Set(['out', 'artboard', 'dir']);

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
      cases.push({ fixture, artboard: index, baseline, status: 'fail', detail: `no baseline -- run \`artboard golden --update\` (render saved to ${rel(actualPath)})` });
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
export function run(rawArgv: readonly string[]): number {
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

  const commands: Record<string, (a: Argv) => number> = {
    validate: cmdValidate,
    render: cmdRender,
    golden: cmdGolden,
    info: cmdInfo,
  };
  const handler = commands[argv.command];
  if (!handler) {
    process.stderr.write(`${red('error')} UsageError: unknown command "${argv.command}". Try \`artboard --help\`.\n`);
    return USAGE;
  }

  try {
    return handler(argv);
  } catch (e) {
    process.stderr.write(`${red('error')} ${describeError(e)}\n`);
    return e instanceof UsageError ? USAGE : FAILED;
  }
}
