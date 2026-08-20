#!/usr/bin/env node
/**
 * The gauntlet -- Artboard's autonomous build loop.
 *
 * This script contains no AI. It is the harness an agent runs against: three
 * gates, one verdict, one exit code.
 *
 *   1. npm run typecheck                          does it compile?
 *   2. npm test                                   do the unit tests pass?
 *   3. artboard golden                            does the renderer still draw
 *                                                 what it drew before?
 *
 * Exit 0 == GREEN == the task may be considered done.
 * Exit 1 == RED   == it may not. That exit code is the whole contract.
 *
 *   node tools/gauntlet/loop.mjs [--once] [--watch] [--json]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const STATUS_PATH = join(HERE, 'status.json');

const GATE_TIMEOUT_MS = 5 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 250;
const OUTPUT_KEEP_CHARS = 4000;

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s) => s.replace(ANSI, '');

/* -- terminal ------------------------------------------------------------- */
const ESC = String.fromCharCode(27);
const COLOR = (process.env.NO_COLOR === undefined || process.env.NO_COLOR === '') && process.stdout.isTTY === true;
const paint = (code) => (s) => (COLOR ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - strip(s).length));

/* -- named errors --------------------------------------------------------- */
class GateTimeoutError extends Error {
  constructor(label, ms) { super(`Gate "${label}" exceeded ${ms}ms and was killed.`); this.name = 'GateTimeoutError'; }
}
class GateSpawnError extends Error {
  constructor(label, cause) { super(`Gate "${label}" could not start -- ${cause}`); this.name = 'GateSpawnError'; }
}

const describe = (e) =>
  e instanceof Error ? `${e.name}: ${e.message}` : `ThrownValue: ${String(e)}`;

/* -- running a gate ------------------------------------------------------- */
function runGate(label, command, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        shell: false,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ label, code: null, output: describe(new GateSpawnError(label, describe(e))), durationMs: 0, timedOut: false });
      return;
    }

    let out = '';
    const collect = (chunk) => { out += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, GATE_TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ label, code: null, output: `${out}\n${describe(new GateSpawnError(label, describe(e)))}`, durationMs: Date.now() - started, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const suffix = timedOut ? `\n${describe(new GateTimeoutError(label, GATE_TIMEOUT_MS))}` : '';
      resolve({ label, code, output: strip(out) + suffix, durationMs: Date.now() - started, timedOut });
    });
  });
}

const tail = (s, n = OUTPUT_KEEP_CHARS) => {
  const t = s.trim();
  return t.length <= n ? t : `...[${t.length - n} chars elided]...\n${t.slice(-n)}`;
};

/* -- gate 1: typecheck ---------------------------------------------------- */
async function gateTypecheck() {
  const r = await runGate('typecheck', 'npm', ['run', '--silent', 'typecheck']);
  const errors = r.output
    .split('\n')
    .filter((l) => /\berror TS\d+:/.test(l))
    .map((l) => l.trim());
  return { pass: r.code === 0, output: tail(r.output), errors, exitCode: r.code, durationMs: r.durationMs };
}

/* -- gate 2: tests -------------------------------------------------------- */
async function gateTests() {
  const r = await runGate('tests', 'npm', ['run', '--silent', 'test']);
  const noTestFiles = /No test files found/i.test(r.output);

  const failing = [];
  for (const raw of r.output.split('\n')) {
    const line = raw.trim();
    const failMatch = /^FAIL\s+(.+)$/.exec(line);
    if (failMatch) { failing.push(failMatch[1].trim()); continue; }
    const crossMatch = /^[x×✗]\s+(.+?)(?:\s+\d+ms)?$/.exec(line);
    if (crossMatch) failing.push(crossMatch[1].trim());
  }

  const unique = [...new Set(failing)];
  return {
    pass: r.code === 0,
    failing: unique,
    noTestFiles,
    output: tail(r.output),
    exitCode: r.code,
    durationMs: r.durationMs,
  };
}

/* -- gate 3: golden (the oracle) ------------------------------------------ */
async function gateGolden() {
  const cli = join(ROOT, 'packages', 'cli', 'bin', 'artboard.mjs');
  const r = await runGate('golden', process.execPath, [cli, 'golden']);

  // `GOLDEN RED n of m drifted: a.json[0], b.json[1]` is the CLI's stable
  // machine-readable summary line. FAIL lines are the fallback.
  const drifted = [];
  const summary = /^GOLDEN RED .*drifted:\s*(.+)$/m.exec(r.output);
  if (summary) {
    for (const name of summary[1].split(',')) if (name.trim()) drifted.push(name.trim());
  } else {
    for (const raw of r.output.split('\n')) {
      const m = /^\s*FAIL\s+(\S+)/.exec(raw);
      if (m) drifted.push(m[1]);
    }
  }

  const noFixtures = /NoFixturesError/.test(r.output);
  const total = Number(/(\d+)\s+artboards?\b/.exec(r.output)?.[1] ?? 0);

  return {
    pass: r.code === 0,
    drifted: [...new Set(drifted)],
    noFixtures,
    artboards: total,
    output: tail(r.output),
    exitCode: r.code,
    durationMs: r.durationMs,
  };
}

/* -- next actions --------------------------------------------------------- */
function nextActionsFor(gates) {
  const actions = [];

  if (!gates.typecheck.pass) {
    const first = gates.typecheck.errors[0];
    actions.push(gates.typecheck.errors.length
      ? `Fix ${gates.typecheck.errors.length} TypeScript error(s). First: ${first}`
      : 'typecheck exited non-zero with no TS diagnostics parsed -- read gates.typecheck.output.');
  }

  if (!gates.tests.pass) {
    if (gates.tests.noTestFiles) {
      actions.push('vitest found no test files. Add at least one *.test.ts under tests/ or packages/*/src/.');
    } else if (gates.tests.failing.length) {
      actions.push(`Fix ${gates.tests.failing.length} failing test(s). First: ${gates.tests.failing[0]}`);
    } else {
      actions.push('npm test exited non-zero with no failures parsed -- read gates.tests.output.');
    }
  }

  if (!gates.golden.pass) {
    if (gates.golden.noFixtures) {
      actions.push('tests/golden has no fixtures. Add a *.json document, then run `npm run golden -- --update`.');
    } else if (gates.golden.drifted.length) {
      actions.push(`Golden drift in ${gates.golden.drifted.join(', ')}. Inspect the .actual.svg next to each baseline; if the new output is correct, run \`npm run golden -- --update\` and commit the baseline.`);
    } else {
      actions.push('golden exited non-zero with no drift parsed -- read gates.golden.output.');
    }
  }

  return actions;
}

/* -- one iteration -------------------------------------------------------- */
function previousIteration() {
  if (!existsSync(STATUS_PATH)) return 0;
  const raw = readFileSync(STATUS_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`${yellow('warn')} ignoring unreadable status.json -- ${describe(e)}\n`);
    return 0;
  }
  return Number.isInteger(parsed?.iteration) ? parsed.iteration : 0;
}

async function iterate(iteration) {
  const startedAt = Date.now();
  const typecheck = await gateTypecheck();
  const tests = await gateTests();
  const golden = await gateGolden();

  const gates = { typecheck, tests, golden };
  const verdict = typecheck.pass && tests.pass && golden.pass ? 'GREEN' : 'RED';

  const status = {
    ts: new Date().toISOString(),
    iteration,
    gates: {
      typecheck: { pass: typecheck.pass, output: typecheck.output, errors: typecheck.errors, exitCode: typecheck.exitCode, durationMs: typecheck.durationMs },
      tests: { pass: tests.pass, failing: tests.failing, noTestFiles: tests.noTestFiles, output: tests.output, exitCode: tests.exitCode, durationMs: tests.durationMs },
      golden: { pass: golden.pass, drifted: golden.drifted, noFixtures: golden.noFixtures, artboards: golden.artboards, output: golden.output, exitCode: golden.exitCode, durationMs: golden.durationMs },
    },
    verdict,
    nextActions: nextActionsFor(gates),
    durationMs: Date.now() - startedAt,
  };

  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n', 'utf8');
  return status;
}

/* -- reporting ------------------------------------------------------------ */
function detailFor(name, gate) {
  if (name === 'typecheck') return gate.pass ? 'no type errors' : `${gate.errors.length || '?'} type error(s)`;
  if (name === 'tests') {
    if (gate.pass) return 'all tests pass';
    if (gate.noTestFiles) return 'no test files found';
    return `${gate.failing.length || '?'} failing`;
  }
  if (gate.pass) return `${gate.artboards} artboard(s) match`;
  if (gate.noFixtures) return 'no fixtures';
  return `${gate.drifted.length || '?'} drifted`;
}

function report(status) {
  const stamp = dim(status.ts);
  process.stdout.write(`\n${bold('GAUNTLET')} ${dim(`iteration ${status.iteration}`)} ${stamp}\n`);
  process.stdout.write(dim('  gate        result   detail                          time\n'));

  for (const name of ['typecheck', 'tests', 'golden']) {
    const gate = status.gates[name];
    const result = gate.pass ? green('PASS') : red('FAIL');
    const secs = `${(gate.durationMs / 1000).toFixed(1)}s`;
    process.stdout.write(`  ${padEnd(name, 12)}${padEnd(result, 9)}${padEnd(detailFor(name, gate), 32)}${dim(secs)}\n`);
  }

  const verdict = status.verdict === 'GREEN' ? green(bold('GREEN')) : red(bold('RED'));
  process.stdout.write(`  ${dim('-'.repeat(58))}\n`);
  process.stdout.write(`  ${bold('verdict')}     ${verdict}\n`);

  if (status.nextActions.length) {
    process.stdout.write(`\n${bold('NEXT')}\n`);
    for (const action of status.nextActions) process.stdout.write(`  ${yellow('*')} ${action}\n`);
  }
  process.stdout.write(`\n${dim(`status written to ${join('tools', 'gauntlet', 'status.json')}`)}\n`);
}

/* -- watch ---------------------------------------------------------------- */
const IGNORED_SEGMENTS = ['node_modules', '.git', 'dist', '.vite'];
const IGNORED_FILES = ['status.json', '.DS_Store'];

function isInteresting(filename) {
  if (!filename) return false;
  const parts = filename.split(sep);
  // dot-directories (.git, .vite, .scratch, ...) are never source
  if (parts.some((p) => IGNORED_SEGMENTS.includes(p) || p.startsWith('.'))) return false;
  const base = parts[parts.length - 1];
  if (IGNORED_FILES.includes(base)) return false;
  if (base.endsWith('.actual.svg') || base.endsWith('.log') || base.endsWith('~')) return false;
  return /\.(ts|tsx|js|mjs|cjs|json|svg|css|html)$/.test(base);
}

async function watchMode(startIteration, jsonOnly) {
  let iteration = startIteration;
  let running = false;
  let queued = false;
  let last = null;

  const cycle = async () => {
    if (running) { queued = true; return; }
    running = true;
    do {
      queued = false;
      iteration += 1;
      last = await iterate(iteration);
      if (jsonOnly) process.stdout.write(JSON.stringify(last, null, 2) + '\n');
      else report(last);
      process.exitCode = last.verdict === 'GREEN' ? 0 : 1;
    } while (queued);
    running = false;
    process.stdout.write(dim('watching for changes... (ctrl-c to stop)\n'));
  };

  await cycle();

  let debounce = null;
  const debugWatch = process.env.GAUNTLET_DEBUG_WATCH === '1';
  const watcher = watch(ROOT, { recursive: true }, (_event, filename) => {
    if (!isInteresting(filename)) return;
    if (debugWatch) process.stdout.write(dim(`  [watch] ${filename}\n`));
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void cycle(); }, WATCH_DEBOUNCE_MS);
  });

  process.on('SIGINT', () => {
    watcher.close();
    process.stdout.write('\n');
    process.exit(last && last.verdict === 'GREEN' ? 0 : 1);
  });
}

/* -- entry ---------------------------------------------------------------- */
async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(`--${flag}`);

  if (has('help') || argv.includes('-h')) {
    process.stdout.write(`gauntlet -- Artboard's autonomous build loop

  node tools/gauntlet/loop.mjs [--once] [--watch] [--json]

  --once    run the three gates once and exit (default)
  --watch   re-run on any source change, debounced
  --json    print only the contents of status.json

  exit 0 = GREEN (all gates pass), exit 1 = RED
`);
    return;
  }

  const jsonOnly = has('json');
  const iteration = previousIteration() + 1;

  if (has('watch')) {
    await watchMode(iteration - 1, jsonOnly);
    return;
  }

  const status = await iterate(iteration);
  if (jsonOnly) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  else report(status);
  process.exitCode = status.verdict === 'GREEN' ? 0 : 1;
}

await main();
