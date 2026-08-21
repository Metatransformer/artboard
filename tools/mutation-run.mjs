/**
 * Run the real test suite against a MUTATED copy of one package, without ever
 * writing to the working tree.
 *
 *   node tools/mutation-run.mjs --copy commands            # -> prints a scratch index.ts
 *   $EDITOR <that path>                                    # break something
 *   node tools/mutation-run.mjs --pkg commands --at <path> # run the suite against it
 *
 * WHY THIS EXISTS, rather than editing `packages/<pkg>/src/index.ts` in place and
 * putting it back afterwards: on a shared worktree, in-place mutation has two
 * blast radii. The restore can clobber a peer's uncommitted edits, and -- the one
 * that actually bit us -- a peer can COMMIT while the mutant is on disk, landing
 * it in main inside their commit. `ed1900f` shipped `STACK_GAP = 0.5` that way and
 * turned main red. No announcement, interlock or dirty-tree check removes that
 * hazard; not writing to the tree does.
 *
 * It works because `vitest.config.ts` reaches every package through a
 * `resolve.alias` map, so substituting one module is a line of resolver config
 * rather than a file edit. The tests that run are the REAL ones -- no
 * transcription of the code under test into a scratch harness, which would test
 * the transcription as much as the code.
 *
 * THE MUTANT MUST BE FAITHFUL, and this is the easiest thing to get wrong --
 * it cost me a claim within an hour of writing this script. Reinstating a
 * removed rule, I wrote `valign: 'top' -> y: 'top'` unconditionally. The rule
 * actually removed in `df31bd5` was guarded: `a.y !== 'middle' ? a.y : ...`,
 * overriding only a CENTRED reading, exactly as the surviving x half does.
 *
 *   faithful (guard kept)     1 red   :433
 *   unconditional (dropped)   3 red   :433, :149, :159
 *
 * A strictly stronger mutant breaks things the real rule never touched -- here
 * it ate a stretch anchor, which is separately decided with its own test. The
 * two extra reds were artifacts, and one of them (`:159`) is a CONTROL whose
 * premise the mutant destroyed: it needs `sy != k`, and a node that stops
 * stretching makes `sy == k`. A control going red is the harness losing its
 * power to discriminate, NOT the mutant being caught -- read every new failure
 * before counting it, because a bigger number looks like a stronger result.
 *
 * So: reconstruct from `git show <commit>^:<path>`, never from memory of what
 * the rule did.
 *
 * SCOPE -- what this tool cannot tell you:
 *
 * 1. It runs `tests/**`, NOT the goldens. The 30-fixture SVG diff runs from
 *    `packages/cli/bin/artboard.mjs golden`, which this never invokes, so
 *    "no golden moved" is NEVER a result of this tool. It is also vacuous on
 *    its own terms for anything command-shaped: `goldenCases` parses a fixture
 *    and renders it, applying no command (`resize` appears 0 times in
 *    `packages/cli/src/main.ts` and in 0 of 30 fixtures), so the golden path
 *    cannot reach a command mutation of any strength. I reported "caught by
 *    three tests, none golden" as evidence; the second half was guaranteed
 *    before the run started.
 *
 * 2. It substitutes a PACKAGE ENTRY POINT through `resolve.alias`. Anything not
 *    reached that way -- a mutant in `vitest.config.ts` itself, in `tools/`, or
 *    in a module imported by relative path rather than through the alias map --
 *    still has no route but the working tree, and the window protocol still
 *    applies there. "All of it is alias-reachable" is true until someone adds a
 *    file.
 *
 * 3. Read this script's exit code directly. `--at ... | grep` reports the
 *    PIPELINE's status, so the in-repo refusal below looks like exit 0 through
 *    a pipe. Redirect to a file if you need to check it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Kept in step with `vitest.config.ts` by construction: same names, same shape. */
const PKGS = ['schema', 'engine', 'render-svg', 'commands', 'templates',
              'charts', 'codes', 'icons', 'diagnostics'];

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};

const copy = arg('--copy');
if (copy) {
  if (!PKGS.includes(copy)) die(`unknown package '${copy}'. one of: ${PKGS.join(', ')}`);
  // The WHOLE src directory, not just the entry point. Five of the nine
  // packages -- engine, render-svg, codes, icons, diagnostics -- import
  // relative siblings from `index.ts`, and a lone copy cannot resolve them
  // from a temp dir. That failure is worth spelling out because it does not
  // look like a failure: vitest reports it as failed SUITES, so `render-svg`
  // came back "6 failed | 8 passed" with 148 tests never collected and not one
  // assertion evaluated -- a bigger number than the 1 a real catch produces,
  // from a mutant that never ran. Read `Tests` as well as `Test Files`.
  const dir = mkdtempSync(join(tmpdir(), 'artboard-mutant-'));
  cpSync(join(ROOT, 'packages', copy, 'src'), dir, { recursive: true });
  console.log(join(dir, 'index.ts'));
  process.exit(0);
}

const pkg = arg('--pkg');
const at = arg('--at');
if (!pkg || !at) die('usage: --copy <pkg>  |  --pkg <pkg> --at <patched-file> [-- <vitest args>]');
if (!PKGS.includes(pkg)) die(`unknown package '${pkg}'. one of: ${PKGS.join(', ')}`);

const mutant = resolve(at);
// The one invariant worth enforcing. A mutant inside the repo is exactly the
// thing this script exists to avoid, and it is an easy slip: `--at packages/...`
// would run green, prove nothing about safety, and leave the tree dirty.
if (mutant.startsWith(ROOT + '/')) {
  die(`refusing: --at is inside the repo (${mutant}).\n` +
      `The point is that the tree is never written to. Use --copy to get a scratch path.`);
}

// A config OUTSIDE the repo cannot resolve the repo's bare specifiers, so this
// must not `import { defineConfig } from 'vitest/config'`. A plain object is a
// valid vitest config and needs no imports at all.
const alias = PKGS
  .map((p) => `      '@artboard/${p}': ${p === pkg ? JSON.stringify(mutant) : JSON.stringify(join(ROOT, 'packages', p, 'src', 'index.ts'))},`)
  .join('\n');

const configPath = join(mkdtempSync(join(tmpdir(), 'artboard-mutcfg-')), 'vitest.config.mjs');
writeFileSync(configPath, `export default {
  root: ${JSON.stringify(ROOT)},
  resolve: {
    alias: {
${alias}
      '@artboard/mcp/workspace': ${JSON.stringify(join(ROOT, 'packages', 'mcp', 'src', 'workspace.ts'))},
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
};
`);

const passthrough = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : [];
console.log(`mutating @artboard/${pkg} -> ${mutant}\n`);
const run = spawnSync('npx', ['vitest', 'run', '--config', configPath, ...passthrough],
                      { cwd: ROOT, stdio: 'inherit' });

// The tree was never a write target, but say so rather than implying it: a run
// that leaves the tree dirty means someone edited it by hand alongside this.
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
console.log(dirty ? `\nWARNING: working tree is dirty, and not from this script:\n${dirty}`
                  : '\nworking tree clean (this script never writes to it)');
process.exit(run.status ?? 1);

function die(msg) { console.error(msg); process.exit(2); }
