# The element library

Artboard bundles its own icons and shapes. Nothing in the Elements drawer
touches the network, and nothing a user exports carries an attribution
obligation. This document records where the artwork came from, how it is
stored, and how to regenerate it.

## Provenance

| | |
|---|---|
| Source package | [`lucide-static`](https://www.npmjs.com/package/lucide-static) |
| Version | **1.33.0** |
| Upstream | <https://lucide.dev> · <https://github.com/lucide-icons/lucide> |
| Tarball | `https://registry.npmjs.org/lucide-static/-/lucide-static-1.33.0.tgz` |
| Licence | **ISC** (a subset inherited from Feather is MIT) |
| Icons upstream | ~2000 |
| Icons bundled | **375** |

Lucide is ISC: use, copy, modify and distribute are all granted, with the single
condition that the copyright notice travels with the copy. The notice lives at
`packages/icons/LICENSE-ICONS`, verbatim, alongside the MIT notice that covers
the ~110 icons Lucide inherited from [Feather](https://feathericons.com)
(© Cole Bemis). Both are attribution-on-*copy*, not attribution-on-*use*: a
person who exports a poster made with these icons owes nobody a credit line.

Font Awesome Free was **not** considered — it is CC-BY 4.0, which does put an
attribution burden on the end user, and that is exactly the thing this library
exists to avoid.

## What is stored

`packages/icons/src/data.ts` is generated, **112 KB**, and holds one row per
icon:

```ts
{ id: "shopping-cart", name: "Shopping Cart", category: "commerce", stroke: true,
  tags: ["buy", "cart", "checkout", "shopping", "store", "trolley"],
  d: "M2.24 4h.71a2 2 0 0 1 1.94 1.52L5.3 8m0 0 …" }
```

Every icon is normalised to a **24×24 viewBox**. Lucide draws an icon from
several primitives — `path`, `circle`, `rect`, `line`, `polyline`, `polygon`,
`ellipse` — but Artboard's `PathNode` holds a single `d`, so each primitive is
converted to path commands and the subpaths concatenated. That is exact for
stroked artwork: an `M` opens a new subpath and, with no fill, there is no
winding rule to get wrong.

Two conversion details are easy to get wrong and were both caught by rendering
the whole set and looking at it:

- A standalone path opening with a **relative `m`** is relative to the origin.
  Appended after another subpath it becomes relative to *that* subpath's last
  point, which flings half the icon off the artboard. `generate.mjs` rewrites
  the opening command to an absolute `M` — and promotes the coordinate pairs
  riding on it to an explicit `l`, since they were relative linetos.
- The attribute-name pattern must allow digits, or `x1`/`y1` are silently
  dropped and all 161 `<line>` elements become `M NaN NaN`.

## Stroked vs filled

This is the one distinction that matters, and getting it backwards is very
visible:

| | `stroke` | Rendered with |
|---|---|---|
| **Icons** (375, Lucide) | `true` | `fill: none`, stroke width **2** in viewBox units |
| **Shapes** (39, generated) | `false` | solid fill, stroke width 0 |

Lucide artwork *is* the stroke. Fill a lucide path instead and you paint the
union of its outlines — a black blob. Conversely a shape is a silhouette;
outline it and it disappears.

Callers should not have to remember this. `@artboard/icons` exports
`iconNodeStyle()` and `shapeNodeStyle()`, which return the paint half of a node
to spread into `buildNode`:

```ts
buildNode({ id: uid('n'), kind: 'path', name: icon.name,
            x, y, width: size, height: size, d: icon.d, ...iconNodeStyle() });
```

Stroke width is expressed in **viewBox units** on purpose. The renderer scales a
path node by `width / viewBox`, so the stroke grows with the icon instead of
thinning to a hairline at poster size.

### Round caps and joins

Lucide is authored for `stroke-linecap="round" stroke-linejoin="round"`, and
`iconNodeStyle()` sets `cap: 'round', join: 'round'` on the node's stroke. This
is not decoration. Lucide draws small dots as near-zero-length segments —
`circle-alert`'s exclamation dot is `M12 16 L12.01 16` — and a butt cap renders
those as **nothing at all**, so `circle-alert`, `circle-help`, `info`, `wifi`
and about sixteen others lose their dot and read as broken. `Stroke` gained
`cap`/`join` for this, both defaulting to the SVG defaults (`butt`/`miter`) so
no existing document changed and the 24 goldens stayed byte-identical.

The drawer previews carry the same `strokeLinecap`/`strokeLinejoin`, so a tile
never promises a rounder icon than the canvas delivers.

Inserted icons also set `alt` to the icon name, which makes the renderer emit a
`<title>` — an exported SVG of a shopping-cart icon says so to a screen reader.
Geometric shapes deliberately leave `alt` empty: "Blob" is not information.

## Categories

Ten, ordered as they appear in the drawer. Each icon also carries search tags
taken from Lucide's own `tags.json` plus the words of its name, so "trolley"
finds `shopping-cart` and "bin" finds `trash-2`.

| Category | Icons |
|---|---|
| Arrows | 51 |
| Interface | 62 |
| Media | 40 |
| Comms | 30 |
| Files | 38 |
| Commerce | 30 |
| Social | 27 |
| Weather | 25 |
| Nature | 28 |
| Symbols | 44 |

A handful of icons (`star`, `heart`, `compass`) appear in two categories,
because that is where people look for them; the duplicate gets a suffixed id so
the drawer keys stay unique.

## Shapes

`packages/icons/src/shapes.ts` is **not** generated — it is source, because
everything with a formula is computed rather than typed out:

- `polygonPath(sides)` — triangle through decagon
- `starPath(points, outer, inner)` — 4/5/6/8-point stars, sparkle, burst
- `circlePath(cx, cy, r, cw)` — rings, crescents; `cw` picks the winding
- `blobPath(radii, rotate)` — a Catmull-Rom spline through one point per radius

Only shapes with genuinely no formula — heart, cloud, speech bubble, banner,
tag, shield, bolt — are hand-written. That rule is not aesthetic: the three
blobs were originally hand-drawn beziers and all three rendered as plain
circles, because handles nudged by eye tend back toward the mean.

Shapes are drawn in a **0..100 box**, matching the convention already used by
`packages/render-svg/src/shapes.ts`.

Holes (`ring`, `frame`, `crescent`) are cut by winding the inner subpath
*against* the outer one, which sums to zero under the default non-zero fill
rule. The inner subpath must sit **entirely inside** the outer one: any part
that escapes has winding −1, which is also non-zero, so it fills. That bug
turned the first crescent into a lens.

## Regenerating `data.ts`

```sh
cd /tmp
npm pack lucide-static@1.33.0
tar xzf lucide-static-1.33.0.tgz
node packages/icons/tools/generate.mjs /tmp/package
```

The script prints the icon count, the file size and the per-category tally, and
**fails loudly** if any name in `tools/icon-list.mjs` is missing from the
tarball — a renamed upstream icon is a build failure, never a silently smaller
library. `tools/` is build-time only and is never imported by the package.

To change what ships, edit `tools/icon-list.mjs` and re-run. Keep `data.ts`
under ~400 KB; at 375 icons it is 112 KB, so there is room.

## Constraints on `@artboard/icons`

- **Zero runtime dependencies.** Not even `@artboard/schema` — `iconNodeStyle()`
  returns a plain object for the caller to hand to `buildNode`.
- **No network, no filesystem, no `Date`, no `Math.random`.** Everything is data
  and pure functions over it, so the same call always produces the same string
  and the library can appear in a golden test.

## Verifying a change

Type-checking will not tell you an icon renders as a blob. Render the whole
library through the real pipeline and look at it:

```sh
npx tsx .scratch/icon-sheet.ts          # every icon + shape -> .scratch/icon-sheet.svg
node .scratch/shot-sheet.mjs .scratch/icon-sheet.svg .scratch/icon-sheet.png
node .scratch/icons-interact.mjs        # drives the real drawer at :5273
```

The contact sheet is what caught the `NaN` lines, the flung subpaths, the
circular blobs and the lens-shaped crescent. Twelve spot-checks caught none of
them.
