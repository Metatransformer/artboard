# Contributing to Artboard

Thanks for helping. This document covers the repo layout, the dev loop, the rules
that are not negotiable, and a step-by-step for the most common non-trivial change
(adding a node kind).

All contributions are made under the **MIT licence**. See [Licence and DCO](#licence-and-dco).

---

## Repo layout

```
artboard/
├── packages/
│   ├── schema/        @artboard/schema      the file format, parser, migrations, integrity
│   ├── engine/        @artboard/engine      ALL geometry: layout, transforms, hit testing
│   ├── render-svg/    @artboard/render-svg  document + geometry -> SVG scene graph
│   ├── commands/      @artboard/commands    immutable apply/invert, undo/redo history
│   ├── templates/     @artboard/templates   starter templates and artboard size presets
│   └── cli/           @artboard/cli         validate | render | golden | info
│       ├── bin/artboard.mjs                 launcher: registers tsx, imports src/main.ts
│       └── src/main.ts                      commands and exit codes
├── apps/
│   └── studio/        @artboard/studio      the React editor
│       └── src/
│           ├── components/  Toolbar, LeftPanel, Canvas, Inspector
│           ├── lib/         scene.tsx (mounts the scene graph), export.ts
│           └── state/       store.tsx (reducer over @artboard/commands)
├── tests/
│   ├── golden/        fixture .json + committed .svg baselines
│   ├── helpers.ts     seeded PRNG, fully-defaulted base documents
│   └── *.test.ts      vitest suites
├── tools/gauntlet/    the autonomous build loop
└── docs/              ARCHITECTURE.md, SECURITY.md
```

Dependencies run strictly one way and there are no cycles.
`schema` <- `engine` <- `render-svg`, with `commands` and `templates` off to the
side, and the app and CLI on top. The graph is drawn in
[docs/ARCHITECTURE.md §1](docs/ARCHITECTURE.md#1-package-graph).

There is **no build step for the packages**. They are TypeScript with
`"main": "src/index.ts"`, resolved by Vite aliases in the editor and by `tsx` in the
CLI. There is no `dist/` to keep in sync.

---

## Dev loop

Node 20 or newer.

```bash
npm install

npm run dev          # editor on http://localhost:5273, HMR
npm run typecheck    # tsc -b across the workspace. Must be clean.
npm test             # vitest
npm run golden       # re-render every fixture, diff against the committed SVG
npm run build        # production build of the editor
npm run build:demo   # single-file .html, everything inlined
npm run gauntlet     # the autonomous build loop
```

The CLI is runnable directly, which is usually faster than a test when you are
poking at rendering:

```bash
node packages/cli/bin/artboard.mjs info   tests/golden/smoke.json
node packages/cli/bin/artboard.mjs render tests/golden/smoke.json
node packages/cli/bin/artboard.mjs render tests/golden/smoke.json --out /tmp/x.svg
node packages/cli/bin/artboard.mjs --help
```

### The gauntlet is the gate

```bash
npm run gauntlet             # one pass, human-readable table
npm run gauntlet -- --json   # machine-readable, writes tools/gauntlet/status.json
npm run gauntlet -- --watch  # re-run on every source change, debounced
```

It runs three gates in a fixed order, always all three, so one run tells you
everything at once: `npm run typecheck`, `npm test`, then `artboard golden`.

**Exit 0 is GREEN and your change may be considered done. Exit 1 is RED and it may
not.** There is no "green except for a pre-existing failure". If you are handing back
a red tree, say so out loud in the PR and say why.

The full contract, including why golden SVG diffs are the right oracle for a design
tool and why screenshot comparison is not, is in
[tools/gauntlet/README.md](tools/gauntlet/README.md). Read it there rather than
trusting this summary.

### Before you open a PR

| | |
|---|---|
| `npm run gauntlet` | GREEN |
| The golden diff | either empty, or included in the PR and explained |
| The change actually works | you ran it: clicked it in the editor, or ran the CLI command and read the output |

That last row is the real bar. A passing test suite is evidence, not proof. If you
changed how something renders, look at the SVG.

As of this writing the tree is GREEN on all three gates. If a gate is red when you
start, it is red because of the change in front of you unless you can show otherwise.

---

## The golden-file workflow

`tests/golden/` holds a `.json` document and a committed `.svg` baseline per artboard.
`artboard golden` re-renders **every artboard of every fixture** and compares byte for
byte, after normalising line endings and trailing whitespace. Baselines are always
rendered with `inlineAssets: false`, so image nodes serialize as `asset:<id>` and
`data:` URIs never bloat a fixture.

Baselines sit next to their fixture, and a multi-artboard document gets one per
artboard:

```
tests/golden/smoke.json   ->  smoke.svg      (artboard 0)
                              smoke.a1.svg   (artboard 1)
                              smoke.a2.svg   (artboard 2)
```

An empty or missing fixture directory is `NoFixturesError` and exit 1. An oracle with
nothing to check is not a pass.

**Diagnostics are baselined too, in a `.diag` sidecar.** A render has two outputs: the
SVG, and what it has to say about the document. Only the first was ever compared, so a
warning could stop firing — or start saying something different — and every oracle in
the repo stayed green, because the warning was never part of what was compared. So the
non-error diagnostics of each artboard are written next to its baseline:

```
tests/golden/text-diagnostics.json  ->  text-diagnostics.svg
                                        text-diagnostics.diag
```

Three things about the file. It holds **level, code, node id and the full message** —
the message carries the substance (*which* font was substituted, *how* long the line
was), and a baseline that drops it goes green on a warning that has quietly started
saying something else. It is **deleted when the last diagnostic goes away** rather than
left behind claiming warnings that no longer fire, and a missing file means "none
expected". And it includes the **accessibility findings** from `checkArtboard`, pinned
at WCAG AA — those are the bulk of what this project can say about a document, and
until they landed here the only thing that ever ran them was a human typing `artboard
check`. Error-level diagnostics never reach the sidecar; they already fail the case.

**That last part couples the render oracle to `@artboard/diagnostics`, on purpose.** Move
a contrast threshold and every affected golden goes red. This is the intended behaviour —
an advisory change is exactly the kind that otherwise ships unnoticed — but it is written
down here so that nobody meets it for the first time while wondering why 13 baselines
went red on a commit that touched no renderer. Re-bake and read the diff like any other:
the `.diag` diff *is* the review of the threshold change.

This is the project's oracle. It exists because a rendering regression does not throw,
does not fail a type check, and does not look wrong in a unit test that only asserts
"an element was produced". It looks wrong in the artwork, six weeks later.

### When your change legitimately alters rendering

Many good changes move pixels: a layout fix, a new attribute, better rounding. The
workflow is:

```bash
npm run golden                 # see exactly what drifted, with a first-difference diff
```

Read that output first. `golden` writes the new render next to the baseline as
`<name>.actual.svg` (gitignored) so you can diff the whole file yourself:

```bash
diff -u tests/golden/smoke.svg tests/golden/smoke.actual.svg
```

**Confirm every drifted line is a change you meant to make.** This is the entire
point of the step. If a fixture you did not expect to touch also moved, you have
learned something important before your users did.

Then, and only then:

```bash
node packages/cli/bin/artboard.mjs golden --update    # or: npm run golden -- --update
git add tests/golden
```

`--update` reports `NEW`, `UPD` and `SAME` per case, so the summary line tells you how
many baselines you rewrote.

**`--update` will not bless a broken document.** A fixture that produces any
error-level diagnostic (a missing asset, say) is refused, no baseline is written, and
the run exits 1. You cannot accidentally freeze a corrupt document into the suite as
the expected result.

### Rules

1. **Never run `--update` to make a red build green.** Run it because you looked at
   the diff and it is correct. Updating a baseline you have not read is deleting a
   test.
2. **The SVG diff is reviewed in the PR like any other code.** Reviewers read it.
   `+ <rect x="40" y="40" rx="16"/>` is a reviewable statement about behaviour. A
   1200-line baseline churn with the message "update goldens" is not, and will be
   sent back.
3. **Explain the diff in the PR description.** One line: *"Text baselines shift by
   ~0.4px because the ascent factor moved from 0.8 to 0.79."*
4. **A baseline change with no rendering change in the diff is a bug.** It usually
   means non-determinism crept in. Find it. See the
   [determinism contract](docs/ARCHITECTURE.md#7-determinism-contract).
5. **Adding a fixture is cheap and welcome.** A new feature should arrive with one.
   Keep it minimal: the smallest document that exercises the thing.
6. **Some fixtures are deliberately wrong, and re-baking one can hide the finding.**
   `groups-and-shadow.json` holds groups whose stored `x/y/width/height` disagree
   with their children — `gr-nested` is stored 170 wide where its children span
   690..850 = 160. That is not sloppiness to tidy up; it is the only fixture
   covering the derived rotation pivot, and "correcting" it to match its children
   would leave that code unobserved while the oracle stayed green.

   The general hazard, which cost a review round here: a comment claiming *"no
   baseline moves"*, a baseline that moved, and the baseline updated to match are
   each defensible alone and together make the claim unfalsifiable. If you update a
   baseline, the claim it encodes has to be checkable somewhere the baseline is
   not — a unit test that goes red when the change is reverted, and a note saying
   which. Never leave the baseline as the only witness to its own correctness.

### Finding what the oracle never looks at

`artboard golden` proves the renderer draws today what it drew yesterday — but only
along paths some fixture actually walks. A feature with no fixture behind it is not
passing, it is **unobserved**, and a green oracle reads downstream as "checked". Three
regressions in this project shipped through exactly that gap.

```bash
node tools/golden-coverage.mjs
```

The checklist is derived from the schema by introspection, not hand-listed: add
`z.enum([...])` to a node and both values appear in the next run with nobody
remembering to update anything. Anything it cannot classify is printed under
UNCLASSIFIED rather than silently dropped.

Two things to know before reading the number:

- **It is a report, not a gate, and NOT a to-do list.** It always exits 0. It
  measures the *golden oracle's* reach; a value missing from it is unproven only if
  nothing **else** covers it. Someone audited all 21 unexercised values and every one
  resolved to an enum option sharing a code path or a branch already unit-tested —
  `visible=false`, gradient `radial` and `opaque` are in `render.test.ts`, `valign
  bottom` is asserted directly in `engine.test.ts`. Zero fixtures were worth writing.
  Check what else covers a line before writing a fixture for it; it took ten minutes
  for all 21.
- **Dimensions are keyed on the field, not on node kind × field.** `blend`, `rotation`
  and `flipX` live on `NodeBase` and are emitted by one shared path for every kind, so
  they count once. An earlier cut keyed them per kind, got 283 dimensions, and buried
  the seven real gaps under 200 entries like `ellipse.blend=hue` that were all true and
  all useless.

- **Dimension count is not path count, and the headline reports both.** `blend` has
  16 values behind a single line — `mix-blend-mode:${n.blend}`, read nowhere else — so
  counting values made it 14 of the 21 gaps and weighted a string interpolation above
  `group`, which is an entire `renderNode` arm and counts as one. Read
  `26/28 dimensions` as the honest headline; `53/74 schema values` is the finer grain
  and inflates wherever an enum is wide.

`FIXTURES PER NODE KIND` is the section worth watching, because each kind is a
different `renderNode` arm rather than a field on a shared path. `LOAD-BEARING` is the
same idea for fields, printing the fixture count rather than only flagging singletons —
a binary check cannot tell two fixtures from twenty. Both mark `!` where a single file
is holding a path up, but neither is automatically a job: `image` sits at one fixture
and three guards in `render.test.ts` go red if that fixture disappears, which is the
hazard already handled by something that is not a fixture.

That section used to be called `THIN`, which read as a judgement on the fixture named.
It is the opposite: a `1 fixture` row is usually a *strong* fixture standing alone, and
the fragility is structural. The fix is a second fixture, never an edit to the one
listed.

`DIAGNOSTIC CODES` answers a different question, and a sharper one. Everything else in
the report describes a dimension space read out of the schema — which is to say, things
that end up in the SVG. **A diagnostic does not.** It is a second output of the same
render, so no `.svg` baseline could hold it and no re-bake could notice one going
missing. That is not a dimension counted wrongly; it is a dimension the oracle could not
*represent*, which is strictly worse, because it is invisible rather than merely absent.

Both halves are now closed. The holding half is the `.diag` sidecar (above). The
reporting half is this section: which codes the corpus actually provokes, and which
exist only in source. A code with no fixture behind it is a message nobody has ever read
back — it can be deleted, reworded, or wired to nothing, and every oracle here stays
green. That is not hypothetical: `FONT_SUBSTITUTED` was raised by `layoutText` on every
unmeasured family, the `TextLayout` type documented it as *"Renderers forward these"*,
and `render-svg` did not. It reached nobody for the whole life of the feature, and the
only question that surfaced it was "which code has no fixture?".

The scanner is a regex over `code:` in package sources and is deliberately loud about
its own blind spot: `` code: `CONTRAST_${opts.level}` `` is a template literal it cannot
resolve, so it prints the expression under an explicit unresolved list and marks the
runtime-built code `~` rather than quietly reporting a smaller, cleaner, wrong number.
Same polarity as `UNCLASSIFIED`. A `~` row with no matching unresolved entry is the
surprising case worth chasing.

Prefer to extend the derivation over adding to `IGNORED`. The tool has been
mutation-tested — run against the fixture set with `render-features.json` removed via
`--dir`, coverage drops 53 → 44 and exactly that fixture's unique paths flip to
missing — so a false "covered" is the one thing it is known not to do. Keep it that
way: an exclusion that hides a real path re-creates the stale-allowlist bug the tool
exists to prevent.

### When a measurement disagrees with the renderer

Sooner or later you will build a harness — a browser screenshot, a font probe, a
measuring script — and it will disagree with the engine. Before you retune a constant,
read the *shape* of the disagreement, because the shape names the culprit:

- **Proportional error indicts the ruler.** A uniform 7.6% overshoot across strings of
  very different lengths cannot be kerning or rounding; nothing real scales that
  cleanly. It is one wrong factor somewhere in the instrument. This exact number came
  from a harness whose `@font-face` `file://` URL never loaded from an `about:blank`
  document — while `document.fonts.ready` resolved anyway, so the harness cheerfully
  measured a fallback face and reported the difference as a renderer bug. The engine
  was right the whole time; inlined as a data URI, the bundled woff2 measured `0.7456`
  against the metric table's `0.7456`.
- **Constant error indicts something being silently added.** A flat 55.4px across two
  strings of different lengths cannot be measurement — it is five space glyphs at size
  44. That one *was* a real, shipped bug: the serializer pretty-printed inside
  `<text xml:space="preserve">`, injecting the newline and indent as real characters.
  The editor's React path never emitted that whitespace, so the editor was correct and
  only the export was wrong, which is why no golden and no unit test could see it.

The corollary is a habit, not a rule: **an instrument that reports nothing is not
evidence until you have watched it report something.** A probe whose selector matches no
element and a codebase with no defects produce identical output. Run it against a known
bad input first — the control group is what separates the two.

### Your control must be a no-op *for the metric*, not just a different input

The control-group habit above has a failure mode of its own, and it is easy to walk
into: picking a control that looks like "no change" without checking that it is no
change *to the thing you are measuring*.

Measuring whether Magic Resize pulls neighbouring elements apart, the obvious control was
"resize every fixture to 540×540 and expect no movement". It lit up at 10×. The code was
fine — most fixtures are not square, so 540×540 was itself an aspect change and the
control was a second experiment. The control that works is **half of each fixture's own
size**: uniform aspect, every anchor class reduces to exactly ×0.5, so the excess must be
zero by construction. It reports `0.00px` across the corpus, and it reports the *count of
fixtures it examined* alongside — otherwise a probe that found no pairs at all prints the
same `0.00` as a probe that found many and cleared them all.

Both halves matter. A control that cannot distinguish "nothing wrong" from "nothing
looked at" is decoration.

### A threshold you cannot pin, you can bound

`tests` established that a test can be *threshold-independent* without being
*threshold-bounding*: choosing cases far from any boundary avoids pinning a number
reasonable people would set differently, but leaves it unconstrained in both directions —
a mutant that widened a centre band from 8% to 45% passed everything.

The same problem shows up when you have to *choose* the number. If the data contains a
natural break, take it and say so. If it does not, say that too, and then show that the
answer does not depend on the number: sweep it, and publish the range over which the
outcome is flat. Magic Resize's stack threshold is 10% of the frame, chosen because
tearing collapses by 8–10% and stops improving while over-clustering keeps climbing, so
anything in 10–12% behaves identically. Below 8% the value *is* load-bearing, and the
comment says which fixture proves it.

Two things make a sweep honest:

- **Report the failure mode on both sides.** A sweep that only counts the bug you are
  fixing always recommends the extreme. The stack sweep counts tearing *and* clumping —
  designs that stopped adapting and just sit in the frame as one block — because the cure
  and the disease sit at opposite ends of the same knob.
- **A knob at zero is a free control.** If the new behaviour is off at `0`, the zero row
  of the sweep reproduces the code you replaced, and the whole table has a fixed point you
  did not have to trust.

### "No fixture reaches this branch" means three different things

This came up three times in one day and meant something different each time. The
sentence is identical; the correct response is not, and pattern-matching one case
onto another is how a real gap gets waved through.

Ask one question first: **can you construct an input that makes the branch decide
something observable?**

1. **No — the corpus cannot answer the question.** The `valign` half of
   `textAware` fired on nothing. The control that settled it was forcing
   `y: 'top'` unconditionally, which *also* changed nothing across 120
   fixture/target combinations: the corpus could not distinguish any rule on
   that axis from any other. A zero there is a fact about the corpus, not about
   the code. Decide it on the argument and record that you did — and do not
   write a test, because the test will pin whichever answer you happened to
   pick and it will still be green long after the question closes the other way.

2. **Yes, and it is already decided correctly.** The stretch-stack guard was
   right, and the test written for it was never going to fail. Write it anyway:
   stating the mechanism out loud is what exposed a comment beside it claiming
   the guard prevented something it cannot prevent. A comment can never be red;
   the assertion that forces you to say why is the only thing that checks one.

3. **Yes, and nothing has ever exercised it.** `rotated && !uniform` is trivially
   reachable by construction — the corpus merely happens not to contain a
   rotated group in a resized page. That is an ordinary coverage gap. Build the
   case and pin it.

The trap is reading (3) as (1): "no fixture reaches it" sounds like "the question
is unanswerable here" and is usually just "nobody has written the fixture".

### Verify what you are about to commit, not what you were editing

`git add <path>` stages the file as of the add, not as of the change you made or
the tests you ran. In a worktree with more than one agent in it, those are
different files, and the gap between them is where a stray edit rides into main
wearing your commit message.

It happened here. A verification pass went green, `git add` ran a moment later,
and the commit carried `const STACK_GAP = 0.5` — a peer's mutation-testing
mutant, sitting on disk between the two steps — under a message describing a
documentation edit. The suite that had just passed had certified a different
version of the file than the one that shipped.

So: **run `git diff --cached` before every commit and read it.** Not the working
diff, the staged one. If the staged diff contains a line you cannot explain, stop
— that is the whole check, it costs seconds, and it needs no coordination with
anyone else's session.

Two corollaries worth keeping:

- **Order matters.** Verifying and then staging proves less than staging and then
  verifying. If a run is expensive, at minimum re-read the staged diff after it.
- **Guards protect the tree from losing work; almost nothing protects a commit
  from gaining it.** Every rule in this file about shared files — never `git
  restore` over a peer, assert before you replace, re-read after you write —
  defends work from being destroyed. The staged-diff read is the only one facing
  the other direction, and that is the direction this went.

### Look at the render at the size a person would

A 200px thumbnail is enough to see a layout tear and not enough to see anything else.
Reviewing a contact sheet of relaid designs, a subtitle under a credit line read as a
red string overlapping white text — a serious-looking overlap bug that evaporated at
full size, where it is just small grey type. Contact sheets are for choosing which one
to open. Open it before you file the defect.

### The golden output is an API

Treat the status labels (`PASS`, `FAIL`, `NEW`, `UPD`, `SAME`) and the exit codes
(`0`, `1`, `2`) as frozen. They are not just human output:
[`tools/gauntlet/loop.mjs`](tools/gauntlet/loop.mjs) parses the
`GOLDEN RED n of m drifted: a.json[0], b.json[1]` summary line to populate
`gates.golden.drifted` in `status.json`, falling back to the `FAIL` lines. Changing
the wording breaks the gauntlet's drift reporting silently, since a parser that
matches nothing reports no drift.

If you have to change it, update `loop.mjs` in the same commit.

---

## Code rules

These are not style preferences. Each one exists because its absence produced a real
class of bug.

### No bare catch. Name every error class.

```ts
// No.
try { doThing(); } catch (e) { /* whatever */ }
try { doThing(); } catch { return null; }

// Yes.
export class DocumentParseError extends Error {
  constructor(public detail: string) { super(`Document is damaged: ${detail}`); this.name = 'DocumentParseError'; }
}

try {
  json = JSON.parse(raw);
} catch (e) {
  throw new DocumentParseError(e instanceof SyntaxError ? e.message : 'unreadable');
}
```

A `catch` must either handle a specific, named class and rethrow the rest, or convert
what it caught into a named error carrying enough detail for a human. `undo()` in
`@artboard/commands` is the model:

```ts
catch (e) {
  if (e instanceof StaleCommandError) return { doc, history: { past: history.past.slice(0, -1), future: [] } };
  throw e;
}
```

It swallows exactly one thing, deliberately, and lets everything else through. A bare
catch there would turn "undo hit a stale node" and "the renderer is broken" into the
same silent no-op.

Every error class sets `this.name` and carries the structured data a caller needs
(`nodeId`, `path`, `refs`, `chars`), not just a string.

### The engine owns geometry. Renderers only paint.

Every number that required a decision comes from `@artboard/engine`. If you are
inside `packages/render-svg` and you want to know how wide a string is, where a line
breaks, where a rotated corner lands, or which part of an image survives a `cover`
fit, that function belongs in the engine.

Never call `measureText()`, `getBBox()`, or `getComputedTextLength()` from a
renderer. The browser and Node disagree about fonts, and the moment a renderer
measures, the editor and the CLI stop drawing the same document. Measurement goes
behind the `Measurer` seam, and the default `metricMeasurer` never touches the OS.

### No `Math.random()`, `Date`, or environment reads in a render path

Anything reachable from `renderArtboard()` must be a pure function of the document.
No randomness, no clock, no locale, no `process.env`, no filesystem, no network.
Generated ids are counters reset per render (`idSeq = 0`). `uid()` uses
`Math.random()` and lives in `@artboard/commands`, where it is called by user actions
and never during a render. Keep it that way.

Tests that need randomness use the seeded `mulberry32` PRNG in `tests/helpers.ts`, so
a failure reproduces from its seed.

### Immutable document updates only

Never mutate a `Document`, an `Artboard`, or a `Node` in place. Every change goes
through a `Command` and `apply()`, which returns a new document with structural
sharing.

```ts
// No.
node.x = 100;
doc.artboards[0].nodes.push(newNode);

// Yes.
const next = commit(doc, history, { type: 'updateNode', nodeId: node.id, patch: { x: 100 } });
```

Mutation breaks three things at once: undo (the inverse was captured against an
object you just changed underneath it), React (identity comparison sees nothing
happened), and reasoning (any reference to a document is now a reference to a moving
target).

### Anything that could draw the wrong thing must push a diagnostic

If a code path can produce a plausible-looking but wrong result (a missing asset, a
truncated string, a node it cannot draw, an element it stripped on import), it
appends to `doc.diagnostics` or the render's diagnostics array. Not a `console.warn`.
A structured `{ level, code, nodeId, message }`.

That is what lets the editor show the problem and the CLI fail CI. A silent wrong
pixel is the worst bug this project can ship.

**And a diagnostic nothing forwards is not a diagnostic.** If you raise one in a package
that returns it to a caller — the way `layoutText` returns `TextLayout.diagnostics` —
the raise is only half the work; the forward at every call site is the other half.
`FONT_SUBSTITUTED` sat un-forwarded by `render-svg` long enough to ship, with the
contract written in the type's own doc comment the whole time. The check that catches
this is `DIAGNOSTIC CODES` in `tools/golden-coverage.mjs`: give any new code a fixture
that provokes it, or accept that nothing will ever tell you it stopped working.

### Also

* `strict` and `noUncheckedIndexedAccess` are on. Handle the `undefined`; do not
  reach for `!` to make the error go away.
* Zod schemas own defaults. If a field has a default in the schema, downstream code
  reads it directly and does not write `?? fallback`.
* Keep runtime dependencies out of the core packages. `schema` depends on `zod`;
  `engine`, `render-svg` and `commands` depend on nothing.
* Comments explain **why**, not what. Match the density of the file you are in.

---

## How to add a new node kind

Worked example: a `star` node. Follow the same steps for any kind.

### 1. Schema: `packages/schema/src/index.ts`

Define the node, add it to the union, export its type.

```ts
export const StarNode = z.object({
  ...NodeBase, kind: z.literal('star'),
  points: z.number().int().min(3).default(5),
  innerRatio: z.number().min(0.05).max(1).default(0.5),
  fill: Fill.default({ kind: 'solid', color: '#f59e0b' }),
  stroke: Stroke.default({ color: '#000000', width: 0, dash: [] }),
});

export const Node: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    TextNode, RectNode, EllipseNode, LineNode, PathNode, ImageNode,
    StarNode,                                    // <- added
    OpaqueNode, GroupNode as any,
  ]) as any
);

export type StarNode = z.infer<typeof StarNode>;
```

Add it to the exported `Node` union type too.

**Give every new field a default.** A field without one is a breaking change to every
existing document.

**Do not bump `SCHEMA_VERSION` for an additive node kind.** Version bumps are for
changes that need a migration. A new kind needs the forward-compatibility path in
`migrate()` instead, so older builds degrade to `opaque` rather than refusing to open
the file (see [ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-forward-compatibility-opaque-nodes)).
If that coercion still is not implemented when you get here, implementing it is part
of your change.

### 2. Engine, only if it needs geometry: `packages/engine/src/index.ts`

If the kind needs anything computed (a point list, a fitted box, a text layout), it
goes here as a pure, deterministic function.

```ts
export function starPoints(b: Box, points: number, innerRatio: number): Array<[number, number]> { ... }
```

Skip this step if the renderer can draw the node from its existing box alone. Do not
skip it by putting the maths in the renderer.

### 3. Renderer: `packages/render-svg/src/index.ts`

Add a `case` to `renderNode`'s switch. Emit `SceneNode` data, never a markup string.
Run every coordinate through `round()`.

```ts
case 'star':
  inner = { tag: 'polygon', attrs: clean({
    points: starPoints(n, n.points, n.innerRatio).map(([x, y]) => `${round(x)},${round(y)}`).join(' '),
    fill: fillToPaint(n.fill, defs), ...strokeAttrs(n.stroke),
  }) };
  break;
```

Rotation, opacity and shadow are handled by the shared wrapper. You do not implement
them per kind.

### 4. Editor

| File | What to add |
|---|---|
| `apps/studio/src/components/Canvas.tsx` | a `case 'star':` in `makeNode()` returning a fully populated default node |
| `apps/studio/src/components/Toolbar.tsx` | a tool button, if the kind is drawn by dragging |
| `apps/studio/src/App.tsx` | its keyboard shortcut in the tool `map` |
| `apps/studio/src/components/Inspector.tsx` | a kind-guarded block of controls, following the existing `n.kind === 'rect'` pattern, each dispatching an `updateNode` patch |

The layers list in `LeftPanel.tsx` reads `kind` and `name` generically, so it needs
nothing. Neither does `lib/scene.tsx`: it mounts whatever tags the renderer emits.
If your node introduces an SVG attribute React spells differently (anything
hyphenated), add it to the `MAP` in `scene.tsx`.

### 5. Golden fixture

Add the smallest document that exercises it, ideally including rotation and a shadow
so the wrapper path is covered too.

```bash
cat > tests/golden/star.json <<'EOF'
{ "version": 1, "id": "doc_star", "name": "Star", "artboards": [ ... ] }
EOF

node packages/cli/bin/artboard.mjs render tests/golden/star.json   # eyeball it
node packages/cli/bin/artboard.mjs golden --update
git add tests/golden/star.json tests/golden/star.svg
```

Read the generated baseline before you commit it. It is the artefact the reviewer will
be reading.

### 6. Tests

At minimum:

* **Schema**: the node parses, defaults are applied, an out-of-range value is
  rejected.
* **Engine**: if you added a geometry function, its output for a known input,
  including a degenerate case (zero width, three points).
* **Render**: `renderToString` produces the expected tag and attributes, and a
  rotated or shadowed instance still gets the wrapper `<g>`.
* **Commands**: nothing kind-specific is usually needed; `updateNode` is generic.

### 7. Docs

Add the kind to the node table in [README.md](README.md#node-kinds). If it introduced
a limitation, add it to
[ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-known-gaps-in-the-current-implementation).

### The checklist

```
[ ] schema:      node object, union entry, exported type, defaults on every field
[ ] engine:      geometry as a pure function (or a deliberate "not needed")
[ ] render-svg:  a switch case emitting SceneNode data, coordinates via round()
[ ] studio:      makeNode default, tool + shortcut if drawable, Inspector controls
[ ] golden:      a fixture, and a baseline you have actually read
[ ] tests:       schema, engine, render
[ ] docs:        README node table
[ ] typecheck + test + golden all green
```

---

## Pull requests

### Scope

One change per PR. A rendering fix and a refactor of the file it lives in are two
PRs. Reviewers can only vouch for a diff they can hold in their head, and this
project's review depends on reading SVG baselines carefully.

### Commit messages

Present tense, imperative, and specific about the behaviour that changed.

```
render: use the parsed viewBox for path scaling instead of assuming 24x24

Path nodes with a non-default viewBox were drawn at the wrong scale because
the fallback ran before the node's own value was read. Golden baselines for
icon-grid.json shift accordingly.
```

Not `fix bug`, not `updates`, not `wip`.

### Description

Say what changed and why. If baselines moved, say which and why in one sentence. If
you decided against an obvious alternative, say so; it saves the reviewer asking.

### Review expectations

* Golden diffs are read line by line. Expect questions about them.
* A PR that touches `packages/schema` is a change to a file format people already
  have on disk. Expect it to be slow, and expect questions about forward and backward
  compatibility.
* Anything touching import, export, asset handling, or the desktop shell is read
  against [docs/SECURITY.md](docs/SECURITY.md). If your change makes one of the
  guarantees in that document untrue, the document has to change first, in its own
  PR, with the reasoning written down.

### Security issues

Do not open a public PR or issue for a vulnerability. Follow
[docs/SECURITY.md §10](docs/SECURITY.md#10-reporting-a-vulnerability).

---

## Licence and DCO

Artboard is MIT ([LICENSE](LICENSE)), and every contribution is accepted under the
same terms. There is no CLA to sign and no copyright assignment.

Contributions are certified under the **[Developer Certificate of Origin
1.1](https://developercertificate.org/)**. Sign off each commit:

```bash
git commit -s -m "render: use the parsed viewBox for path scaling"
```

which appends:

```
Signed-off-by: Your Name <you@example.com>
```

Signing off means you wrote the code, or you have the right to submit it under MIT.
Use your real name and a real email address.

### Do not paste in code you did not write

This matters more than usual here, because the licence is the product. Artboard is
MIT so that anyone can take it and do anything with it without reading a
compatibility matrix, and that promise holds only if **every file honours it**.

* Do not copy code from a GPL, AGPL, MPL, or source-available project. That includes
  MPL-2.0 (Penpot) and the tldraw licence. MPL is file-level copyleft: a single MPL
  file makes "this project is MIT" false, permanently, and it cannot be relicensed.
* Do not paste from a Stack Overflow answer, a blog post, or a gist without checking
  its licence.
* If you used an AI assistant, you are still the one certifying provenance under the
  DCO. Review what it produced.
* Adding a runtime dependency to a core package is a design decision, not a
  convenience. Raise it in an issue first, with its licence and its transitive
  footprint.

If you are unsure whether something is safe to include, ask in an issue before you
open the PR. It is a much cheaper conversation than the one after a merge.
