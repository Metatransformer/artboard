# The Gauntlet

Artboard's autonomous build loop. It contains no AI. It is the harness an agent
runs *against*.

```
npm run gauntlet              # one pass, human-readable table
npm run gauntlet -- --json    # one pass, machine-readable status.json on stdout
npm run gauntlet -- --watch   # re-run on every source change, debounced
node tools/gauntlet/loop.mjs --once   # the same thing, without npm in the way
```

## The contract

An agent picks one task. It implements the task. It runs `npm run gauntlet`.

**It is allowed to consider the task done only on GREEN.**

That is the entire protocol, and the exit code is how it is enforced:

| exit | verdict | meaning |
| ---- | ------- | ------- |
| `0`  | GREEN   | all three gates pass. The task may be closed. |
| `1`  | RED     | at least one gate failed. The task is not done. Read `nextActions`. |

There is no "mostly green", no "green except for a pre-existing failure", and no
partial credit. A gate that was already red before you started is still red
because of you now — either fix it or say out loud, in the place the work is
recorded, that you are handing back a RED tree and why.

## The three gates

Each gate runs in a fresh child process from the repo root with `NO_COLOR=1`, so
its captured output is plain text.

1. **`npm run typecheck`** — `tsc -b`. Does it compile? Parsed diagnostics land
   in `gates.typecheck.errors`.
2. **`npm test`** — `vitest run`. Do the unit tests pass? Failing test names land
   in `gates.tests.failing`. If vitest finds no test files at all the gate is RED
   with `noTestFiles: true`: a suite that tests nothing is not a passing suite.
3. **`node packages/cli/bin/artboard.mjs golden`** — the oracle. Re-render every
   fixture in `tests/golden` and diff the SVG against its committed baseline.
   Drifted fixtures land in `gates.golden.drifted`.

Gates run in that order, always all three, so one iteration tells you everything
at once instead of one failure at a time. Each gate is killed after five minutes
(`GateTimeoutError`) so `--watch` can never wedge.

## Why golden SVG diffs are the right oracle for a design tool

A design tool's real output is pixels, and pixels are the worst thing in the
world to test. Screenshot comparison drags in a headless browser, a GPU, a font
stack, and an anti-aliasing implementation — and then fails on a machine whose
subpixel hinting is a hair different from CI's. That flake is worse than no test,
because a suite that cries wolf gets muted.

Artboard sidesteps it because of one architectural decision in
`packages/render-svg`: **the renderer emits a scene graph as data**, and the same
code path either mounts it into the DOM (editor) or serializes it to a string
(CLI). There is no second renderer, so there is no parity problem to test around.

That makes the serialized SVG an unusually good oracle:

- **Deterministic.** All geometry comes from `@artboard/engine`, which measures
  text with a built-in width table (`metricMeasurer`) rather than asking the OS.
  Coordinates are rounded to two decimals. Gradient and clip-path ids are
  allocated from a counter that resets per render. The same document produces
  byte-identical SVG on every machine, forever.
- **Text-diffable.** When a baseline changes you see *what* changed —
  `fill="#4f46e5"` became `fill="#dc2626"`, a `<tspan>` moved 3px — not "1.4% of
  pixels differ". The diff names the bug.
- **No rasterization flake.** No browser, no GPU, no font files, no
  anti-aliasing, no timing. The gate takes ~100ms.
- **Reviewable in a pull request.** The baselines are text, so a visual
  regression shows up as a red/green diff a human can read without opening an
  image viewer.
- **It catches the failures that matter.** Almost every renderer regression is a
  wrong attribute, a dropped element, or a shifted coordinate. All three are
  loud in an SVG diff.

Golden files are deliberately rendered with `inlineAssets: false`, so image nodes
serialize as `asset:<id>` instead of a megabyte of base64. The fixtures stay
small and the diffs stay readable.

## Working with baselines

```
npm run golden                  # check (this is what the gauntlet runs)
npm run golden -- --update      # accept the current output as the new baseline
artboard golden --dir <path>    # point at a different fixture directory
```

- Baselines live next to their fixture: `tests/golden/smoke.json` →
  `tests/golden/smoke.svg`. A document with several artboards gets
  `smoke.svg`, `smoke.a1.svg`, `smoke.a2.svg`, …
- On a mismatch the CLI writes the new render to `smoke.actual.svg` (gitignored)
  so you can diff the whole file, not just the first differing line, and deletes
  it again as soon as the fixture passes.
- `--update` **refuses** to write a baseline for a document with error-level
  diagnostics. A fixture with a missing asset can't be blessed into the suite.
- Updating a baseline is a decision, not a chore. `--update` says "this new
  output is correct". Look at the diff before you type it.

## status.json

Every run overwrites `tools/gauntlet/status.json`. That file is the loop's
machine-readable half — an agent that can't parse a terminal table can read this.

```jsonc
{
  "ts": "2026-08-20T21:25:48.089Z",
  "iteration": 2,                      // increments across runs, persisted here
  "gates": {
    "typecheck": { "pass": false, "output": "...", "errors": ["file(1,2): error TS2339: ..."], "exitCode": 1, "durationMs": 1402 },
    "tests":     { "pass": true,  "failing": [], "noTestFiles": false, "output": "...", "exitCode": 0, "durationMs": 658 },
    "golden":    { "pass": true,  "drifted": [], "noFixtures": false, "artboards": 1, "output": "...", "exitCode": 0, "durationMs": 114 }
  },
  "verdict": "RED",                    // "GREEN" only when all three pass
  "nextActions": ["Fix 1 TypeScript error(s). First: ..."],
  "durationMs": 2175
}
```

`output` is the tail of each gate's combined stdout+stderr, capped at 4000
characters so the file stays readable.

`nextActions` is empty on GREEN. On RED it is an ordered list of the smallest
next moves, phrased as instructions — that field is what an agent driving the
loop should act on.

## Watch mode

`--watch` re-runs everything on any change to a `.ts/.tsx/.js/.mjs/.cjs/.json/
.svg/.css/.html` file, debounced 250ms, ignoring `node_modules`, `.git`, `dist`,
`*.actual.svg`, and `status.json` itself (so the loop can't retrigger on its own
output). Changes that arrive mid-run queue exactly one follow-up run. Ctrl-C
exits with the last verdict's code.
