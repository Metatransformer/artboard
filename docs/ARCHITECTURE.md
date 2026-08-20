# Architecture

How Artboard is put together, and the handful of rules that keep it from rotting.

This document describes the code that exists today. Anything specified but not yet
implemented is marked **[not yet built]**.

---

## 1. Package graph

Every arrow is a compile-time dependency. There are no cycles, and nothing points
back up.

```
                          ┌──────────────────────┐
                          │  @artboard/schema    │   zod only
                          │  ──────────────────  │
                          │  Document, Artboard, │   the file format,
                          │  Node, Fill, Stroke, │   the parser, migrations,
                          │  Shadow, Diagnostic  │   the integrity check
                          └──────────┬───────────┘
                                     │
                 ┌───────────────────┼────────────────────┐
                 │                   │                    │
    ┌────────────▼──────────┐        │        ┌───────────▼───────────┐
    │   @artboard/engine    │        │        │  @artboard/commands   │
    │   ─────────────────   │        │        │  ──────────────────   │
    │   layoutText          │        │        │  apply / invert       │
    │   metricMeasurer      │        │        │  commit / undo / redo │
    │   corners / aabb      │        │        │  StaleCommandError    │
    │   hitTest / objectFit │        │        └───────────┬───────────┘
    │   round / snap        │        │                    │
    └────────────┬──────────┘        │                    │
                 │                   │                    │
                 │     ┌─────────────▼──────────┐         │
                 └────►│  @artboard/render-svg  │         │
                       │  ────────────────────  │         │
                       │  renderArtboard  → data│         │
                       │  serialize       → text│         │
                       │  renderToString        │         │
                       └───────────┬────────────┘         │
                                   │                      │
              ┌────────────────────┼──────────────────────┘
              │                    │
   ┌──────────▼─────────┐  ┌───────▼────────────┐  ┌────────────────────┐
   │  apps/studio       │  │  packages/cli      │  │ packages/templates │
   │  React editor      │  │  headless renderer │  │ starter documents  │
   │  mounts the scene  │  │  serializes it     │  │ + size presets     │
   │  into the DOM      │  │  golden runner     │  │                    │
   └────────────────────┘  └────────────────────┘  └────────────────────┘
```

| Package | Depends on | Knows about |
|---|---|---|
| `@artboard/schema` | `zod` | nothing else in the repo |
| `@artboard/engine` | `@artboard/schema` (types only) | geometry and text metrics |
| `@artboard/render-svg` | `schema`, `engine` | how to turn geometry into SVG elements |
| `@artboard/commands` | `@artboard/schema` (types only) | document mutation and history |
| `@artboard/templates` | nothing (emits plain objects) | starter designs and artboard size presets |
| `apps/studio` | all five | DOM, React, user intent |
| `packages/cli` | `schema`, `render-svg` | files, stdout, exit codes |

`@artboard/engine` imports `@artboard/schema` for **types only**. It never calls the
parser, never constructs a `Document`, and has no idea what a file is.

`@artboard/commands` never imports the engine or the renderer. Mutating a document
and drawing a document are separate concerns that happen to share a type.

---

## 2. The rule that makes it work

> **The engine owns all geometry. Renderers only paint.**

Every number that requires a decision is computed in `@artboard/engine` and handed
to the renderer as a finished value. The renderer's job is to translate finished
values into markup.

Concretely, the engine owns:

| Concern | Engine function |
|---|---|
| Where each line of text breaks, and how wide it is | `layoutText` |
| How wide a string is in a given font | `metricMeasurer` (or an injected `Measurer`) |
| Where the rotated corners of a box land | `corners`, `aabb` |
| Whether a point is inside a rotated node | `hitTest` |
| Which part of an image survives a `cover` / `contain` fit | `objectFit` |
| Rounding, so floats are stable across platforms | `round` |
| Grid snapping | `snap` |

### Why a renderer that measures text is a bug

There is one renderer today (`@artboard/render-svg`) and it runs in two places: the
browser, where its output is mounted into the DOM, and Node, where its output is
serialized to a string. Those two environments do not agree about fonts. The
browser has the user's installed fonts, a font cache, subpixel hinting and a live
`CanvasRenderingContext2D`. Node has none of that.

The moment a renderer measures anything, those two environments produce different
geometry from the same document, and you have invented the parity problem that this
whole design exists to avoid: the editor shows one thing, the export produces
another, and the golden tests validate neither.

So measurement lives behind one seam, the `Measurer` interface:

```ts
export interface Measurer { (text: string, node: TextNode): number; }
```

`metricMeasurer` is the deterministic default. It is a character width table scaled
by font size and weight. It never touches the OS, never asks the browser, and
returns the same number on every machine. The editor may inject a
browser-backed measurer for on-screen fidelity; **golden tests always use
`metricMeasurer`**, which is why they are trustworthy.

If you find yourself reaching for `getComputedTextLength()`, `measureText()`, or
`getBBox()` inside `packages/render-svg`, stop. The number you want belongs in the
engine, behind a `Measurer` or a new pure function.

### The renderer emits data, not a string

`renderArtboard()` returns a `SceneNode` tree:

```ts
export interface SceneNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SceneNode[];
  text?: string;
  nodeId?: string;   // the document node this element came from
}
```

That is the single artefact both consumers share:

* **Studio** walks the tree and creates DOM elements. Because every element carries
  `nodeId`, selection and hit-testing come for free from the browser's own event
  target.
* **CLI** passes the same tree to `serialize()`, which produces indented SVG text.

There is exactly one code path that decides what a document looks like. "What you
see" and "what you export" are the same function called twice.

---

## 3. The open pipeline

Opening a file is a sequence of narrowing stages. Each stage either produces a
stricter value than it received or fails in a way the user can act on. The stages
that run inside `@artboard/schema` are `parseDocument` and `loadDocument`.

```
  raw string
     │
     ├─(1) JSON.parse ────────────── fail ──► DocumentParseError("unreadable")
     ▼
  unknown JSON
     │
     ├─(2) version probe ─────────── newer ─► readOnly = true
     │                                        + Diagnostic VERSION_NEWER
     ▼
  versioned JSON
     │
     ├─(3) migrate() ─────────────── forward-only, additive, never throws
     ▼
  current-shape JSON
     │
     ├─(4) Document.safeParse ────── fail ──► DocumentParseError(first 3 issues)
     ▼
  Document  (typed, defaults filled)
     │
     ├─(5) integrity walk ────────── dangling asset ─► Diagnostic ASSET_MISSING
     │                                                  (error level, NOT a throw)
     ▼
  OpenResult { doc, readOnly, diagnostics }
     │
     ├─(6) resolve ───────────────── per-node asset lookup at render time
     │                               missing ─► Diagnostic + visible placeholder
     ▼
     ├─(7) layout ───────────────── engine.layoutText per text node
     │                               over budget ─► truncate + TEXT_TRUNCATED
     ▼
     └─(8) paint ────────────────── SceneNode tree + diagnostics
```

### Stage by stage

**(1) Parse.** `JSON.parse` in a `try`, and the only thing caught is turned into a
named `DocumentParseError` carrying the syntax message. A damaged file gets a
sentence a human can read, not a stack trace.

**(2) Version probe.** Runs *before* validation, because a file from the future will
almost certainly fail validation, and "your file is damaged" would be a lie. If
`version > SCHEMA_VERSION` the document is flagged `readOnly` and a `VERSION_NEWER`
diagnostic is attached. The user can look at their design; they cannot save over it
and silently destroy the parts this build does not understand.

**(3) Migrate.** `migrate()` is forward-only and additive. It never removes a field
and never down-migrates. It takes `unknown`, returns `unknown`, and does not throw:
a migration that cannot understand its input passes it through and lets stage 4
produce the error message.

**(4) Schema validation.** One `safeParse` against the Zod `Document`. This is where
defaults are materialised, so every consumer downstream sees a fully populated node
and never writes `node.opacity ?? 1`. On failure, the first three issues are joined
into the error, path included. Three, because a truncated list a human reads beats a
complete list a human skips.

**(5) Integrity.** A full `walk()` over every node in every artboard. An `image` node
pointing at an `assetId` that is not in `doc.assets` produces an `error`-level
`ASSET_MISSING` diagnostic. It does **not** throw. A design with one broken image is
still a design worth opening, and the user is told exactly which node is broken.
(`DocumentIntegrityError` exists as a named error for callers that want the stricter
posture.)

**(6-8) Resolve, layout, paint** happen inside `renderArtboard()` and produce a
second stream of diagnostics, this one per render rather than per open. Rendering
never throws for content reasons: a missing asset draws a dashed "Missing image"
placeholder, over-long text is truncated, an unknown node kind is skipped. The
render's `diagnostics` array is how it says so.

The consistent rule: **structural damage throws, content damage is reported.**

---

## 4. The command layer

`@artboard/commands` is the only way a document changes. It has three moving parts.

### `apply(doc, cmd) -> Document`

Pure and immutable. Never mutates its input, returns a new document with structural
sharing (untouched artboards and untouched nodes keep their identity, which is what
makes React re-rendering cheap).

```ts
export type Command =
  | { type: 'addNode';     artboardId: string; node: Node; index?: number }
  | { type: 'removeNode';  artboardId: string; nodeId: string; ... }
  | { type: 'updateNode';  nodeId: string; patch: Record<string, unknown>; ... }
  | { type: 'reorder';     artboardId: string; nodeId: string; to: number; ... }
  | { type: 'setArtboard'; artboardId: string; patch: Record<string, unknown>; ... }
  | { type: 'addAsset';    asset: {...} }
  | { type: 'batch';       label: string; commands: Command[] };
```

`batch` is a plain `reduce` over `apply`, so a drag that moves eight nodes is one
command, one history entry, and one undo.

### `invert(doc, cmd) -> Command`

Given the document **before** `cmd` was applied, produce the command that undoes it.
The inverse is always the same shape as a forward command, which is the whole trick:

| Command | Inverse |
|---|---|
| `addNode` | `removeNode` with the same id |
| `removeNode` | `addNode` with the node and its original index, read out of `doc` |
| `updateNode` | `updateNode` with the *old* values of exactly the patched keys |
| `reorder` | `reorder` back to the index it currently occupies |
| `setArtboard` | `setArtboard` with the old values of the patched keys |
| `addAsset` | no-op batch (assets are content-addressed and never garbage-collected) |
| `batch` | a batch of the inverses, in reverse order |

### Undo/redo falls out of this

There is no separate undo machinery. `History` is two stacks of commands:

```ts
export interface History { past: Command[]; future: Command[]; }
```

`commit()` computes the inverse *first* (while the old document is still in hand),
applies the forward command, pushes the inverse onto `past`, and clears `future`.
`undo()` pops from `past`, inverts it to get the redo command, applies it, and
pushes the redo onto `future`. `redo()` is the same in the other direction.
`past` is capped at `MAX_HISTORY = 500`.

Because both directions are just "invert then apply", undo and redo are the same
twenty lines and cannot drift apart.

### Why `StaleCommandError` exists

An inverse command is captured against a specific document state. Time passes.
Another command runs. A collaborator's change lands. A template is applied. By the
time the user presses ⌘Z, the node that command talks about may no longer exist.

Without a named error, that is a silent no-op or a crash: `nodes.findIndex()`
returns `-1`, `splice(-1, 1)` removes the *last* node, and the user watches an
unrelated element disappear. That is data loss caused by an undo.

So every lookup that can miss throws `StaleCommandError(nodeId)` instead of
guessing. And `undo()`/`redo()` catch precisely that class:

```ts
catch (e) {
  if (e instanceof StaleCommandError) return { doc, history: { past: history.past.slice(0, -1), future: [] } };
  throw e;
}
```

A stale entry is dropped from the stack, the document is left alone, and any other
error propagates. The user's worst case is "that undo did nothing", never "that undo
deleted something else".

This is also the pattern the whole repo follows: **no bare catch, and every error
class has a name**, so a handler can be specific about what it is willing to
swallow.

---

## 5. `doc.diagnostics[]` is part of the schema

`diagnostics` is not a logger, not a dev-mode affordance, and not a side channel. It
is a field on `Document`, validated by Zod like any other:

```ts
export const Diagnostic = z.object({
  level: z.enum(['info', 'warn', 'error']),
  code: z.string(),
  nodeId: z.string().nullable().default(null),
  message: z.string(),
});
```

Codes currently emitted:

| Code | Level | Emitted by | Meaning |
|---|---|---|---|
| `VERSION_NEWER` | warn | `loadDocument` | file is from a newer build; opened read-only |
| `ASSET_MISSING` | error | `loadDocument`, `renderArtboard` | an `image` node references an absent asset |
| `TEXT_TRUNCATED` | warn | `renderArtboard` | text exceeded `MAX_TEXT_CHARS` and was cut |
| `NODE_UNKNOWN` | info | `renderArtboard` | an `opaque` node was preserved but not drawn |

### Why this makes silent visual corruption impossible

The failure mode that ruins a design tool is not the crash. It is the export that
succeeds and is subtly wrong: the missing logo, the headline that lost its last
word, the shape from a newer version that simply is not there. Nothing errored.
Nobody noticed until it was printed.

Every path in this codebase that would produce a wrong-but-plausible pixel is
required to append a diagnostic instead of shrugging. The renderer draws a
conspicuous dashed placeholder for a missing image *and* records
`ASSET_MISSING`. The layout truncates over-budget text *and* records
`TEXT_TRUNCATED`. An `opaque` node is skipped *and* records `NODE_UNKNOWN`.

That converts an invisible problem into a value you can assert on:

* Studio surfaces `doc.diagnostics` in the UI, so the user sees the problem before
  the client does.
* The CLI can exit non-zero when a render produces `error`-level diagnostics, which
  makes "this design is intact" a **CI check** rather than a hope. A brand template
  whose asset went missing fails the build the same way a type error does.

If you add a code path that can silently draw the wrong thing, it is incomplete
until it also pushes a diagnostic.

---

## 6. Forward compatibility: `opaque` nodes

The version-skew problem: a colleague on a newer build adds a node kind that does
not exist yet in yours. You open the file, move one text box, save. What happened to
their work?

In most formats, it is gone. The parser did not recognise the node, dropped it, and
the save wrote back what the parser understood.

Artboard preserves it verbatim:

```ts
/** Forward-compatibility: an unknown node kind is preserved verbatim, never dropped. */
export const OpaqueNode = z.object({
  ...NodeBase,
  kind: z.literal('opaque'),
  originalKind: z.string(),
  raw: z.unknown(),
});
```

An unknown node keeps its `NodeBase` fields (id, position, size, rotation, opacity,
visibility, lock), so it still occupies space in the layer list and still round-trips
its transform. `originalKind` records what it claimed to be. `raw` holds the entire
original object, untouched, as `unknown`, which is exactly the point: this build does
not interpret it, so it cannot corrupt it.

The renderer skips it and files an `info`-level `NODE_UNKNOWN` diagnostic explaining
that it is preserved on save but not drawn. On save it is re-serialized from `raw`.

Combined with the read-only flag from stage 2, a newer file opened in an older build
degrades in the safe direction: you can look, you are told what you cannot see, and
you cannot destroy what you do not understand.

### What is implemented, and the one piece that is not

An `opaque` node that already exists in a document is a full schema citizen today. It
validates, round-trips through save, renders as a diagnostic rather than a hole, and
is covered by tests.

**The coercion step is missing.** Nothing in `migrate()` or `loadDocument()` rewrites
an *unrecognised* `kind` into an `opaque` node, so a document containing one fails
schema validation outright:

```
$ artboard info newer.artboard.json
error DocumentParseError: Document is damaged: artboards.0.nodes.0.kind:
  Invalid discriminator value. Expected 'text' | 'rect' | ... | 'opaque' | 'group'
```

That is the wrong failure. The mechanism is in place and the policy is decided; the
step that connects them is not written yet. The fix belongs in `migrate()`, before
validation: walk the node tree, and rewrite any node whose `kind` is not in the known
set into `{ ...NodeBase fields, kind: 'opaque', originalKind: kind, raw: original }`.
Doing it in `migrate` rather than in a Zod `preprocess` keeps the transformation
inspectable and testable on its own.

Until that lands, forward compatibility protects a file that has already been through
a build that knows about `opaque`, and not a file from a build that adds a brand new
kind. Tracked in §8.

---

## 7. Determinism contract

Golden tests compare `serialize(renderArtboard(...))` against a checked-in `.svg`
fixture, byte for byte. That is only worth doing if the same input always produces
the same bytes. The following are hard requirements on any code reachable from a
render:

| Rule | Why | Where it is enforced today |
|---|---|---|
| No `Math.random()` in a render path | Random output cannot be diffed | `uid()` uses `Math.random`, and it lives in `commands`, never called during render. Ids come from the document. |
| No `Date`, `Date.now()`, timezones, or locale | Fixtures would rot overnight | No time source is imported by `engine` or `render-svg` |
| No OS font resolution in the measurer | The same file must lay out identically on macOS, Linux and CI | `metricMeasurer` is a static width table |
| Generated ids are stable and reset per render | `<defs>` ids appear in the output | `renderArtboard` sets `idSeq = 0` on entry; ids are base-36 counters (`grad-0`, `clip-1`, `sh-2`) |
| All emitted floats go through `round()` | IEEE noise differs across platforms | `round(n) = Math.round(n * 100) / 100`, applied at every coordinate |
| Attribute order is insertion order | Object key order is the serialization order | `serialize` iterates `Object.entries(attrs)` |
| No iteration over unordered collections | `Object.keys` order on a `Record` is insertion-dependent | Nodes live in arrays; `doc.assets` is only ever looked up by key |
| No network, no filesystem, no environment reads | A render must be a pure function of the document | Neither `engine` nor `render-svg` imports `node:*` or `fetch` |

Two consequences worth spelling out:

* **The measurer is an injected seam, not a fallback.** `renderArtboard` accepts
  `opts.measure`. Studio may pass a browser-backed measurer for fidelity. Anything
  that produces a golden fixture must pass `metricMeasurer` (the default), or the
  fixture records the CI machine's font stack instead of the document.
* **`idSeq` is module-global and reset at the top of `renderArtboard`.** Renders are
  synchronous and cannot interleave, so this is safe today. Making rendering
  concurrent or `async` would break determinism, and the counter would have to move
  into a per-render context.

---

## 8. Known gaps in the current implementation

Accurate as of `SCHEMA_VERSION = 1`. These are limits of the code as written, not
design intent.

* **An unrecognised node `kind` is not coerced to `opaque`.** It fails
  `Document.safeParse` and surfaces as `DocumentParseError`, so the whole document
  refuses to open. See §6 for the fix. This is the highest-value gap on the list,
  because it is the one that costs a user their colleague's work.
* `removeNode` and `reorder` operate on an artboard's top-level `nodes` array. A node
  nested inside a `group` cannot be removed or reordered by those commands.
  `updateNode` does recurse into groups.
* A `group` node's own `x`/`y`/`width`/`height` are not applied as a transform to its
  children. Children carry absolute artboard coordinates. The group wrapper applies
  only rotation, opacity and shadow.
* `hitTest` tests the rotated bounding box. Hit-testing an `ellipse` or a `path` is
  not shape-accurate.
* `LayoutBudgetExceededError` is exported by the engine but never thrown.
  `layoutText` truncates at `MAX_TEXT_CHARS` (20000) and reports `TEXT_TRUNCATED`
  instead.
* `Fill` supports solid, linear gradient, and none. There is no radial gradient and
  no image fill.
* Text is styled per node. There is no per-character or per-run styling, and no
  text-on-path.
* `objectFit` returns the full source rect for `contain`, so a `contain` image is
  scaled to the node width rather than letterboxed inside the node box.
* `invert` of `addAsset` is a no-op, so assets accumulate in a document across
  undo/redo. Nothing garbage-collects `doc.assets`.

---

## 9. Not yet built

| Area | Status |
|---|---|
| `apps/studio` | Toolbar, left panel, canvas and inspector exist; the editor is under active development |
| `packages/cli` | `validate`, `render`, `golden`, `info` all work |
| `packages/templates` | 22 templates, 12 size presets |
| `tests/`, `tools/gauntlet` | golden fixtures, unit tests, and the build loop exist |
| Electron desktop shell | specified in [SECURITY.md](./SECURITY.md), not implemented |
| SVG import and its allowlist | specified in [SECURITY.md](./SECURITY.md), not implemented |
| AI command layer (bring-your-own-key) | specified in [SECURITY.md](./SECURITY.md), not implemented |
| PDF export | not implemented. Studio exports SVG, PNG, JPG and JSON; the CLI emits SVG |
| Raster export from the CLI | not implemented. Studio's PNG/JPG path rasterizes on a browser canvas, which Node does not have |
| Additional renderers (canvas, PDF) | not implemented. Any new renderer must obey §2: geometry from the engine, paint only |
