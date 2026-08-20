# Artboard

A local-first, MIT-licensed design editor. Runs in your browser or on your desktop.
Your files never leave your machine.

There is no account, no server, no sync, and no upload. A design is a JSON file on
your disk. You can open it, diff it, commit it, script it, and render it from a
terminal.

> **Status: early.** `v0.1.0`. The schema, engine, renderer, command layer and CLI
> are working. The editor UI and the template library are in progress. See
> [Roadmap](#roadmap).

---

## What this is not

Canva has a hundred million stock photos, a template for every occasion, a brand kit
team, and a video editor. Artboard is not going to beat any of that, and pretending
otherwise would waste your time.

Artboard competes on four things Canva structurally cannot offer, because its
business depends on the opposite.

| | |
|---|---|
| **An open, git-diffable file format** | A design is `.artboard.json`: plain, readable, stable JSON. `git diff` shows you that the headline changed from 28px to 32px. Code review works on designs. No proprietary binary, no vendor lock, no export-to-leave. |
| **Bring your own key AI** | Point Artboard at your own model provider key. You are the customer of that provider, not the product of ours. There is no per-seat AI upsell, because there is no seat and no us. |
| **No paywalled exports** | SVG, PNG, JPG and the raw JSON, at any resolution, free, forever. Nothing is watermarked. Nothing is gated behind a plan. The most infuriating moment in a hosted design tool is finishing your work and discovering that downloading it costs money. That moment does not exist here. |
| **A CLI that renders in CI** | `artboard render poster.artboard.json --out poster.svg` produces deterministic, byte-stable SVG. Generate a hundred localised variants in a build step. Regenerate every social card when the brand colour changes. Fail the build when a template's logo goes missing. |

If you need a million templates, use Canva. If you need your design system to be a
reviewable, scriptable, permanently readable artefact that you own, keep reading.

---

## Quick start

Requires Node 20 or newer.

```bash
git clone <this-repo> artboard
cd artboard
npm install
npm run dev          # editor on http://localhost:5273
```

Other scripts:

```bash
npm run typecheck    # tsc -b across the whole workspace
npm test             # vitest
npm run golden       # re-render every fixture, diff against the committed SVG
npm run build        # production build of the editor
npm run build:demo   # single-file .html build, everything inlined
```

---

## Architecture

Five packages with a strict, acyclic dependency order.
[`@artboard/schema`](packages/schema) owns the file format: the Zod document schema,
the open pipeline, migrations and the integrity check, and it depends on nothing else
in the repo. [`@artboard/engine`](packages/engine) owns **all** geometry: text layout
and line breaking, rotated-box corners and bounding boxes, hit testing, object-fit,
rounding and snapping, and it imports the schema for types only.
[`@artboard/render-svg`](packages/render-svg) turns a document plus the engine's
geometry into a scene graph. [`@artboard/commands`](packages/commands) is the only
way a document changes: immutable `apply`/`invert` with undo and redo falling out of
the inverse. On top sit [`apps/studio`](apps/studio), the React editor, and
[`packages/cli`](packages/cli), the headless renderer, and
[`@artboard/mcp`](packages/mcp), the same model over MCP for agents.

### The key insight

**There is one renderer, and it emits an SVG scene graph as data.**

`renderArtboard()` does not produce a string. It produces a tree of
`{ tag, attrs, children, nodeId }`. The editor walks that tree and mounts it into the
DOM, so the browser paints it and hit-testing comes free from real event targets. The
CLI hands the identical tree to `serialize()` and gets deterministic SVG text.

One code path decides what a document looks like. "What you see" and "what you
export" are the same function called twice, so there is no parity problem to manage,
no second rendering backend to keep in sync, and no class of bug where the preview is
right and the export is subtly wrong.

The rule that keeps it that way: **the engine owns all geometry, renderers only
paint.** A renderer that measures text has reintroduced the parity problem, because
Node and the browser do not agree about fonts. Measurement lives behind one injected
`Measurer` seam, and its default (`metricMeasurer`) is a static width table that
never touches the OS. That is what makes golden tests trustworthy.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Features

Everything listed here exists in the schema and renders today.

### Node kinds

| Kind | Notes |
|---|---|
| `text` | Multi-line, word wrapped by the engine, with horizontal and vertical alignment |
| `rect` | Corner radius, fill, stroke |
| `ellipse` | Fill, stroke |
| `line` | Stroke only, round caps |
| `path` | SVG path data with its own `viewBox`, scaled to the node box |
| `image` | References an embedded asset, with `cover` / `contain` / `fill` and corner radius |
| `group` | Nested children, drawn as a unit |
| `opaque` | A node kind this build does not know. Preserved verbatim, never dropped ([why](#forward-compatibility)) |

### Every node has

`x`, `y`, `width`, `height`, `rotation` (degrees, about the node's centre), `opacity`,
`visible`, `locked`, `name`, and an optional drop `shadow`.

### Fills

| Type | Fields |
|---|---|
| `solid` | `color` (3, 6 or 8 digit hex, so alpha is supported) |
| `gradient` | Linear. `angle` in degrees plus two or more `stops` of `{ offset, color }` |
| `none` | No paint |

Artboard backgrounds take the same `Fill`, so a gradient background is a gradient
fill.

### Strokes

`color`, `width`, and a `dash` array, on `rect`, `ellipse`, `line` and `path`.

### Shadows

A drop shadow per node: `x`, `y`, `blur`, `color` (alpha hex works, and the default is
`#00000033`). Rendered as an SVG `feDropShadow` filter.

### Text controls

| Control | Values |
|---|---|
| `fontFamily` | Any family name. Studio ships Inter, Playfair Display, Space Grotesk, DM Serif Display, JetBrains Mono |
| `fontSize` | Points |
| `fontWeight` | Numeric, 100 to 900 |
| `italic` | Boolean |
| `lineHeight` | Multiplier, minimum 0.5 |
| `letterSpacing` | Absolute units, positive or negative |
| `align` | `left`, `center`, `right` |
| `valign` | `top`, `middle`, `bottom` |
| `uppercase` | Transform applied at layout time, so the underlying text is preserved |
| `color` | Hex |

Word wrapping, line breaking and vertical block positioning are computed by the
engine, identically in the browser and in CI.

### Documents

Multiple artboards per document, each with its own size, name and background. Assets
are embedded in the document as content-addressed data URIs, so a `.artboard.json` is
self-contained: no relative paths, no missing-image-on-someone-else's-machine, and
nothing that could point at a file on your disk.

### Templates and size presets

[`@artboard/templates`](packages/templates) ships 22 starter templates and 12
artboard size presets.

Templates are grouped by `CATEGORIES`, a curated picker order rather than an
alphabetical one: **Social, Story, Presentation, Poster, Marketing, Business**.

Size presets carry their **own, separate** taxonomy (Social, Video, Presentation,
Print, Brand, Screen). The two lists are not the same and are not meant to line up:

| Preset | Size | Preset | Size |
|---|---|---|---|
| Instagram Post | 1080 x 1080 | Presentation | 1920 x 1080 |
| Instagram Story | 1080 x 1920 | A4 Poster | 2480 x 3508 |
| Facebook Post | 1200 x 630 | Business Card | 1050 x 600 |
| Twitter/X Post | 1600 x 900 | Flyer | 1275 x 1650 |
| LinkedIn Banner | 1584 x 396 | Logo | 800 x 800 |
| YouTube Thumbnail | 1280 x 720 | Desktop Wallpaper | 1920 x 1080 |

A template is a `build()` function, not a stored document. It returns the artboard
body only, and the caller wraps it:

```ts
import { TEMPLATES, getTemplate } from '@artboard/templates';
import { loadDocument } from '@artboard/schema';

const t = getTemplate('social-gradient-launch')!;
const { width, height, background, nodes } = t.build();

const { doc } = loadDocument({
  version: 1, id: 'doc_1', name: t.name,
  artboards: [{ id: 'ab_1', name: t.name, width, height, background, nodes }],
  assets: {}, diagnostics: [],
});
```

`build()` is required to be deterministic: no `Math.random()`, no `Date.now()`, and
node ids prefixed with the template id, so calling it twice returns byte-identical
JSON. That is what lets templates be golden-tested like anything else.

No template ships an image node, so no template carries an asset. Fonts are limited
to the five the editor loads: Inter, Playfair Display, DM Serif Display, Space
Grotesk, JetBrains Mono.

The package exports `TEMPLATES`, `CATEGORIES`, `PRESET_SIZES`, `getTemplate(id)` and
`templatesInCategory(category)`.

Twenty-two is not a million, and that is the point. This is a starting set, not the
product.

### Export

| Format | Where | How |
|---|---|---|
| SVG | editor, CLI | The renderer's own output, serialized |
| PNG | editor | The same SVG rasterized on a canvas, 2x by default, capped at 500 megapixels |
| JPG | editor | As PNG, composited on white, quality 0.92 |
| `.artboard.json` | editor | The document itself, pretty-printed |

No watermark, no resolution cap short of the memory budget, no plan gate.

### Diagnostics

`doc.diagnostics[]` is a schema field, not a log. Anything that could produce a
wrong-but-plausible result records a structured entry instead of failing quietly: a
missing asset, text that hit the layout budget, a node kind this build cannot draw.
The editor shows them and the CLI exits non-zero on `error`-level entries, which
turns "this design is intact" into a check CI can run.

### Forward compatibility

A document from a newer build opens read-only, with a `VERSION_NEWER` diagnostic, so
you cannot overwrite what you cannot see. Node kinds an older build does not
understand are carried as `opaque` nodes: the original object is stored untouched,
re-serialized on save, and reported rather than dropped.

One caveat, honestly stated: the `opaque` node kind is fully implemented and
round-trips, but the step that *converts* an unrecognised `kind` into one is not
written yet, so a document containing a brand new kind currently fails to open rather
than degrading. See
[ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-forward-compatibility-opaque-nodes).

### Not in the schema today

No radial gradients, no image fills, no per-character text styling, no text on a
path, no blend modes, no boolean path operations, no components or symbols, no
multi-user editing. Hit testing uses the rotated bounding box rather than the exact
shape.

---

## The `.artboard.json` format

A document is JSON. Fields with schema defaults can be omitted, which is why real
files stay small and readable. This is
[`tests/golden/smoke.json`](tests/golden/smoke.json), unedited:

```json
{
  "version": 1,
  "id": "doc_smoke",
  "name": "Smoke",
  "artboards": [
    {
      "id": "ab_smoke",
      "name": "Smoke",
      "width": 400,
      "height": 300,
      "background": { "kind": "solid", "color": "#ffffff" },
      "nodes": [
        {
          "id": "rect_1",
          "kind": "rect",
          "name": "Card",
          "x": 40, "y": 40, "width": 320, "height": 140,
          "radius": 16,
          "fill": { "kind": "solid", "color": "#4f46e5" }
        },
        {
          "id": "text_1",
          "kind": "text",
          "name": "Headline",
          "x": 40, "y": 210, "width": 320, "height": 60,
          "text": "Artboard smoke test",
          "fontSize": 28,
          "fontWeight": 700,
          "align": "center",
          "color": "#111111"
        }
      ]
    }
  ]
}
```

Top level:

| Field | Type | Meaning |
|---|---|---|
| `version` | number | Schema version. Currently `1` |
| `id` | string | Document id |
| `name` | string | Display name. Defaults to `"Untitled"` |
| `artboards` | array | At least one. Each has `id`, `name`, `width`, `height`, `background`, `nodes` |
| `assets` | object | `id -> { mime, width, height, data }`, where `data` is a `data:` URI |
| `diagnostics` | array | `{ level, code, nodeId, message }`, populated on open and on render |

### On the name

`.artboard.json` is the convention the editor writes: exporting the open format from
Studio produces `<name>.artboard.json`. It is a naming convention, not a format
requirement. The file is JSON and the CLI accepts any path you give it.

The golden fixtures in `tests/golden/` are plain `.json` by convention rather than by
constraint. The runner globs `*.json`, so an editor-exported `poster.artboard.json`
dropped straight into `tests/golden/` is picked up and gets a `poster.artboard.svg`
baseline beside it.

Because it is ordinary JSON with stable key names, a design change reads as a diff:

```diff
-          "fontSize": 28,
+          "fontSize": 32,
```

That is the entire pitch for the format.

---

## CLI

The `artboard` binary lives at
[`packages/cli/bin/artboard.mjs`](packages/cli/bin/artboard.mjs). These are
equivalent:

```bash
node packages/cli/bin/artboard.mjs <cmd>
./node_modules/.bin/artboard <cmd>
npx artboard <cmd>
```

It locates the repo root from its own module path, so `artboard golden` works from
any directory.

| Command | What it does | Exit |
|---|---|---|
| `validate <file>` | Parse a document and print its diagnostics | 1 on any error-level diagnostic |
| `render <file>` | Render an artboard to deterministic SVG, on stdout by default | 1 on any error-level diagnostic, **after** writing the SVG |
| `golden` | Re-render every fixture in `tests/golden` and diff against the committed baseline | 1 on drift or on an error-level diagnostic |
| `info <file>` | Artboard count and sizes, node counts by kind, asset count, diagnostics | always 0. It reports, it does not judge |

Note the `render` row: a non-zero exit does **not** mean there was no output. A
document with a missing image asset still renders, with a visible "Missing image"
placeholder, and still exits 1. That is deliberate, so you can look at what broke.

Flags:

| Flag | Command | Meaning |
|---|---|---|
| `--out <path>` | `render` | Write to a file instead of stdout |
| `--artboard <n>` | `render` | Which artboard, zero-indexed. Default `0` |
| `--no-assets` | `render` | Emit `asset:<id>` references instead of inline `data:` URIs |
| `--update` | `golden` | Rewrite the `.svg` baselines instead of failing |
| `--dir <path>` | `golden` | Fixture directory. Default `<repo>/tests/golden` |
| `-h`, `--help` | any | Usage |
| `-v`, `--version` | any | Version |

Exit codes: `0` success, `1` failure (invalid document, golden drift, unreadable or
missing file, out-of-range artboard), `2` usage error (unknown command, missing flag
value, no command). Failures print `Name: message` on stderr, and every error class
is named: `DocumentParseError`, `DocumentIntegrityError`, `UnsupportedVersionError`,
`FileNotFoundError`, `ArtboardRangeError`, `NoFixturesError`, `UsageError`.

Diagnostics always go to stderr, never stdout, so `render` without `--out` is safe to
pipe. Colour switches off automatically when stdout is not a TTY; `NO_COLOR` disables
it explicitly and `FORCE_COLOR` forces it, with `NO_COLOR` winning.

```bash
# Render to a file
node packages/cli/bin/artboard.mjs render tests/golden/smoke.json --out out/smoke.svg

# Second artboard, straight to stdout, piped onward
node packages/cli/bin/artboard.mjs render deck.artboard.json --artboard 1 | tee slide-2.svg

# Gate CI on document integrity
node packages/cli/bin/artboard.mjs validate brand/poster.artboard.json || exit 1

# Check nothing changed how designs render
npm run golden
```

Rendering is a pure function of the document. No network, no filesystem reads beyond
the input file, no clock, no randomness, no OS font lookup. The same input produces
the same bytes on your laptop and on a CI runner, which is what makes `golden` mean
anything.

## Agents: the MCP server

The same document model is exposed over MCP, so an agent can read a design and
edit it without a browser — [`@artboard/mcp`](packages/mcp).

```bash
claude mcp add artboard -- node packages/mcp/bin/artboard-mcp.mjs ~/designs
```

`open_document` returns an outline of every artboard and node, `render_artboard`
returns the SVG the editor would draw, and `edit_document` takes the same
commands the editor's undo stack runs on. Two things keep it safe to point at an
agent, both structural rather than advisory: every path is confined to the one
workspace root chosen at launch, and every edit is re-parsed by the schema before
it reaches disk, so an agent cannot write a document the editor would refuse to
open. `--read-only` drops the write tools entirely.

---

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Package graph, the open pipeline, the command layer, the determinism contract, known gaps |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model for an app that opens files strangers made, and the decisions taken in response |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev loop, the golden-file workflow, code rules, how to add a node kind |

---

## Roadmap

Not yet built, in rough order of priority.

| | Status |
|---|---|
| Editor UI (canvas, inspector, layers, tools) | In progress in [`apps/studio`](apps/studio) |
| A larger template library | 22 templates ship today in [`packages/templates`](packages/templates) |
| PDF export | Not started. The editor does SVG, PNG, JPG and JSON today |
| Raster export from the CLI | Not started. `artboard render` emits SVG only |
| SVG import, with the allowlist specified in [docs/SECURITY.md](docs/SECURITY.md) | Not started |
| Electron desktop shell, with the hardening defaults in [docs/SECURITY.md](docs/SECURITY.md) | Not started |
| Bring-your-own-key AI commands | Not started. Design constraints are already written down in [docs/SECURITY.md](docs/SECURITY.md) |
| Radial gradients, image fills, blend modes | Not started |
| Components and symbols | Not started |

---

## Licence

**MIT.** See [LICENSE](LICENSE). Use it commercially, fork it, sell it, embed it in
your product, relicense your fork. No key, no watermark, no seat count, no
attribution requirement beyond keeping the copyright notice.

### Why this was written from scratch

Two excellent existing projects were evaluated and deliberately not used. Neither
decision is a criticism of them, and both are the right choice for other people's
projects.

**[tldraw](https://tldraw.com)** is a superb canvas SDK, but it is not open source for
production use. The SDK is source-available under the tldraw licence: shipping it in
a production product requires a commercial licence key, and without one it renders a
"made with tldraw" watermark. That is a legitimate business model and it is also
exactly the thing Artboard exists to not have. A design tool whose core rendering
surface can be switched off, watermarked, or repriced by a third party is not a tool
you own, and a project promising "no paywalled exports" cannot be built on a
dependency that paywalls its own use.

**[Penpot](https://penpot.app)** is genuinely open source and genuinely good, under
**MPL-2.0**. MPL-2.0 is file-level copyleft: modified MPL files stay MPL and must be
distributed with source. That is fine on its own terms, but it is incompatible with
Artboard being MIT. Any MPL file carried into this repository stays MPL forever, so
the codebase would become a mix of licences in which "this project is MIT" is no
longer a true statement a downstream user can rely on. You cannot relicense
MPL-2.0 code as MIT. The whole point of choosing MIT is that a person can take this
code and do anything with it without reading a compatibility matrix first, and that
promise only holds if every file honours it.

So: written from scratch, MIT throughout, dependency surface kept deliberately small
(`zod` at runtime in the core packages, plus React and Vite for the editor).

---

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which
covers the dev loop, the golden-file workflow, the non-negotiable code rules, and a
step-by-step for adding a new node kind.

All contributions are made under the MIT licence.
