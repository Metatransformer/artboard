# Canva Feature Matrix → Artboard Build Plan

**Scope:** the complete feature surface of Canva (free + Pro, 2024–2026), mapped onto what
Artboard's architecture can render. Compiled 2026-08-20.

**Why this document exists:** Artboard has exactly one renderer
(`packages/render-svg/src/index.ts`) that emits an SVG scene graph as data. The editor mounts
that tree as React; the CLI serialises the identical tree to a string, and golden tests diff the
string. That single fact decides feasibility for every row below: **if a feature can be expressed
as static SVG 1.1 + CSS, it is cheap and it is free in both the editor and the CLI. If it needs a
raster pass, a model, or a server, it costs a second pipeline** — and a second pipeline is a
parity problem, which is the thing this architecture was designed to avoid.

---

## How to read this

### Feasibility codes

| Code | Meaning | Cost to the architecture |
|---|---|---|
| `NATIVE` | Plain SVG elements/attributes. `<rect>`, `<text>`, `stroke`, `paint-order`, `<textPath>`, `<clipPath>`, `<mask>`, `<linearGradient>`. | Zero. Renderer emits more nodes. |
| `SVG-FILTER` | Needs a `<filter>` in `<defs>`. Named primitives given per row. | Near zero, but see the four filter gotchas below. |
| `CSS` | Needs a CSS property that SVG honours (`mix-blend-mode`, `isolation`, `@font-face`). | Low in the editor; the CLI must emit an inline `<style>` block or presentation attributes. |
| `CANVAS` | Needs a raster round-trip (`<canvas>`/`OffscreenCanvas`), producing a new image asset. | High. Second pipeline; not available in a headless CLI without `node-canvas`/`resvg`. |
| `WASM/ML` | Needs a model in the browser (ONNX Runtime Web / tfjs) — segmentation, inpainting, generation. | High. Ships weights; non-deterministic; CLI can't do it. |
| `SERVER` | Needs a backend Artboard has deliberately chosen not to have. | Out of architecture. |
| `NO` | Not expressible / not in scope for a local-first MIT tool. | — |

### Effort

`S` ≈ under a day · `M` ≈ 1–3 days · `L` ≈ 1–2 weeks · `XL` ≈ a month or more / needs a new subsystem.

### Priority

- **P0** — a design tool is broken without it.
- **P1** — users coming from Canva expect it and will notice the hole immediately.
- **P2** — nice; differentiating; can wait.
- **P3** — skip. Out of scope for a local-first, server-less, MIT project.

### Four filter gotchas that apply to every `SVG-FILTER` row

1. **Always set `color-interpolation-filters="sRGB"` on the `<filter>`.** The SVG default is
   `linearRGB`. Every design tool (and every Canva slider) works in sRGB; leaving the default on
   makes blurs and colour matrices look washed-out and, worse, makes results differ between
   renderers — which breaks the golden tests' premise that the string *is* the picture.
2. **Filter regions clip.** The default region is `x="-10%" y="-10%" width="120%" height="120%"`.
   Any glow, long shadow or large blur needs an explicit widened region — the current
   `feDropShadow` path already uses `-50%/-50%/200%/200%`, which is right for ordinary shadows and
   too small for Neon.
3. **`feTurbulence` must carry an explicit `seed`.** Grain/noise is otherwise
   implementation-defined and will never produce a stable golden file.
4. **Filters on a group apply to the flattened group**, not per child. Several Canva effects
   (Echo, Glitch, Splice) are therefore better built as *sibling duplicate elements* than as
   filters: cheaper, exactly deterministic, and they honour per-copy colour.

### Current schema, for reference

`packages/schema/src/index.ts` today: node kinds `text | rect | ellipse | line | path | image |
group | opaque`; `Fill` = solid | gradient (linear only) | none; one `Stroke` (colour, width, dash);
one drop `Shadow` (x, y, blur, colour) on `NodeBase`; `opacity`, `rotation`, `visible`, `locked`.
Text carries a *single* colour, family, weight and size for the whole node. Images carry
`assetId + fit + radius` and nothing else.

The schema deltas that unlock the biggest number of rows are collected in
[§ Schema deltas](#schema-deltas-that-unlock-the-most-rows) near the end.

---

## A. Document, pages & artboards

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Multi-page document | One design holds many pages; page strip, grid view, reorder by drag | `NATIVE` | S | P0 | Already modelled: `Document.artboards[]`. Editor UI for reorder/duplicate is the gap. |
| Preset canvas sizes | Hundreds of named presets (IG post, A4, presentation 16:9, business card…) | `NATIVE` | S | P0 | Pure data — a JSON table of `{name, w, h, unit, dpi}`. https://www.canva.com/help/resize/ |
| Custom canvas size | Arbitrary px/in/mm/cm, per design | `NATIVE` | S | P0 | Schema stores px; unit + DPI are presentation metadata. Needs `Artboard.unit`/`dpi`. |
| Duplicate / delete / reorder page | Right-click page, duplicate; drag in page manager | `NATIVE` | S | P0 | Pure document mutation. |
| Page background colour | Solid or gradient page background | `NATIVE` | S | P0 | Shipped — `Artboard.background: Fill`, drawn as the first `<rect>`. |
| Page background **image** | Drop a photo, "Set image as background" | `NATIVE` | S | P1 | Needs `Artboard.background` to accept `{kind:'image', assetId, fit}`. Emits `<image>` + `<clipPath>` before all nodes. |
| Page notes / speaker notes | Per-page notes shown in presenter view | `NATIVE` | S | P2 | Document field only; renders nowhere. Blocks nothing. |
| Page titles | Name each page; used as PDF bookmarks and slide titles | `NATIVE` | S | P2 | `Artboard.name` exists. |
| Rulers & guides | Rulers on/off, drag guides out, guide presets (3×3, columns), lock guides | `NATIVE` | M | P1 | Editor-chrome only — must NOT enter the rendered scene (or must be behind `opts.chrome`), or golden files change. |
| Margins & print bleed | Show margins, show print bleed, crop-mark region | `NATIVE` | S | P1 | Overlay chrome + an export-time bleed expansion of the viewBox. |
| Snap to object / smart guides | Pink alignment guides while dragging, edge/centre snapping, equal-spacing hints | `NATIVE` | M | P0 | Pure editor interaction; no render impact. Highest-perceived-quality feature per unit of code in the whole list. |
| Grid / page-manager view | Thumbnail grid of all pages | `NATIVE` | S | P1 | Render each artboard small; already possible via `renderArtboard`. |
| Zoom, pan, fit to screen | 10–500 %, `Ctrl +/-`, `Ctrl Shift H` fit | `NATIVE` | S | P0 | Viewport transform in the editor shell. |
| Undo / redo | Unlimited within session | `NATIVE` | M | P0 | Document is plain JSON — snapshot or patch stack both work. |
| Version history | Up to 1,000 named versions, avatars per version, restore | `NATIVE` | M | P2 | Local-first version: append-only snapshot log in IndexedDB / on disk. No server needed. https://www.canva.com/help/version-history/ |
| Autosave | Continuous, cloud | `NATIVE` | S | P0 | Local: IndexedDB + File System Access API. |
| Infinite whiteboard canvas | "Expand to whiteboard" — unbounded canvas with connectors and sticky notes | `NATIVE` | L | P3 | A different document model (unbounded coordinate space). Out of scope against a fixed-artboard schema. |
| Magic Resize | One click reflows the whole design into another size, repositioning and rescaling everything | `NATIVE` | L | P1 | Pure geometry — see [§ Magic Resize](#magic-resize-without-ai). This is a *layout* problem, not an AI problem. |
| Design units & DPI | Work in mm/in for print, 300 dpi export | `NATIVE` | S | P1 | SVG has real units; store px internally, convert at the edges. |

## B. Text & typography

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Insert text box (`T`) | Click or press T; "Add a heading / subheading / body" | `NATIVE` | S | P0 | Shipped. |
| Font family picker | ~3,000 fonts, search, recently used, brand fonts pinned | `NATIVE` + `CSS` | M | P0 | Needs `@font-face` with **embedded** WOFF2 for the CLI, otherwise exported SVG renders in a fallback face. See [§ Fonts](#fonts-the-one-hard-dependency). |
| Font size | Numeric + `Ctrl Shift >` / `<` | `NATIVE` | S | P0 | Shipped. |
| Bold / italic | Real weights when the family has them, faux otherwise | `NATIVE` | S | P0 | Shipped (`fontWeight`, `italic`). Faux-bold via `stroke-width` = fontSize/25 is the fallback. |
| Underline / strikethrough | Toggle | `NATIVE` | S | — | **SHIPPED.** `TextNode.underline` / `.strikethrough`, Inspector U / S buttons. Drawn as one `<path>` of real geometry per text node, not `text-decoration`: the attribute is a browser feature, so a PDF built from the same scene graph would draw nothing. One path rather than a `<line>` or a `<rect>` per line because gradients here are objectBoundingBox — a zero-height line does not paint at all and per-line rects restart the gradient. Blank lines are skipped; curved text refuses with `CURVE_NO_RULES`. No keyboard shortcut yet (Ctrl/Cmd+U). |
| Uppercase toggle | `Aa` button | `NATIVE` | S | P1 | Shipped (`uppercase`) — but must be applied in `layoutText`, not CSS, or measurement drifts. |
| Letter spacing | Slider, ±% of em | `NATIVE` | S | P0 | Shipped. |
| Line spacing | Slider, multiple of font size | `NATIVE` | S | P0 | Shipped (`lineHeight`). |
| Paragraph / "anchor" spacing | Space between paragraphs, separate from line height | `NATIVE` | S | P1 | Layout-engine field; extra leading before a paragraph's first line. |
| Align left/centre/right/justify | `Ctrl Shift L/E/R/J` | `NATIVE` | S | P0 | L/C/R shipped via `text-anchor`. **Justify needs word-space distribution in `layoutText`** — `text-anchor` cannot do it. |
| Vertical align in box | Top / middle / bottom | `NATIVE` | S | P1 | `valign` is in the schema; wire it into `layoutText`'s y-origin. |
| Bulleted list | `•` list, indent levels | `NATIVE` | M | P1 | SVG has no list primitive. Emit a bullet `<tspan>` (or `<circle>`) plus a hanging indent per line in the layout engine. |
| Numbered list | 1. 2. 3., auto-renumber, nested | `NATIVE` | M | P1 | Same mechanism; numbering computed at layout time. |
| Indent / outdent | `Tab` / `Shift Tab` | `NATIVE` | S | P1 | Per-paragraph `indent` field. |
| **Rich-text runs** | Bold/colour/size/link on a *span* inside one text box | `NATIVE` | L | **P0** | The single biggest gap in the current schema: `TextNode` carries one family/size/weight/colour for the whole node. Needs `runs: [{text, style}]` and a run-aware `layoutText`, emitting one `<tspan>` per style change. Everything in § C depends on it being done first or being explicitly deferred. |
| Hyperlink on text/element | Attach a URL; clickable in PDF & shared link | `NATIVE` | S | P1 | Wrap in `<a href>`. Sanitise the scheme (`http`/`https`/`mailto` only) — this is an untrusted-content path. |
| Superscript / subscript | Toggle | `NATIVE` | S | P2 | `baseline-shift` + reduced size on the run. Needs rich-text runs. |
| Kerning & ligatures | Advanced → Typography toggles | `NATIVE` | M | P2 | `font-kerning` / `font-variant-ligatures`; but the *measurer* must agree or lines break differently in CLI vs editor. Only safe once the layout engine uses real font metrics (HarfBuzz/opentype.js) rather than `metricMeasurer`. |
| Auto-fit text to box | Text shrinks to fit a fixed box | `NATIVE` | M | P1 | Binary-search font size in the layout engine. Deterministic, so golden-safe. |
| Auto-grow box height | Box height follows content | `NATIVE` | S | P0 | Layout engine returns measured height; node height follows. |
| Upload custom fonts | Pro: upload TTF/OTF/WOFF to a Brand Kit | `NATIVE` + `CSS` | M | P1 | Store the font as a content-addressed `Asset` (data URI) exactly like an image, emit `@font-face` in `<defs><style>`. This is a *better* fit for local-first than Canva's model. |
| Text styles / font pairing | "Heading / Subheading / Body" presets, auto font pairings | `NATIVE` | M | P2 | A named style table in the document; nodes reference a style id. |
| Gradient / image fill on text | Available via the Elements/effects path | `NATIVE` | S | P1 | `fill="url(#grad)"` on `<text>` just works — needs `TextNode.fill: Fill` instead of `color: Hex`. Cheap, high visual payoff. |
| Columns | Multi-column text in Docs | `NATIVE` | M | P3 | Layout-engine work with little payoff on a poster tool. |
| Vertical / RTL / CJK text | Supported in Canva's editor | `NATIVE` | L | P2 | `writing-mode`, `direction`, plus bidi in the layout engine. Correct bidi is genuinely hard; defer until the metric measurer is replaced. |
| Spell check | Inline red squiggle | `NO` | — | P3 | Browser `contenteditable` gives it free in the editing overlay; nothing to render. |
| Find & replace | Across a design | `NATIVE` | S | P2 | Document-tree walk. Trivial once rich-text runs exist. |
| Text case transform | `Aa` cycles Sentence/lower/UPPER | `NATIVE` | S | P2 | Applied to the stored string or as a layout flag. |

## C. Text effects — the deep section

Canva's Effects panel for text offers, in order: **None, Shadow, Lift, Hollow, Splice, Outline,
Echo, Glitch, Neon**, plus a Shape sub-panel with **Background** and **Curve**.
(https://www.canva.com/help/text-effects/ · https://designbundles.net/design-school/how-to-use-canva-text-effects
· https://www.thebusyllama.com/canva-font-effects/)

Two structural decisions govern this whole section:

1. **Prefer duplicated `<text>` siblings over filters** for Shadow (hard), Splice, Echo and Glitch.
   Filters flatten the source and can only recolour it as a whole; duplicates give each copy its
   own `fill`, cost nothing at render time, and serialise to a stable string. The filter form is
   listed as an alternative where it is genuinely better (blur > 0).
2. **`paint-order="stroke fill markers"` is the single most important attribute in this section.**
   SVG strokes are centred on the glyph outline, so a plain `stroke` eats half its width into the
   letterform and thins the type. Painting the stroke *first* and the fill over it makes only the
   outer half visible — which is exactly what a design tool means by "outline". Supported in all
   current browsers and in resvg.

Below, `S` = `fontSize`, `θ` = the effect's Direction in degrees, and slider values are Canva's
0–100 unless noted. All mappings from slider → SVG units are **(inferred)** — Canva does not
publish them; they were chosen to match screenshots at 100 px type and should be tuned by eye.

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| **Shadow** | A solid copy of the text offset behind it. Sliders: **Offset, Direction, Blur, Transparency, Colour** | `NATIVE` (blur = 0) / `SVG-FILTER` `feDropShadow` (blur > 0) | S | P0 | Recipe below. |
| **Lift** | Text appears to float off the page: a soft, centred, slightly-spread grey shadow. Single slider: **Intensity** | `SVG-FILTER` `feDropShadow` | S | P0 | Recipe below. |
| **Hollow** | Glyph fill removed; outline only. Slider: **Thickness** | `NATIVE` | S | P0 | Recipe below. |
| **Splice** | Hollow outline *plus* a solid offset copy behind, in a second colour. Sliders: **Thickness, Offset, Direction, Colour** | `NATIVE` (2 `<text>`) | S | P1 | Recipe below. |
| **Outline** | Text keeps its fill and gains a border. Sliders: **Thickness, Colour** | `NATIVE` (`paint-order`) | S | P0 | Recipe below. |
| **Echo** | Two trailing copies behind the text at increasing offset and decreasing opacity — a reverb trail. Sliders: **Offset, Direction, Colour** | `NATIVE` (3 `<text>`) | S | P1 | Recipe below. |
| **Glitch** | Chromatic aberration: a cyan copy offset one way, a red/magenta copy the other, crisp text on top. Sliders: **Offset, Direction, Colour** (preset pairs) | `NATIVE` (3 `<text>`) / `SVG-FILTER` for the true channel-split | S | P1 | Recipe below. |
| **Neon** | Glyphs render hot/near-white with a coloured bloom around them. Single slider: **Intensity** — right = softer glow + whiter text, left = harsher glow + blurrier text | `SVG-FILTER` `feMorphology` + `feGaussianBlur` + `feFlood` + `feComposite` + `feMerge` | M | P1 | Recipe below. The one text effect that genuinely needs a filter. |
| **Background** | A rounded plate behind the text. Sliders: **Roundness, Spread, Transparency, Colour** | `NATIVE` (`<rect>` sibling) | S | P1 | Recipe below. |
| **Curve** | Bends the text along a circular arc. Slider: **Curve** (−100 … +100; negative arcs downward) | `NATIVE` `<textPath>` on a `<path>` arc, or per-glyph transforms | M | P1 | Recipe below; read the caveat. |
| Warp / arch / wave presets | Not a Canva-native text effect (available only through third-party apps) | `NATIVE` (per-glyph transform) | L | P3 | Only worth building if per-glyph positioning already exists for Curve. |
| 3D / extruded text | Third-party Canva apps only | `NATIVE` (N stacked copies) | M | P3 | N offset copies at decreasing lightness ≈ an extrusion. Cheap trick, low demand. |

### C.1 Shadow

Hard shadow (Blur = 0) — one extra `<text>`, painted first:

```xml
<text x="100" y="200" fill="#00000059"
      font-family="Poppins" font-size="120" font-weight="700"
      transform="translate(6.9 4.0)">HELLO</text>
<text x="100" y="200" fill="#111111"
      font-family="Poppins" font-size="120" font-weight="700">HELLO</text>
```

Mapping **(inferred)**: `dx = (offset/100) × S × 0.12 × cos(θ)`, `dy = (offset/100) × S × 0.12 × sin(θ)`
with θ measured clockwise from east; `flood-opacity = 1 − transparency/100`.
At Offset 50, θ = 30°, S = 120 → dx ≈ 6.2, dy ≈ 3.6.

Soft shadow (Blur > 0) — a filter, because a blurred duplicate would need its own filter anyway:

```xml
<filter id="fx-shadow" x="-50%" y="-50%" width="200%" height="200%"
        color-interpolation-filters="sRGB">
  <feDropShadow dx="6.2" dy="3.6" stdDeviation="4.8"
                flood-color="#000000" flood-opacity="0.35"/>
</filter>
```

`stdDeviation = (blur/100) × S × 0.08` **(inferred)**. Note Artboard's existing `Shadow` node field
already emits `feDropShadow` with `stdDeviation = blur/2` — the text Shadow effect should reuse that
primitive rather than introduce a second convention.

### C.2 Lift

A centred, spread, low-opacity shadow — no directional offset. One slider drives everything:

```xml
<filter id="fx-lift" x="-40%" y="-40%" width="180%" height="180%"
        color-interpolation-filters="sRGB">
  <feDropShadow dx="0" dy="0.055*S" stdDeviation="0.075*S"
                flood-color="#000000" flood-opacity="0.30"/>
</filter>
```

Mapping **(inferred)**: `dy = (intensity/100) × S × 0.06`, `stdDeviation = (intensity/100) × S × 0.09`,
`flood-opacity = 0.15 + 0.30 × intensity/100`. Lift deliberately keeps `dy` small relative to
`stdDeviation` — that ratio (roughly 0.7) is what reads as "floating" rather than "cast".

### C.3 Hollow

```xml
<text x="100" y="200" fill="none" stroke="#111111" stroke-width="3.6"
      stroke-linejoin="round" paint-order="stroke"
      font-family="Poppins" font-size="120" font-weight="700">HELLO</text>
```

`stroke-width = (thickness/100) × S × 0.06` **(inferred)**, clamped to ≥ 0.5 px.
`stroke-linejoin="round"` matters: sharp-cornered faces (Poppins' `A`, any slab serif) grow ugly
spikes with the default `miter` at large widths. The stroke colour is the text's own colour —
Canva's Hollow has no separate colour control.

### C.4 Splice

Hollow front, solid offset copy behind, two independent colours:

```xml
<!-- back copy: solid, in the effect colour -->
<text x="100" y="200" fill="#ff3b5c" transform="translate(7 5)"
      font-family="Poppins" font-size="120" font-weight="700">HELLO</text>
<!-- front copy: hollow, in the text colour -->
<text x="100" y="200" fill="none" stroke="#111111" stroke-width="3.6"
      stroke-linejoin="round"
      font-family="Poppins" font-size="120" font-weight="700">HELLO</text>
```

Same offset mapping as Shadow, same thickness mapping as Hollow. Splice is literally
`Hollow ∘ Shadow` with the shadow given its own colour — which is a good argument for modelling
text effects as a **composable list** (`effects: [{kind:'shadow',…},{kind:'hollow',…}]`) rather
than a closed enum. Canva's own panel is a closed enum only because its UI is one row of chips.

### C.5 Outline

```xml
<text x="100" y="200" fill="#ffffff"
      stroke="#111111" stroke-width="7.2" stroke-linejoin="round"
      paint-order="stroke fill markers"
      font-family="Poppins" font-size="120" font-weight="700">HELLO</text>
```

Because the stroke is centred and then half-covered by the fill, the **visible** outline is
`stroke-width / 2`. So to hit a target outline thickness `t`, emit `stroke-width = 2t` with
`t = (thickness/100) × S × 0.05` **(inferred)**.

Fallback for renderers without `paint-order` (very old resvg, some print RIPs): emit two `<text>`
elements — a stroked one first, then a filled one on top. Same pixels, twice the string.

### C.6 Echo

```xml
<text x="100" y="200" fill="#111111" fill-opacity="0.25"
      transform="translate(20 14)" …>HELLO</text>
<text x="100" y="200" fill="#111111" fill-opacity="0.50"
      transform="translate(10 7)"  …>HELLO</text>
<text x="100" y="200" fill="#111111" …>HELLO</text>
```

Two trailing copies at 1× and 2× the offset, opacity ≈ 0.50 and 0.25 **(inferred)**.
`offset unit = (offset/100) × S × 0.18`. Echo's copies take the *effect* colour, which defaults to
the text colour — that default is why Echo reads as a "ghost" and Glitch (different colours) reads
as a defect.

### C.7 Glitch

Three copies; the two behind take a complementary pair:

```xml
<text x="100" y="200" fill="#00e5ff" transform="translate(-6 0)" …>HELLO</text>
<text x="100" y="200" fill="#ff005c" transform="translate( 6 0)" …>HELLO</text>
<text x="100" y="200" fill="#111111" …>HELLO</text>
```

Canva ships colour presets rather than a free picker for the pair (cyan/red, blue/red, green/pink).
`offset unit = (offset/100) × S × 0.10` **(inferred)**; Direction rotates the offset vector, so a
θ of 90° gives a vertical tear instead of a horizontal one.

The *true* chromatic split — where the R and B channels of the rendered glyph separate, so
overlaps go white — needs a filter:

```xml
<filter id="fx-glitch" x="-20%" y="-20%" width="140%" height="140%"
        color-interpolation-filters="sRGB">
  <feColorMatrix in="SourceGraphic" type="matrix" result="R"
    values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
  <feColorMatrix in="SourceGraphic" type="matrix" result="GB"
    values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
  <feOffset in="R"  dx="-6" dy="0" result="Ro"/>
  <feOffset in="GB" dx="6"  dy="0" result="GBo"/>
  <feBlend in="Ro" in2="GBo" mode="screen"/>
</filter>
```

Use the three-copy version by default (deterministic, matches Canva's flat look); keep the filter
form behind a "true chromatic" option.

### C.8 Neon

The one text effect that must be a filter. Dilate the alpha slightly so thin strokes still bloom,
blur at two radii, tint each blur with `feFlood` + `feComposite operator="in"`, then merge with the
inner glow doubled so the core reads hot:

```xml
<filter id="fx-neon" x="-75%" y="-75%" width="250%" height="250%"
        color-interpolation-filters="sRGB">
  <feMorphology in="SourceAlpha" operator="dilate" radius="1.5" result="thick"/>
  <feGaussianBlur in="thick" stdDeviation="4"  result="g1"/>
  <feGaussianBlur in="thick" stdDeviation="14" result="g2"/>
  <feFlood flood-color="#ff2d95" result="tint"/>
  <feComposite in="tint" in2="g1" operator="in" result="glow1"/>
  <feComposite in="tint" in2="g2" operator="in" result="glow2"/>
  <feMerge>
    <feMergeNode in="glow2"/>
    <feMergeNode in="glow1"/>
    <feMergeNode in="glow1"/>
    <feMergeNode in="SourceGraphic"/>
  </feMerge>
</filter>
```

The glyph's own `fill` must be pushed toward white as Intensity rises — Canva's slider does both
things at once: `fill = mix(neonColour, #ffffff, 0.35 + 0.5 × intensity/100)`,
`stdDeviation₁ = S × 0.03`, `stdDeviation₂ = S × 0.12`, both scaled by `(1.4 − 0.6 × intensity/100)`
so the *left* end of the slider is harsher/blurrier as documented **(inferred)**.

Note the `-75%/250%` region: at S = 120 the outer blur reaches ~43 px past the glyph, and the
default region would visibly clip it. This is the row that will produce a "why is my glow cut off"
bug if gotcha #2 is ignored.

### C.9 Background

Not a filter at all — a sibling `<rect>` behind the text, sized from the laid-out text bounds:

```xml
<rect x="82" y="96" width="436" height="152" rx="24"
      fill="#ffd166" fill-opacity="0.9"/>
<text x="100" y="200" …>HELLO</text>
```

`spread` inflates the measured text bbox on all sides: `pad = (spread/100) × S × 0.35`;
`rx = (roundness/100) × min(w,h)/2`; `fill-opacity = 1 − transparency/100` **(inferred)**.
Requires the layout engine to return a real bounding box per text node — which it must do for
selection handles anyway, so this row is nearly free once selection is correct.

Canva applies the plate to the text *box*, and there is a per-line variant in some templates; if
per-line is wanted, emit one `<rect>` per laid-out line, which is the same code in a loop.

### C.10 Curve

```xml
<defs>
  <path id="arc-1" d="M 100 300 A 250 250 0 0 1 600 300"/>
</defs>
<text font-family="Poppins" font-size="120" font-weight="700" fill="#111111">
  <textPath href="#arc-1" startOffset="50%" text-anchor="middle">HELLO</textPath>
</text>
```

Geometry: for a Curve slider value `c ∈ [−100, 100]` and a text box of width `W`, take the sweep
angle `φ = (|c|/100) × 180°`, radius `r = W / φ_radians` (so the arc length stays ≈ W and the type
neither stretches nor compresses), and emit an `A r r 0 0 <sweep> …` arc whose sweep flag is `1`
for `c > 0` (text bulges upward) and `0` for `c < 0` **(inferred)**. `c = 0` degenerates to a
straight line — emit a plain `<text>` instead of a `<textPath>` so the common case stays clean.

**Caveat, and it is a real one:** `<textPath>` is single-line only, ignores `text-anchor` per line,
composes badly with `letter-spacing` in some engines, and cannot be combined with the duplicate-copy
effects above (each copy needs its own offset path, not a `transform`, or the glyph rotations go
wrong). If Curve must combine with Shadow/Outline/Neon — and in Canva it does — the durable
implementation is **per-glyph placement**: the layout engine returns `[{glyph, x, y, rotate}]` and
the renderer emits one `<text>` with per-glyph `<tspan x= y= rotate=>`, or one `<text
transform="rotate(a cx cy)">` per glyph. That is strictly more code, fully deterministic, and makes
the Warp/3D rows in this table nearly free afterwards. Recommend going straight to per-glyph and
treating `<textPath>` as the throwaway prototype.

## D. Shadows & glows (elements, images, shapes) — the deep section

Canva's **Shadows** panel (for images, shapes and elements, distinct from the text Effects panel)
offers **Glow, Drop, Outline, Angle, Curve, Page Lift** and **Backdrop**, with sliders drawn from
**Offset, Angle/Direction, Blur, Transparency, Colour, Intensity, Distance, Spread** depending on
the type. (https://allthings.how/how-to-use-canva-shadow-effect/ ·
https://www.bwillcreative.com/how-to-add-a-drop-shadow-in-canva/ ·
https://www.laisladesigns.com/2025/05/13/canva-hacks-part-8-shadows/)

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| **Drop** | Classic offset+blur shadow; object floats above the page. Sliders: Offset, Angle, Blur, Transparency, Colour | `SVG-FILTER` `feDropShadow` | S | P0 | Already shipped as `NodeBase.shadow`. Only the UI (angle/distance instead of raw dx/dy) is missing. |
| **Glow** | Soft, centred, colour-tinted halo — no offset. Sliders: Size/Blur, Transparency, Colour | `SVG-FILTER` `feMorphology` + `feGaussianBlur` + `feFlood` + `feComposite` + `feMerge` | S | P1 | Same stack as Neon (§ C.8) with one blur radius instead of two. |
| **Outline** | A hard "sticker" border tracing the object's silhouette, including a cut-out photo's edge. Sliders: Thickness, Colour | `SVG-FILTER` `feMorphology dilate` + `feFlood` + `feComposite` + `feMerge` | M | P1 | Recipe below. Works on images *and* shapes, which a plain `stroke` cannot. |
| **Angle** | A long, hard-edged shadow cast off at a direction — the "long shadow" look. Sliders: Angle, Distance/Length, Transparency, Colour | `NATIVE` (skewed silhouette) or `SVG-FILTER` (N× `feOffset` + `feMerge`) | M | P1 | Recipe below. |
| **Curve** | Shadow bows under the object as if the page lifts at the corners. Sliders: Curve, Offset, Transparency, Blur, Colour | `NATIVE` (gradient-filled path) + `SVG-FILTER` blur | M | P2 | Recipe below. |
| **Page Lift** | Object's bottom corners lift off the page, thin shadow tucked underneath | `NATIVE` + `SVG-FILTER` | M | P2 | Same construction as Curve with a shallower, doubled arc. |
| **Backdrop** | Places the subject on a coloured plate with a shadow — needs the subject cut out of the photo | `WASM/ML` + `NATIVE` | L | P3 | The shadow half is trivial; the cut-out half is background removal (§ V). Ships only after that. |
| Inner shadow | Not a Canva feature; Figma/PS have it | `SVG-FILTER` `feFlood`+`feComposite out`+`feGaussianBlur`+`feComposite in` | M | P2 | Cheap once the filter builder exists; a real gap vs. Figma. |
| Multiple shadows on one node | Canva allows one shadow per element | `SVG-FILTER` `feMerge` | S | P2 | An `effects[]` list handles this for free. Immediate win over Canva. |

### D.1 Outline (sticker border)

```xml
<filter id="fx-outline" x="-25%" y="-25%" width="150%" height="150%"
        color-interpolation-filters="sRGB">
  <feMorphology in="SourceAlpha" operator="dilate" radius="8" result="fat"/>
  <feFlood flood-color="#ffffff" result="c"/>
  <feComposite in="c" in2="fat" operator="in" result="ring"/>
  <feMerge>
    <feMergeNode in="ring"/>
    <feMergeNode in="SourceGraphic"/>
  </feMerge>
</filter>
```

`radius = thickness` in user units. `feMorphology dilate` is square-kernel in most implementations,
so at large radii corners read boxy; for a rounder border, follow the dilate with
`feGaussianBlur stdDeviation="radius/3"` and then a hard alpha threshold via
`feComponentTransfer/feFuncA type="linear" slope="20" intercept="-6"`.

### D.2 Angle (long shadow)

Two ways, and the cheap one is better:

**Skewed-silhouette (`NATIVE`, exact, deterministic):** duplicate the node behind itself with a
matrix that skews and squashes it toward the light direction, filled flat in the shadow colour.
For a shape or path this is exact; for an image, the silhouette must first be reduced to its alpha
(`feColorMatrix` to alpha + `feFlood` + `feComposite in`), so the image case is `SVG-FILTER`.

```xml
<g transform="translate(0 340) matrix(1 0 -0.55 0.28 0 0)" opacity="0.28">
  <use href="#node-42" fill="#000000"/>
</g>
```

**Stacked-offset (`SVG-FILTER`):** N `feOffset` copies of `SourceAlpha` at 1…N × (dx, dy), merged,
flooded and composited. Faithful to Canva's rendering (which does taper) but N is typically 20–40
primitives — a large `<defs>` and a slow filter. Use only if the skew approximation reads wrong on
concave shapes.

### D.3 Curve / Page Lift

Not a shadow of the object at all — a separate shape underneath it:

```xml
<defs>
  <linearGradient id="curve-fade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0"   stop-color="#000000" stop-opacity="0.45"/>
    <stop offset="1"   stop-color="#000000" stop-opacity="0"/>
  </linearGradient>
  <filter id="curve-blur" x="-20%" y="-20%" width="140%" height="140%"
          color-interpolation-filters="sRGB">
    <feGaussianBlur stdDeviation="10"/>
  </filter>
</defs>
<path d="M 120 470 Q 400 540 680 470 L 680 500 Q 400 570 120 500 Z"
      fill="url(#curve-fade)" filter="url(#curve-blur)"/>
```

The `Q` control point's y-offset is the Curve slider; a *negative* offset gives Page Lift's
double-corner variant (two mirrored quadratics meeting at centre). Everything here is plain SVG,
which is why this row is `M` and not `L`.

## E. Shapes & drawing

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Rectangle / square (`R`) | Insert, resize, corner radius slider | `NATIVE` | S | P0 | Shipped. |
| Ellipse / circle (`C`) | Insert, resize | `NATIVE` | S | P0 | Shipped. |
| Line (`L`) | Insert, weight, style | `NATIVE` | S | P0 | Shipped. |
| Triangle / polygon / star | Elements library shapes with point-count controls | `NATIVE` `<polygon>` / `<path>` | S | P0 | Parametric generators emitting `PathNode.d`. Cheap and high-value. |
| Arrow / arrowheads | Line end caps: arrow, circle, square, none, both ends | `NATIVE` `<marker>` | S | P1 | `marker-start` / `marker-end` in `<defs>`. `LineNode` needs `capStart`/`capEnd`. |
| Line style | Solid, dashed, dotted; weight slider | `NATIVE` | S | P0 | `stroke-dasharray` shipped; UI presets missing. |
| Corner radius | Per-shape slider; per-corner in newer builds | `NATIVE` | S | P1 | Uniform `rx/ry` shipped. Per-corner radii need a `<path>` with four arcs. |
| Speech bubbles, banners, badges | Hundreds of parametric-ish shapes in Elements | `NATIVE` | M | P1 | Ship as a bundled `PathNode` library — pure data, no engine change. |
| Stroke colour / width | Per element | `NATIVE` | S | P0 | Shipped. |
| Stroke alignment (inside/centre/outside) | Canva strokes shapes centred | `NATIVE` | M | P2 | SVG has no `stroke-alignment`. Emulate: outside = `paint-order` + 2× width + clip to inverse; inside = clip to the shape. |
| Flip horizontal / vertical | On any element | `NATIVE` | S | P0 | `transform="scale(-1,1)"` about the node centre. Needs `flipX`/`flipY` on `NodeBase`. |
| Rotate | Handle + numeric; snaps at 15° with Shift | `NATIVE` | S | P0 | Shipped (`rotation`). |
| Freehand draw | Draw tool: pen, marker, highlighter, glow pen; weight + transparency; eraser | `NATIVE` `<path>` | M | P1 | Capture pointer events → simplify (Ramer–Douglas–Peucker) → Catmull-Rom → cubic `d`. Highlighter = `stroke-opacity` + `mix-blend-mode:multiply`. Glow pen = the § D.1 glow filter on a path. |
| Bezier pen tool | Not in Canva | `NATIVE` | L | P2 | Differentiator vs Canva; ordinary work against `PathNode`. |
| Edit path points | Not in Canva (Canva shapes are fixed) | `NATIVE` | L | P2 | Same. |
| Boolean ops (union/subtract/intersect) | Not native to Canva | `NATIVE` (`<path>` after a JS boolean lib) or `NATIVE` (`clipPath`/`mask` without flattening) | L | P2 | Real path booleans need a library (e.g. polygon-clipping on flattened béziers). A non-destructive `mask`-based version is much cheaper and covers most uses. |
| Shape → frame conversion | Any shape can hold a photo | `NATIVE` `<clipPath>` | S | P1 | See § P. |

## F. Images & photo editing

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Upload image | Drag-drop, file picker, paste, camera | `NATIVE` | S | P0 | Shipped as content-addressed `Asset` data URIs. Watch document size — see the note in § W. |
| Place / move / resize | Handles, aspect lock with Shift | `NATIVE` | S | P0 | Shipped. |
| Crop | Drag crop handles; the *stored* image is untouched | `NATIVE` `<clipPath>` | M | P0 | The current model (`fit: cover/contain/fill`) cannot express an arbitrary crop. Needs `crop: {x,y,w,h}` in source-image space. This is a P0 gap. |
| Crop to shape / frame | Drop into any frame silhouette | `NATIVE` `<clipPath>` | M | P1 | § P. |
| Flip image | H / V | `NATIVE` | S | P0 | As above. |
| Rotate image | Free + 90° steps | `NATIVE` | S | P0 | Shipped. |
| Corner radius on image | Slider | `NATIVE` | S | P1 | Shipped (`radius` → `<clipPath><rect rx>`). |
| Element transparency | 0–100 slider | `NATIVE` | S | P0 | Shipped (`opacity`). |
| Replace image in place | Keeps crop and effects, swaps pixels | `NATIVE` | S | P1 | Swap `assetId`, keep everything else. Pure UI. |
| SVG import as editable vector | Canva imports SVG and lets you recolour parts | `NATIVE` | M | P1 | Parse → map to `path`/`group` nodes → **allowlist the `d` grammar and strip `<script>`/`<foreignObject>`/external refs**. `docs/SECURITY.md` territory; the schema comment already anticipates this. |
| Recolour a vector's parts | Click a colour swatch of an imported graphic | `NATIVE` | M | P1 | Falls out of the above once each sub-path is its own node. |
| Image link / attribution | Stock attribution metadata | `NATIVE` | S | P2 | Asset metadata field; matters for MIT licensing hygiene. |
| Smart crop / auto-focus | AI picks the subject when reframing | `WASM/ML` | L | P3 | Saliency model. A cheap non-ML heuristic (entropy-weighted centroid) covers 80 % of it at `M`. |
| **Background remover** | One click; subject cut out, background transparent | `WASM/ML` + `CANVAS` | XL | P2 | ONNX Runtime Web + a segmentation model (BiRefNet / MODNet / U²-Net, 10–170 MB). Output is a new raster asset — the *result* is then plain `NATIVE`. Non-deterministic ⇒ must never be inside a golden test. CLI can't run it. |
| Magic Eraser | Brush over clutter; it's inpainted away | `WASM/ML` + `CANVAS` | XL | P3 | Inpainting model (LaMa-class). Heavier than segmentation and much lower value for a design tool. |
| Magic Edit | Brush a region + a prompt → replaced content | `SERVER` / `WASM/ML` | XL | P3 | Diffusion. Out of scope. |
| Magic Expand | Outpaints the photo to fill a new aspect ratio | `SERVER` | XL | P3 | Out of scope. |
| Grab Text (OCR) | Select and edit text found inside a photo | `WASM/ML` | L | P3 | Tesseract-wasm is a plausible MIT path; low priority. |
| Face retouch | Smooths and enhances faces | `WASM/ML` | L | P3 | Out of scope. |
| Image → converted formats | HEIC/AVIF/WebP upload support | `NATIVE` | S | P2 | Browser decodes them; store the decoded PNG or keep the original bytes. |

## G. Image effects, filters & adjustments — the deep section

Canva's photo panel was reorganised in 2025: the single "Effects" tab was split, and **Blur, Auto
Focus and Face Retouch now live under Tools; Duotone moved to the end of Filters; Shadows became
its own section**. Adjustments live under **Adjust** and are grouped roughly **Light** (Brightness,
Contrast, Highlights, Shadows), **Colour** (Saturation, Tint/Hue, Warmth, Vibrance, Fade), and
**Texture** (Clarity, Sharpen, Vignette, Blur, Noise/Grain).
(https://www.canva.com/help/image-settings/ · https://www.canva.com/help/image-editor/ ·
https://bringyourownlaptop.com/blog/how-to-adjust-images-in-canva ·
https://graphicdesignresource.com/how-to-adjust-light-settings-of-canva-images/ ·
https://www.youtube.com/watch?v=43D28n-wJLQ)

**The whole section is one subsystem.** Every row below is a `<filter>` built by the same function
from an `ImageNode.adjustments` object; the marginal cost of the 15th slider is nearly zero once
the first three exist. Build the filter *builder*, not the sliders.

Canva's sliders run −100…+100 (0 = neutral) except where noted; the mappings below are **(inferred)**
and should be calibrated against Canva screenshots.

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| **Brightness** | Lightens/darkens overall | `SVG-FILTER` `feComponentTransfer/feFuncR,G,B type="linear"` | S | P0 | `slope=1, intercept = v/200` → ±0.5. |
| **Contrast** | Expands/compresses around mid-grey | `SVG-FILTER` `feComponentTransfer type="linear"` | S | P0 | `slope = 1 + v/100`, `intercept = (1 − slope)/2`. |
| **Saturation** | Colour intensity | `SVG-FILTER` `feColorMatrix type="saturate"` | S | P0 | `values = 1 + v/100`, range 0…2. Matrix spelled out below. |
| **Tint / Hue** | Rotates hue | `SVG-FILTER` `feColorMatrix type="hueRotate"` | S | P1 | `values = v × 1.8` degrees. |
| **Warmth / Temperature** | Warmer (amber) ↔ cooler (blue) | `SVG-FILTER` `feComponentTransfer` per-channel `linear` | S | P1 | `feFuncR slope = 1 + w`, `feFuncB slope = 1 − w`, `w = v/300`. Add a small `feFuncG slope = 1 + w/3` to avoid a green cast. |
| **Vibrance** | Boosts *under*-saturated pixels more than saturated ones | `SVG-FILTER` (approx) / `CANVAS` (exact) | M | P2 | Not a linear operator, so no exact matrix. Ship `feColorMatrix saturate` at ~0.6× strength and call it vibrance; only go to `CANVAS` if someone complains. |
| **Highlights** | Recovers/pushes the bright end only | `SVG-FILTER` `feComponentTransfer type="table"` | M | P1 | Tone curve; see the table recipe below. |
| **Shadows** (tonal) | Lifts/crushes the dark end only | `SVG-FILTER` `feComponentTransfer type="table"` | M | P1 | Same mechanism, lower control points. |
| **Fade / Wash** | Milky, lifted-black film look | `SVG-FILTER` `feComponentTransfer type="linear"` | S | P1 | `slope = 1 − f`, `intercept = f × 0.5`, `f = v/200`. |
| **Clarity** | Local (midtone) contrast — an unsharp mask at a large radius | `SVG-FILTER` `feGaussianBlur` + `feComposite operator="arithmetic"` | M | P1 | Recipe below. Genuinely doable in pure SVG, which surprises people. |
| **Sharpen** | Edge definition | `SVG-FILTER` `feConvolveMatrix` **or** small-radius unsharp | M | P2 | `feConvolveMatrix kernelMatrix="0 -1 0 -1 5 -1 0 -1 0"` is one primitive but is the slowest filter in SVG. Prefer unsharp. |
| **Blur** | Uniform gaussian blur slider | `SVG-FILTER` `feGaussianBlur` | S | P0 | `stdDeviation = v/100 × min(w,h) × 0.05`. |
| **Vignette** | Darkens the frame edges | `NATIVE` `<radialGradient>` + `<rect>` overlay | S | P1 | **No filter needed.** Recipe below. |
| **Noise / Grain** | Film grain overlay | `SVG-FILTER` `feTurbulence` + `feColorMatrix` + `feBlend` | M | P2 | **Must set `seed`.** Recipe below. |
| **Duotone** | Maps luminance onto two chosen colours (highlight + shadow); presets + custom hex + eyedropper | `SVG-FILTER` `feColorMatrix` (luminance) + `feComponentTransfer type="table"` | S | P1 | Recipe below. The cleanest SVG-filter win in the whole document. https://graphicdesignresource.com/how-to-use-duotone-in-canva/ |
| **Greyscale / B&W** | Filter preset | `SVG-FILTER` `feColorMatrix type="saturate" values="0"` | S | P1 | One line. |
| **Sepia** | Filter preset | `SVG-FILTER` `feColorMatrix type="matrix"` | S | P1 | Standard sepia matrix. |
| **Invert** | Negative | `SVG-FILTER` `feComponentTransfer type="table" tableValues="1 0"` | S | P2 | One line. |
| **X-Process** | Cross-processing: per-channel S-curves, crushed cyan shadows, yellow highlights | `SVG-FILTER` `feComponentTransfer type="table"` with *different* tableValues per channel | S | P2 | The archetypal per-channel-curve filter — see recipe. |
| **Filter presets** (Street, Retro, Summer, Epic, Festive, Afterglow, Edge, Bloom, Auto…) | ~30 named looks, each with an **Intensity** slider | `SVG-FILTER` | M | P1 | A preset is just a named bundle of the sliders above plus an optional duotone/curve. Intensity = lerp all params toward neutral. Data, not code. https://www.canva.com/features/photo-effects/ |
| Preset intensity slider | 0–100 on any preset | `SVG-FILTER` | S | P1 | As above — lerp. |
| Save custom preset | Canva: recreate manually; brand presets in Pro | `NATIVE` | S | P2 | Store the adjustment object under a name. Cheaply beats Canva. |
| Copy/paste style between images | Canva's "Copy style" paintbrush | `NATIVE` | S | P1 | Copy the `adjustments`/`effects` object. Applies to text too. |
| Adjustments on **video** | Same sliders apply to video clips | `NO` | — | P3 | § H. |
| Auto-enhance ("Auto") | One-click AI adjustment | `NATIVE` (histogram heuristic) | M | P2 | Auto-levels from a histogram computed once on a downsampled canvas — needs a raster read but not a model, and the *output* is just slider values, so the render stays pure SVG. |
| Auto Focus / portrait blur | Blurs background, keeps subject sharp | `WASM/ML` | L | P3 | Needs segmentation (§ F). |

### G.1 The saturate matrix, spelled out

`feColorMatrix type="saturate" values="s"` expands to:

```
0.213+0.787s   0.715−0.715s   0.072−0.072s   0   0
0.213−0.213s   0.715+0.285s   0.072−0.072s   0   0
0.213−0.213s   0.715−0.715s   0.072+0.928s   0   0
0             0              0              1   0
```

Worth writing out explicitly rather than using `type="saturate"` when you need to *fuse* saturation
with another matrix (e.g. saturation + warmth) into one primitive — fewer primitives is measurably
faster on large images.

`type="hueRotate" values="θ"` uses the same luminance weights with the rotation applied in the
chroma plane; use the shorthand, there is no reason to expand it.

### G.2 Highlights / Shadows / X-Process — tone curves as `tableValues`

`feComponentTransfer` with `type="table"` linearly interpolates between the supplied samples. Nine
samples give a curve smooth enough that no banding is visible at 8-bit:

```xml
<!-- Shadows +40 (lift the dark end), Highlights −25 (pull the bright end down) -->
<filter id="fx-tone" color-interpolation-filters="sRGB">
  <feComponentTransfer>
    <feFuncR type="table" tableValues="0.10 0.21 0.32 0.43 0.53 0.63 0.72 0.80 0.86"/>
    <feFuncG type="table" tableValues="0.10 0.21 0.32 0.43 0.53 0.63 0.72 0.80 0.86"/>
    <feFuncB type="table" tableValues="0.10 0.21 0.32 0.43 0.53 0.63 0.72 0.80 0.86"/>
  </feComponentTransfer>
</filter>
```

Generate the nine values from `f(t) = t + shadowAmt·(1−t)³ − highlightAmt·t³` sampled at
`t = 0, 1/8 … 1` and clamped to [0,1] **(inferred)** — that basis keeps each control confined to its
own end of the range, which is what "Highlights" and "Shadows" mean to a user.

**X-Process** is the same primitive with *different curves per channel*: push R up in the highlights,
pull B down in the shadows and up at the top, leave G near-linear with a slight S:

```xml
<feComponentTransfer>
  <feFuncR type="table" tableValues="0.00 0.10 0.26 0.44 0.62 0.78 0.90 0.97 1.00"/>
  <feFuncG type="table" tableValues="0.00 0.11 0.24 0.39 0.53 0.67 0.79 0.90 1.00"/>
  <feFuncB type="table" tableValues="0.12 0.20 0.30 0.40 0.50 0.60 0.70 0.82 0.94"/>
</feComponentTransfer>
```

### G.3 Duotone

Collapse to luminance, then map 0→shadow colour and 1→highlight colour with a two-entry table per
channel. For shadow `#0b1e3f` (11,30,63) and highlight `#f2c14e` (242,193,78):

```xml
<filter id="fx-duotone" color-interpolation-filters="sRGB">
  <feColorMatrix type="matrix" values="
    0.2126 0.7152 0.0722 0 0
    0.2126 0.7152 0.0722 0 0
    0.2126 0.7152 0.0722 0 0
    0      0      0      1 0"/>
  <feComponentTransfer>
    <feFuncR type="table" tableValues="0.043 0.949"/>
    <feFuncG type="table" tableValues="0.118 0.757"/>
    <feFuncB type="table" tableValues="0.247 0.306"/>
  </feComponentTransfer>
</filter>
```

`tableValues = [shadow.channel/255, highlight.channel/255]`. That is the entire feature — two
primitives and eight numbers. Add a third table entry for a midtone if a preset needs a tritone.

To *blend* duotone back toward the original at partial intensity, wrap with
`<feComposite operator="arithmetic" k2="intensity" k3="1−intensity" in2="SourceGraphic"/>`.

### G.4 Clarity (unsharp mask)

```xml
<filter id="fx-clarity" color-interpolation-filters="sRGB">
  <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur"/>
  <feComposite in="SourceGraphic" in2="blur" operator="arithmetic"
               k1="0" k2="1.35" k3="-0.35" k4="0"/>
</filter>
```

`k2 = 1 + a`, `k3 = −a`, where `a = clarity/100 × 0.6`. Large `stdDeviation` (≈ 2–4 % of the image's
short side) gives *clarity* / local contrast; `stdDeviation ≈ 1` with the same arithmetic gives
*sharpen*. Same two primitives, one number apart — build them as one function.

### G.5 Vignette — no filter at all

```xml
<defs>
  <radialGradient id="vig" cx="50%" cy="50%" r="75%">
    <stop offset="0.45" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1"    stop-color="#000000" stop-opacity="0.55"/>
  </radialGradient>
</defs>
<g clip-path="url(#img-clip-7)">
  <image …/>
  <rect x="…" y="…" width="…" height="…" fill="url(#vig)"/>
</g>
```

`stop-opacity` at the outer stop = `amount/100 × 0.8`; the inner stop's `offset` = `1 − feather`.
Reuse the image's existing `clipPath` (the renderer already creates one per image for corner radii),
so the vignette respects the crop and the corner radius for free. For a *white* vignette
(Canva's positive-direction slider), flip `stop-color` to `#ffffff`.

### G.6 Grain

```xml
<filter id="fx-grain" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"
                seed="7" stitchTiles="stitch" result="noise"/>
  <feColorMatrix in="noise" type="matrix" result="mono" values="
    0 0 0 0 0.5
    0 0 0 0 0.5
    0 0 0 0 0.5
    0 0 0 0.18 0"/>
  <feBlend in="SourceGraphic" in2="mono" mode="overlay"/>
</filter>
```

The `seed="7"` is not decoration — without it the golden test is a coin flip. The alpha row's `0.18`
is the grain amount. `baseFrequency` sets grain size and **is resolution-dependent**: it is in user
units, so a grain tuned at 1× will look wrong at a 4× PNG export unless the export scales the frequency
inversely. Note that in the export path.

## H. Video & audio

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Place a video clip | Video element on the canvas, plays in editor and export | `NO` (static SVG) | — | P3 | An SVG document is not a video container. Would require a second (canvas/ffmpeg) pipeline — the exact thing this architecture avoids. |
| Multi-track timeline | Layer video, audio and graphics on separate tracks; waveform display | `NO` | — | P3 | https://www.canva.com/help/creating-and-editing-videos/ |
| Trim / split / speed | Per-clip, with a speed slider for time-lapse and slow-mo | `NO` | — | P3 | |
| Transitions | Fades, dissolves, zooms between pages | `NO` (for export) / `CSS` (for on-screen presenting) | M | P2 | **Page transitions in presentation mode are cheap** — a CSS transition between two mounted SVG scenes. That is worth doing (§ X); video *export* is not. |
| Audio track / music library | Upload or pick from 25k+ licensed tracks; volume, fade in/out | `NO` | — | P3 | |
| Beat Sync | Auto-cuts clips to the music's beat | `NO` | — | P3 | |
| Auto-captions / subtitles | Pro; speech-to-text over the clip | `NO` | — | P3 | |
| Record yourself / talking presentation | Webcam + screen record, embedded in the design | `NO` | — | P3 | |
| Animated GIF export | Exports page/element animations | `CANVAS` | XL | P3 | Needs rasterisation per frame. Deliberately out of scope; see § T for the SMIL/CSS alternative. |

**Position to take:** video is where a local-first, SVG-first tool should say no out loud. Everything
in this block requires a raster/temporal pipeline that would double the codebase and break the
"one renderer" invariant. Document it as a non-goal rather than leaving it as an implied gap.

## I. Elements library

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Searchable element panel | 100M+ assets: photos, graphics, video, audio, charts, frames, grids, stickers | `NATIVE` | M | P0 | The *panel* is P0; the 100M assets are not obtainable. https://www.canva.com/pro/premium-content/ |
| Bundled vector icon set | Millions of icons | `NATIVE` | S | P0 | Ship an MIT/CC0 set (Lucide, Feather, Bootstrap Icons, Material Symbols) as `PathNode` data. Thousands of icons ≈ a few hundred KB. |
| Bundled shape library | Banners, bubbles, blobs, arrows, frames | `NATIVE` | M | P1 | Same mechanism. Own-authored or CC0. |
| Stock photos | Licensed library | `SERVER` | — | P3 | Not obtainable without a backend and licensing. Offer an *optional*, user-configured provider key instead (Unsplash/Pexels) so the core stays server-less. |
| Stock video / audio | Licensed library | `SERVER` | — | P3 | |
| Stickers / animated GIFs | Giphy-backed | `SERVER` | — | P3 | |
| "Recently used" / favourites | Per-user | `NATIVE` | S | P2 | Local storage. |
| Uploads library | User's own media, folders, search | `NATIVE` | M | P0 | Local: IndexedDB + content-addressed asset store, which the schema already implies. |
| Drag-drop from panel to canvas | Standard | `NATIVE` | S | P0 | Editor interaction. |
| Element "styles"/collections | Curated packs matched to a template | `NATIVE` | S | P2 | Metadata over the bundled set. |

## J. Templates

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Template gallery | 3M+ templates, searchable by keyword and size | `NATIVE` | M | P1 | `packages/templates` exists. Templates *are* documents — no engine work, only content. |
| Apply template to existing design | Swaps layout, keeps your content where it can | `NATIVE` | L | P2 | Content-preserving remap is a real algorithm (match by role: title/body/image slot). Needs a `role` field on nodes. |
| Template "styles" (colour + font swap) | One click restyles a template | `NATIVE` | M | P1 | Requires nodes to reference palette/style *tokens* rather than literal hex. Design that in early — retrofitting is painful. |
| Save design as template | Reusable starting point | `NATIVE` | S | P1 | Serialise the document with a flag. |
| Brand Templates | Pro; locked-down templates for a team | `NATIVE` | M | P2 | § K. |
| Template placeholders | Text/image slots that prompt "click to replace" | `NATIVE` | S | P1 | A `placeholder: true` flag + `role`. Small change, large UX effect. |

## K. Brand kit

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Brand colour palettes | Named palettes, multiple per brand | `NATIVE` | S | P1 | Document- or app-level data. https://www.canva.com/help/brand-kit/ |
| Brand fonts | Assign Heading/Subheading/Body faces; upload custom | `NATIVE` + `CSS` | M | P1 | Depends on the font-embedding work in § B. |
| Logos | Upload, one click to place | `NATIVE` | S | P1 | Just assets with a tag. |
| Brand voice | AI writes in your tone | `SERVER`/`WASM-LLM` | XL | P3 | Out of scope. |
| Brand photos / graphics / icons | Tagged asset collections | `NATIVE` | S | P2 | |
| Brand Controls | Restrict a team to brand colours/fonts only | `NATIVE` | M | P3 | Meaningless without accounts/teams. |
| Multiple Brand Kits | Switch between brands | `NATIVE` | S | P2 | |
| Auto brand kit from a website/logo | AI extracts palette + fonts from a URL | `NATIVE` (palette) / `SERVER` (fetch) | M | P2 | Palette extraction from an *uploaded* logo is a k-means over pixels — local, deterministic enough, no server. Do that, skip the URL fetch. |

## L. Layout & alignment

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Align to selection (L/C/R, T/M/B) | Position → Align | `NATIVE` | S | P0 | Pure geometry on the document. |
| Align to page | When one element is selected | `NATIVE` | S | P0 | |
| Distribute / space evenly | Horizontally / vertically | `NATIVE` | S | P0 | |
| Tidy up | Snaps a messy selection into clean rows/columns | `NATIVE` | M | P2 | Cluster by row, then distribute. Nice, not necessary. |
| Smart guides while dragging | Edge/centre alignment lines and equal-gap badges | `NATIVE` | M | P0 | The feature that most makes a tool feel professional. |
| Nudge 1 px / 10 px | Arrows / Shift+Arrows | `NATIVE` | S | P0 | |
| Numeric position & size panel | X, Y, W, H, rotation, with lock-aspect | `NATIVE` | S | P0 | |
| Auto-layout / stacks | Not in Canva (Figma has it) | `NATIVE` | L | P2 | Differentiator; a real layout engine addition. |
| Duplicate with offset / repeat | `Ctrl D` repeats the last offset | `NATIVE` | S | P1 | |
| Copy/paste, paste in place | Standard | `NATIVE` | S | P0 | |
| Multi-select (marquee, Shift-click) | Standard | `NATIVE` | S | P0 | Hit-testing comes free from mounting the scene as real DOM. |

## M. Grouping & layers

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Group / ungroup (`Ctrl G`) | Standard | `NATIVE` | S | P0 | `GroupNode` shipped. |
| Nested groups | Yes | `NATIVE` | S | P0 | Shipped (recursive). |
| Enter group / select child | Double-click drills in | `NATIVE` | S | P0 | Editor interaction; `nodeId` is already on every emitted element. |
| Move a group | Drag moves every child | `NATIVE` | S | P0 | Shipped. Needed a `translate` command: `makeGroup` keeps children in artboard space and the renderer emits no group transform, so patching `x`/`y` moved the handles and nothing drawn. `updateNode` now refuses an x/y change on a group. |
| **Resize a group** | Corner handle scales the whole subtree, font sizes and stroke widths with it | `NATIVE` | M | **SHIPPED** | Handles are shown and drive `scale`, which multiplies the whole subtree — positions, sizes, font sizes, stroke widths, effect offsets — about the pinned corner. The Inspector's W/H do the same, pinning the top-left; before this they patched a field nothing read, which is a control that silently does nothing. A subtree holding a rotated child refuses a one-axis stretch and says why in a toast (a rotated box stretched unevenly is a parallelogram, which no node can represent), rather than failing quietly. |
| **Derive group bounds instead of storing them** | n/a — internal | `NATIVE` | M | **SHIPPED** | `engine.nodeBox(n)` is the single derivation and every reader calls it: the renderer's rotation pivot, the selection rectangle and its eight handles, the canvas hit test, the marquee, drag origins, align/distribute, and the Inspector's X/Y/W/H. The stored `x/y/width/height` is still written by `scale` and `translate` — they keep it *consistent* rather than *correct*, and it remains the fallback for an empty group, which has nothing to derive from. Nothing reads it otherwise, so the staleness that used to reach the screen no longer can. Verified in the running editor on `groups-and-shadow.json`, whose `g-plain` stores 240 wide against children spanning 230: the Inspector reads 230 and the handles sit on the artwork. |
| Bring forward / send backward | `Ctrl ]` / `Ctrl [` | `NATIVE` | S | P0 | Array reorder. |
| Bring to front / send to back | `Ctrl Alt ]` / `[` | `NATIVE` | S | P0 | |
| Layers panel | Named, reorderable list with thumbnails; drag to reparent | `NATIVE` | M | P1 | https://www.canva.com/help/finding-and-arranging-layers/ |
| Lock / unlock | Prevents selection and edits | `NATIVE` | S | P1 | `locked` shipped in schema; needs UI enforcement. |
| Hide / show | Per element | `NATIVE` | S | P1 | `visible` shipped (renderer returns `null`). |
| Rename element | For the layers panel | `NATIVE` | S | P1 | `name` shipped. |
| Isolate/solo a layer | Not in Canva | `NATIVE` | S | P2 | Trivial once the layers panel exists. |

## N. Colour

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Solid colour picker | Wheel/field + hex input + recent | `NATIVE` | S | P0 | |
| Eyedropper / colour picker from canvas | Pick any colour on the canvas | `NATIVE` | M | P1 | With a DOM-mounted SVG, `EyeDropper` API where available, else a canvas snapshot read. https://www.canva.dev/blog/engineering/picking-color-via-eyedropper-on-web-app/ |
| Photo colours | Extracts 5 dominant colours from the selected image | `NATIVE` | M | P1 | k-means/median-cut on a downsampled canvas read. Local, no model. |
| Document colours | All colours in use, sorted by HSL | `NATIVE` | S | P1 | Document walk. |
| Gradient fills | Linear gradients on shapes/backgrounds | `NATIVE` `<linearGradient>` | S | P0 | Shipped for shapes/background. |
| Radial / conic gradients | Canva has gradient *elements*; radial via graphics | `NATIVE` `<radialGradient>` / `NO` (conic) | S | P1 | Radial is one more `Fill` variant. **SVG has no conic gradient** — fake it with N discrete stops in a radial-plus-mask, or skip. |
| Multi-stop gradients, stop editing | Gradient elements with editable stops | `NATIVE` | S | P1 | Schema already allows N stops; the UI is the gap. |
| Colour palette generator | Suggests palettes | `NATIVE` | M | P2 | Harmony rules (complementary, triadic) are 30 lines of HSL maths. |
| Recolour whole design | Swap a palette across every element | `NATIVE` | M | P1 | Needs colour *tokens* (see § J). Design this with templates, not after. |
| Transparency per colour | 8-digit hex / alpha slider | `NATIVE` | S | P0 | `Hex` regex already accepts 8 digits. |
| CMYK / spot colour for print | Canva converts on PDF Print export | `NO` (in-browser) | — | P3 | Real CMYK needs ICC profiles and a PDF writer. Note it as a print limitation. |

## O. Transparency & blending

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Element transparency slider | 0–100 % on any element | `NATIVE` `opacity` | S | P0 | Shipped. |
| Blend modes | Multiply, Screen, Overlay, Soft Light, Darken, Lighten and more, reached through the transparency panel; more modes on Pro | `CSS` `mix-blend-mode` | M | P1 | SVG honours `mix-blend-mode` as a CSS property, and `isolation:isolate` on the parent `<g>` controls the backdrop group. **The CLI must emit it as a `style="mix-blend-mode:multiply"` presentation string, not a stylesheet**, so a standalone `.svg` file keeps it. `feBlend` is the filter fallback but composites only against a filter input, not the page — not equivalent. https://www.temperstack.com/learn/canva/use-blending-modes/ |
| Group opacity vs. per-child | Group transparency applies to the flattened group | `NATIVE` | S | P1 | Already correct: `opacity` on the wrapper `<g>`. |
| Knockout / isolate groups | Implicit in Canva | `CSS` `isolation` | S | P2 | One attribute on group wrappers. |
| Gradient (soft) edge fade | Achieved in Canva with gradient overlays | `NATIVE` `<mask>` + gradient | S | P1 | A real "fade edges" control is a mask with a gradient — cheaper and better than Canva's manual overlay trick. |

## P. Frames & masks

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Frames | Silhouette shapes you drop a photo into; the photo crops to the shape and can be repositioned inside | `NATIVE` `<clipPath>` | M | P1 | A `FrameNode` = a `PathNode` `d` + an optional child image with its own `crop`. The renderer already emits `<clipPath>` per image, so the plumbing exists. https://designhub.co/how-to-use-frames-in-canva/ |
| Grids | Multi-cell frames that tile the page; drag borders to resize cells; each cell holds its own image with its own filters | `NATIVE` | L | P1 | A grid is a frame *container* with resizable gutters. Model it as a group of frames plus a shared gutter value. |
| Drag-drop image onto frame | Drop directly on the frame, not the canvas | `NATIVE` | S | P1 | Editor hit-testing. |
| Reposition/zoom image inside frame | Double-click to adjust | `NATIVE` | S | P1 | Falls out of `crop`. |
| Text/shape as a mask | "Mask" tricks via frames | `NATIVE` `<clipPath>` / `<mask>` | M | P1 | `<clipPath>` for hard-edged, `<mask>` for soft/gradient. Both cheap. |
| Alpha (luminance) mask | Canva approximates via overlays | `NATIVE` `<mask>` + `mask-type="luminance"` | M | P2 | Strictly more capable than Canva here. |
| Frame border / stroke | Frames can be styled | `NATIVE` | S | P2 | Stroke the frame path over the clipped image. |

## Q. Charts & data

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Chart element | 30+ types: bar, stacked bar, line, pie, donut, area, scatter, bubble, dot plot, radar, histogram, funnel, hierarchy, bar race | `NATIVE` | L | P1 | Charts are *the* natural fit for an SVG-first tool — a chart is a pure function from data to a scene graph. https://www.canva.com/help/chart-types/ |
| Inline data table editor | Type data, or paste from a spreadsheet | `NATIVE` | M | P1 | Small grid editor writing into `ChartNode.data`. |
| Import CSV / XLSX | Upload a file to populate a chart | `NATIVE` (CSV) / `NATIVE` + lib (XLSX) | M | P2 | CSV is trivial; XLSX needs a parser dependency. |
| Chart styling | Colours, labels, legend, gridlines, axis format, data labels, markers, trend lines | `NATIVE` | L | P1 | The bulk of the work. Cap the v1 at bar/line/pie/donut/area + scatter. |
| Live data connection | Google Sheets etc. | `SERVER` | — | P3 | |
| Animated / interactive charts | Bar race, hover tooltips | `CSS`/`NATIVE` SMIL | L | P3 | |
| Bulk Create / Data Autofill | Generate N designs from a CSV/XLSX by mapping columns to elements | `NATIVE` | M | — | **SHIPPED** (`artboard bulk <template.json> --data rows.csv --out dir`). csv/tsv/json in; svg/pdf/json out, through the same `buildVectorExport` as `export`. Mapping is `{{column}}` anywhere in the template, substituted into the raw text BEFORE parsing so a placeholder may sit in a schema-constrained field (`"color": "{{accent}}"`, `"x": {{left}}`). XLSX is not read: it is a zip of XML and a wrong-but-plausible reader is worse than none -- export to CSV. No editor UI yet. https://www.canva.com/help/bulk-create-data-autofill/ |
| Magic Charts / Magic Insights | AI picks a chart type and writes the takeaway | `SERVER` | — | P3 | |

## R. Tables

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Insert table | `/table`, choose rows × columns | `NATIVE` | M | P1 | A `TableNode` rendering to nested `<rect>` + `<text>`. https://www.canva.com/help/tables/ |
| Add/delete row & column | Hover-plus and the `…` menu | `NATIVE` | S | P1 | Document mutation. |
| Merge / unmerge cells | Shift-select, right-click → Merge | `NATIVE` | M | P1 | Needs a `colSpan`/`rowSpan` cell model. https://www.canva.com/help/merging-and-unmerging-cells/ |
| Resize rows/columns | Drag internal borders | `NATIVE` | S | P1 | Column widths / row heights arrays. |
| Cell fill, border colour & width, padding | Per-cell and per-table | `NATIVE` | M | P1 | |
| Table styles / alternating rows | Presets | `NATIVE` | S | P2 | |
| Cell text formatting | Full text controls per cell | `NATIVE` | M | P1 | Each cell is a text layout — reuses `layoutText`. Row height should auto-grow from measured text. |
| Paste a spreadsheet range | Paste from Excel/Sheets creates a table | `NATIVE` | S | P2 | Parse clipboard `text/html` or TSV. High value per line of code. |

## S. QR codes & barcodes

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| QR code generator | Elements → QR code; enter URL; static codes, with dynamic (tracked) codes via an app | `NATIVE` | S | P1 | QR encoding is a well-understood pure function; several MIT JS libs emit a module matrix. Render as one `<path>` of merged modules, or `<rect>` per module. Deterministic ⇒ golden-testable. https://www.canva.com/qr-code-generator/ |
| QR styling | Colour, background, embedded logo, rounded modules | `NATIVE` | S | P2 | Colour is free. Logo = an `<image>` centred with the error-correction level raised to H. |
| Dynamic / trackable QR | Editable destination, scan analytics | `SERVER` | — | P3 | Requires a redirect service. Explicit non-goal. |
| AI-styled QR (Pirate Ship, Unicorn…) | Diffusion-styled scannable codes | `SERVER` | — | P3 | |
| Barcodes (EAN, Code128) | Via apps | `NATIVE` | S | P2 | Same shape of problem as QR; a small encoder + `<rect>` bars. |

## T. Animation

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Element animations | ~20 presets: block, typewriter, ascend, bounce, burst, roll, shift, skate, breathe, fade, pan, rise, tumble (free); drift, stomp, tectonic, baseline, pop, neon, scrapbook (Pro) | `CSS` keyframes / `NATIVE` SMIL | M | P2 | Both work in a browser; **SMIL (`<animateTransform>`) survives in a standalone `.svg` file**, CSS keyframes need an inline `<style>` — and Chrome dropped nothing, but SMIL is deprecated-ish and unsupported in some renderers. Recommend CSS keyframes emitted into `<defs><style>`. https://www.canva.com/help/animate-designs/ |
| Page animations | The same presets applied to every element on a page | `CSS` | S | P2 | Composition of the above. |
| Page transitions | Dissolve, slide, circle wipe, colour wipe, match & move | `CSS` | M | P2 | Only meaningful in presentation mode (§ X) — and there it is cheap. |
| Animation timing controls | Speed, direction, delay | `CSS` | S | P2 | |
| Per-element animation ordering | Sequence within a page | `CSS` `animation-delay` | S | P2 | |
| Animated export (GIF/MP4) | Renders the animation to a file | `CANVAS` | XL | P3 | The reason animation is P2 not P1: it does not export without a raster pipeline. It is still worth having on-screen for presentations and for animated-SVG web embeds. |
| Animated SVG export | Not a Canva feature | `CSS`/`NATIVE` | S | P2 | Free once animations are CSS in `<defs>` — a genuine capability Canva lacks. |

## U. Collaboration

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Real-time multi-user editing | Live cursors, instant sync | `SERVER` | — | P3 | Against the local-first, no-server premise. A CRDT (Yjs/Automerge) over WebRTC would be the server-less version — genuinely possible, but XL and a different product. |
| Comments & @mentions | Threaded, resolvable, pinned to elements | `SERVER` (sync) / `NATIVE` (data) | L | P3 | The *data model* (comments anchored to `nodeId`) is cheap; delivery is not. |
| Share link with view/comment/edit roles | Permissions per link | `SERVER` | — | P3 | |
| Version history | 1,000 versions with per-version author avatars | `NATIVE` | M | P2 | Local snapshot log — listed in § A. This is the collaboration-adjacent feature that *does* fit. |
| Approval workflows | Draft → review → approved | `SERVER` | — | P3 | |
| Team folders / permissions | Org structure | `SERVER` | — | P3 | |
| Export/import a design file to hand around | Canva has no true file format | `NATIVE` | S | P1 | Artboard's advantage: the document *is* a file. `.artboard.json` + assets inline. Position this as the answer to collaboration. |

## V. AI features (Magic Studio)

Canva's AI surface as of Canva Create 2025: **Canva AI** (conversational design), **Magic Write**,
**Magic Media** (text→image/video), **Dream Lab**, **Magic Design**, **Magic Edit**, **Magic Eraser**,
**Magic Grab**, **Magic Expand**, **Magic Switch/Resize**, **Background Remover**, **Magic Animate**,
**Translate**, **Brand Voice**, **Magic Charts / Formulas / Insights**, **Canva Code**.
(https://www.canva.com/newsroom/news/canva-create-2025/ ·
https://www.canva.com/newsroom/news/canva-ai-launches/)

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| **Magic Resize / Switch (resize)** | Reflows a design into other sizes | `NATIVE` | L | **P1** | **Not actually AI.** See [§ Magic Resize](#magic-resize-without-ai) — it is constraint-based relayout, and it is the highest-value item in this whole section. |
| Background Remover | One-click subject cut-out | `WASM/ML` | XL | P2 | The one ML feature worth the weight. MIT-compatible models exist (U²-Net, MODNet, BiRefNet via ONNX Runtime Web). Ship as an **optional lazy-loaded plugin**, never a core dependency; result is a new raster asset so the renderer stays pure. |
| Magic Write | Generates/rewrites copy in the editor | `SERVER` | XL | P3 | Optional BYO-key integration at most. Keep out of core. |
| Magic Media / Text-to-Image | Prompt → image | `SERVER` | XL | P3 | Same. |
| Dream Lab | High-fidelity generation with style references | `SERVER` | XL | P3 | |
| Magic Design | Prompt or upload → a whole finished design | `SERVER` | XL | P3 | A *non-AI* version — "pick a template and auto-fill my content" — is a `M` and covers most of the real use. |
| Magic Edit / Grab / Expand | Inpaint, extract a subject, outpaint | `SERVER` / `WASM/ML` | XL | P3 | § F. |
| Magic Animate | Auto-applies animations | `NATIVE` (heuristic) | S | P3 | A rules table ("titles rise, images fade") reproduces it without a model. |
| Translate | 100+ languages, in place | `SERVER` | — | P3 | |
| Brand Voice | Writes in your tone | `SERVER` | — | P3 | |
| Magic Charts / Formulas / Insights | Data → chart + narrative | `SERVER` | — | P3 | The non-AI chart builder (§ Q) is the part worth having. |
| Canva Code | Generates embeddable interactive widgets | `NO` | — | P3 | |
| AI alt-text suggestions | Describes an image for accessibility | `WASM/ML` | L | P3 | § Y. |

**Recommended stance:** treat AI as strictly optional and strictly at the *edges*. Anything that
generates pixels or prose belongs behind a user-supplied API key in an optional plugin; anything
that is really an algorithm wearing an AI label (Magic Resize, Magic Animate, auto-enhance, palette
extraction, smart crop) should be built as the algorithm. That keeps the core MIT, offline,
deterministic and golden-testable.

## W. Export & publishing

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| PNG export | With size/scale multiplier; **transparent background (Pro)** | `CANVAS` | M | P0 | Browser: serialise the scene → blob URL → `<img>` → `<canvas>` → `toBlob`. **Fonts and data-URI assets must already be inlined or the raster comes out blank/fallback** — this is the classic SVG→canvas trap. CLI: needs `resvg-js` or similar. |
| JPG export | Quality slider | `CANVAS` | S | P0 | Same path + `toBlob('image/jpeg', q)`. |
| **SVG export** | Pro only in Canva | `NATIVE` | S | **P0** | Artboard's structural advantage: this is `renderToString()`, already implemented, and it is *free and lossless* where Canva paywalls it. Lead with it. |
| PDF Standard (96 dpi) | Screen-quality PDF | `NATIVE` + lib | M | P0 | `svg2pdf.js` + `jsPDF`, or emit PDF directly. Text must stay selectable — that means embedding the font subset, which ties back to § B. |
| PDF Print (300 dpi) + bleed + crop marks | Print-ready | `NATIVE` + lib | M | P1 | Bleed = expand the viewBox; crop marks = eight short lines. CMYK conversion is the part that genuinely can't be done well in-browser — say so. |
| Multi-page export | All pages, or a selection | `NATIVE` | S | P0 | Loop `renderArtboard`. |
| Export scale / quality | 0.5×–5× | `CANVAS` | S | P0 | One multiplier on the raster path. **Remember the `feTurbulence baseFrequency` scaling issue (§ G.6).** |
| Transparent background | PNG/SVG | `NATIVE` | S | P1 | Skip the background `<rect>` when `background.kind === 'none'`. Two lines. |
| Compress / file-size options | Pro | `CANVAS` | S | P2 | JPEG quality + PNG bit-depth reduction. |
| PPTX export | Editable PowerPoint | `NATIVE` + lib | L | P2 | `pptxgenjs` can take shapes/text/images; effects degrade. Real value for the presentation use case. |
| GIF / MP4 export | Animated designs | `CANVAS` | XL | P3 | § H, § T. |
| CSV export | From Sheets/charts | `NATIVE` | S | P2 | |
| Publish as website | Canva Sites, custom domain | `SERVER` | — | P3 | A static HTML+SVG bundle export is the local-first equivalent — `S`, and worth doing. |
| Share link / embed | Public/private links | `SERVER` | — | P3 | |
| Print products | Canva Print fulfilment | `NO` | — | P3 | |
| Social scheduling | Content Planner | `SERVER` | — | P3 | |
| Print-with-a-partner / print preview | Preview with bleed | `NATIVE` | S | P2 | |

## X. Presentation mode

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Full-screen present | `Ctrl Enter`; arrow keys to navigate | `NATIVE` | S | P1 | Mount one artboard scaled to the viewport. Nearly free. https://www.canva.com/help/presenting-designs/ |
| Presenter view | Second window: notes, timer, next-slide preview | `NATIVE` | M | P2 | `window.open` + `BroadcastChannel`. No server. |
| Presenter notes | Per-slide script | `NATIVE` | S | P2 | § A. |
| Timer | Press 0–9 to start a countdown (0 = 3-second) | `NATIVE` | S | P2 | |
| Magic Shortcuts | `?` opens a menu; letter keys drop confetti, blur, drum roll, emoji, quiet | `NATIVE`/`CSS` | M | P3 | Fun; pure DOM overlay. `B` (blur the screen) is a CSS `backdrop-filter`. |
| Autoplay / self-running | Timed advance, loop | `NATIVE` | S | P2 | |
| Page transitions | Dissolve/slide/wipe between slides | `CSS` | M | P2 | § T. |
| Remote control / multi-presenter | Phone as clicker; co-presenters | `SERVER` | — | P3 | |
| Offline presenting | Present without connectivity | `NATIVE` | S | P1 | Already true by construction — worth stating as a feature. |
| Record a talking presentation | Webcam + slides → video | `NO` | — | P3 | |

## Y. Accessibility

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Alt text on elements | Describe or mark decorative; AI suggestions | `NATIVE` | S | P1 | `<title>`/`<desc>` children + `role="img"`/`aria-hidden`. Two lines in the renderer, real accessibility value, and it survives into exported SVG. https://www.canva.com/help/using-design-accessibility/ |
| Colour-contrast checker | Flags low-contrast text before export | `NATIVE` | S | P1 | WCAG 2.x contrast ratio is ~15 lines. Report through the existing `Diagnostic` channel — the schema already has `diagnostics[]` with levels and `nodeId`, which is exactly the right shape. |
| Typography accessibility checks | Flags too-small type, tight tracking | `NATIVE` | S | P1 | Same `Diagnostic` channel. |
| Reading order | Control the order a screen reader announces | `NATIVE` | M | P2 | DOM order in the emitted SVG *is* the reading order — so this is a per-artboard ordering field applied at serialise time. |
| Tagged / accessible PDF export | Heading tags + reading order in the PDF | `NATIVE` + lib | L | P2 | Depends on the PDF writer. Note Canva's own checker doesn't validate tags either. https://venngage.com/blog/canva-accessibility-review/ |
| Editor keyboard navigation | Tab through the UI, screen-reader labels | `NATIVE` | M | P1 | Editor-shell work, not renderer work. |
| Colour-blindness simulation | Not in Canva | `SVG-FILTER` `feColorMatrix` | S | P2 | Protanopia/deuteranopia/tritanopia matrices are published constants. Beats Canva for ~20 lines. |
| Reduced motion | Respect `prefers-reduced-motion` | `CSS` | S | P2 | Gate the § T animations. |

## Z. Keyboard shortcuts

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Tool shortcuts | `T` text · `R` rectangle · `C` circle · `L` line · `E` elements · `I` images | `NATIVE` | S | P0 | https://www.canva.com/design-school/resources/canva-editor-shortcuts |
| Edit | `Ctrl Z` / `Ctrl Shift Z` / `Ctrl C` / `Ctrl V` / `Ctrl D` / `Del` | `NATIVE` | S | P0 | |
| Text formatting | `Ctrl B/I/U`, `Ctrl Shift >`/`<`, `Ctrl Shift L/E/R/J` | `NATIVE` | S | P0 | |
| Arrange | `Ctrl ]` / `Ctrl [` / `Ctrl Alt ]` / `Ctrl Alt [` | `NATIVE` | S | P0 | |
| Group / lock | `Ctrl G` / `Ctrl Shift G` / `Alt Shift L` | `NATIVE` | S | P0 | |
| Selection | `Ctrl A`, `Esc`, `Shift`-click, marquee | `NATIVE` | S | P0 | |
| Nudge | Arrows (1 px) / `Shift`+Arrows (10 px) | `NATIVE` | S | P0 | |
| View | `Ctrl +/-`, `Ctrl Shift H` fit, `Ctrl ;` guides, `Ctrl R` rulers | `NATIVE` | S | P1 | |
| Pages | `Ctrl Enter` add page / present | `NATIVE` | S | P1 | |
| Shortcut cheat-sheet overlay | `Shift /` | `NATIVE` | S | P2 | |
| Rebindable shortcuts | Not in Canva | `NATIVE` | M | P2 | Differentiator. |

## AA. Import / export formats

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Import PNG/JPG/WebP/HEIC/AVIF/GIF | Uploads | `NATIVE` | S | P0 | |
| Import SVG | As an editable graphic | `NATIVE` | M | P1 | § F — with an allowlisted path grammar and no scripts/external refs. |
| Import PDF | Converts pages to editable elements | `CANVAS` + lib | L | P2 | `pdf.js` gets you page rasters cheaply and *editable vectors + text* expensively. Ship the raster version first and say so. |
| Import PPTX | Converts to a Canva presentation | `NATIVE` + lib | L | P3 | High effort, low payoff. |
| Import DOCX | Into Canva Docs | `NO` | — | P3 | |
| Import Figma | Via an app | `NATIVE` + lib | L | P3 | Figma's REST API needs a token and network. |
| Import fonts (TTF/OTF/WOFF2) | Brand Kit upload | `NATIVE` | M | P1 | § B. |
| Export PNG/JPG/SVG/PDF/PPTX/CSV | § W | — | — | — | See § W. |
| Native document format | Canva has none — designs are locked in the cloud | `NATIVE` | S | **P0** | Already the project's core advantage: a plain, versioned, Zod-validated JSON document with inlined assets, plus a documented migration path. Lead the README with it. |

## AB. Platform & everything else

| Feature | What Canva does | SVG feasibility | Effort | Priority | Notes |
|---|---|---|---|---|---|
| Desktop app | Mac/Windows | `NATIVE` | M | P1 | Electron is already planned; the renderer is unchanged. |
| Mobile / tablet app | iOS/Android with touch editing | `NATIVE` | XL | P3 | |
| Offline editing | Limited in Canva | `NATIVE` | S | P0 | True by construction. State it loudly. |
| Apps / plugin ecosystem | 100s of third-party apps in the editor | `NATIVE` | L | P2 | An MIT plugin API over the document + scene graph is a strong long-game move; not a v1. |
| CLI rendering | Canva has none | `NATIVE` | — | — | Shipped (`packages/cli`). Bulk Create (§ Q) is the killer app for it. |
| Content Planner / scheduling | Publish to socials | `SERVER` | — | P3 | |
| Canva Docs / Whiteboards / Sites / Sheets | Adjacent products in the Visual Suite | varies | XL | P3 | Different document models. Out of scope. |
| Analytics / design insights | View metrics on shared designs | `SERVER` | — | P3 | |
| Print fulfilment | Canva Print | `NO` | — | P3 | |

---

## Magic Resize, without AI

Canva markets Magic Resize / Magic Switch as AI. It is not — it is constraint-based relayout, and
it is entirely tractable here. The algorithm that reproduces ~90 % of the observed behaviour:

1. **Classify each node's anchoring** from its position in the source artboard: which page edges it
   is nearest (within ~8 % of the dimension), whether it is centred on either axis, and whether it
   spans nearly the full width/height. Store as `{left|centre|right|stretch} × {top|middle|bottom|stretch}`.
2. **Scale factor** `k = min(newW/oldW, newH/oldH)` for *sizes*; positions map by anchoring, not by `k`.
3. **Reposition** each node by resolving its anchors against the new frame, preserving its distance
   from anchored edges (scaled by that axis's ratio, clamped).
4. **Rescale** text by `k`, then re-run `layoutText` and let auto-fit (§ B) resolve overflow — this
   is where the reflow "intelligence" actually lives.
5. **Groups** resolve recursively against their own bounding box.

Only step 1 involves judgement, and a rules table beats a model at it. Effort `L`, priority P1,
and it makes the tool feel far more capable than the code justifies.

**Geometry shipped** as `engine.classifyAnchors` / `engine.reanchor` / `engine.resizeFactor` — pure
box functions, no `Node` and no `Document`, so the classifier is testable against nothing but
numbers. Two corrections to step 1 as written above, both found by running it rather than reading it:

- **Classify from the two margins, not from bands.** The literal reading — edge-bound within ~8% of
  the dimension, centred within a tolerance, otherwise fall back — classified all ten nodes of
  `social-editorial-quote` as `centre/middle`. A kicker 100px down a 1080 frame is 9.3% from the
  top: outside the edge band, nowhere near the centre band, and swallowed by the fallback. Every
  band rule has that hole. Comparing `before` and `after` margins has none — either they are close
  (centred) or one is smaller (that edge), with no third case and no threshold deciding *whether* a
  node is anchored, only which way. After the change the same design reads header-top,
  signature-block bottom-left, mark bottom-right, and `deck-stat-trio` classifies its three columns
  left / centre / right with its topbar `stretch/top`.
- **A degenerate classifier is invisible to the obvious test.** One returning `centre` for
  everything passes any assertion that nodes are still on the page. What catches it is asserting the
  *relationship* survives — a left-bound node stays left-bound at any target size — which holds
  under every k and fails loudly on a bad threshold, where coordinate assertions pin one aspect
  ratio and certify nothing about the 9:16 case the feature exists for.

**Known limitation, and it is inherent rather than a bug:** elements that belong together but are
not grouped drift apart, because each anchors independently and the growth lands in the gap between
them. In `social-editorial-quote` the name and role separate; in `deck-stat-trio` each column's
rule, value and label spread out. Step 5 is the mitigation and it already works — a group resolves
against its own derived bounds and moves as one unit — so the guidance is that tightly-related
elements should be grouped. Worth stating in the UI when the command lands, not discovered.

**What naive resize actually costs**, measured on `deck-stat-trio` at 1920×1080 → 1080×1920: it does
not merely leave dead space, it **crops the third column off the page entirely**. Content loss, not
just bad composition.

## Fonts: the one hard dependency

Half of § B and all of § C rest on the same unsolved problem: `packages/engine`'s `metricMeasurer`
approximates glyph widths. That is fine for a demo and wrong for a design tool, because:

- line breaking, auto-fit, justification and text bounding boxes are all downstream of measurement;
- the § C.9 Background plate and every selection handle need a *correct* bbox;
- **the editor and the CLI must agree**, or the golden tests certify the wrong picture.

The fix is one dependency: parse the actual font (`opentype.js`, or `fontkit`) and measure from real
advance widths and kerning tables, in both the browser and Node. Fonts then need embedding as
content-addressed `Asset`s with `@font-face` emitted into `<defs><style>` so exported SVGs are
self-contained. This is `M`–`L` of work that unblocks more P0/P1 rows than anything else in this
document, and it should be done **before** the text-effects work, not after — every effect recipe in
§ C is measured against a bbox.

## Schema deltas that unlock the most rows

Ranked by rows-unlocked per unit of churn. All are additive; the existing `migrate()` /
`OpaqueNode` forward-compat design already handles readers that predate them.

| # | Delta | Unlocks |
|---|---|---|
| 1 | `TextNode.runs: [{text, style}]` (rich text) + run-aware `layoutText` | Bold-in-a-sentence, per-word colour, links, lists, super/subscript — ~10 P0/P1 rows in § B |
| 2 | `NodeBase.effects: Effect[]` — an ordered, composable list (`shadow \| glow \| outline \| hollow \| echo \| glitch \| neon \| background \| longShadow \| innerShadow`) replacing the single `shadow` | All of § C and § D, plus stacked effects Canva can't do |
| 3 | `ImageNode.crop: {x,y,w,h}` in source space (keep `fit` as a convenience that computes one) | Crop, frames, grids, reposition-in-frame (§ F, § P) |
| 4 | `ImageNode.adjustments: {brightness, contrast, saturation, hue, warmth, highlights, shadows, fade, clarity, sharpen, blur, vignette, grain, duotone?, preset?, intensity}` | The entire § G in one field |
| 5 | `TextNode.fill: Fill` (replacing `color: Hex`) + `TextNode.stroke: Stroke` + `paintOrder` | Gradient text, Outline/Hollow/Splice |
| 6 | `NodeBase.blendMode` + `flipX`/`flipY` | § O, § E flips |
| 7 | `NodeBase.clip: {kind:'path'\|'node', d?}` / `mask` | § P frames, masks, soft fades |
| 8 | New node kinds: `frame`, `table`, `chart`, `qr` | § P, § Q, § R, § S |
| 9 | `Artboard.background` accepts `{kind:'image'}`; `Artboard.unit`/`dpi`/`bleed` | § A, § W print |
| 10 | Colour/type **tokens** (`palette`, `textStyles`) referenced by nodes | Template restyling, brand kits, recolour-all (§ J, § K, § N) — cheap now, expensive to retrofit |

Two invariants to hold while adding these: keep `idSeq` reset per render (already done) so `<defs>`
ids stay deterministic, and require an explicit `seed` on anything stochastic.

---

## Build-next, ranked

Ranked by **(Priority, then lowest Effort)**. The `∥` column marks work that is safely
parallelisable because the files it touches are disjoint from its neighbours in the same block.

### Block 1 — P0, small (do these first; nearly all parallel)

| ∥ | Item | Effort | Files touched |
|---|---|---|---|
| A | Transparent-background export + `background.kind:'none'` | S | `render-svg` |
| A | Alt text → `<title>`/`<desc>` + `aria-hidden` | S | `render-svg` |
| A | Flip H/V (`flipX`/`flipY`) | S | `schema`, `render-svg` |
| A | Polygon/star/triangle generators → `PathNode` | S | `commands` (new file), icon data |
| A | Arrowheads via `<marker>` | S | `schema`, `render-svg` |
| B | Undo/redo stack | M | `engine`/editor state |
| B | Align, distribute, nudge, numeric position panel | S | editor + `commands` |
| B | Smart guides / snapping | M | editor only |
| B | Layers panel, lock/hide/rename wiring | M | editor only |
| C | Keyboard shortcut map (T/R/C/L/E/I, arrange, group, nudge) | S | editor only |
| C | Copy/paste/duplicate-with-offset | S | `commands` |
| D | PNG/JPG raster export path | M | new `packages/export` |
| D | Multi-page export loop | S | `cli`, `export` |

Blocks A–D above touch four disjoint areas (renderer, editor-interaction, command layer, export) and
can run concurrently. Within a block, items share files and should be serialised.

### Block 2 — P0, medium/large (the two that gate everything else)

| ∥ | Item | Effort | Why it's a gate |
|---|---|---|---|
| — | **Real font metrics + `@font-face` asset embedding** | L | Gates § C entirely, plus justify, auto-fit, bboxes, PDF text. Do this first; nothing in block 2 parallelises with it cleanly because everything measures text. |
| E | **Rich-text runs** (`runs[]` + run-aware layout) | L | Gates lists, per-word styling, links, tables' cell text. Touches `schema` + `engine` + `render-svg`. |
| F | **`ImageNode.crop`** + crop UI | M | Gates frames, grids, Magic Resize quality. Touches `schema` + `engine/objectFit` + `render-svg` + editor. Disjoint from E. |
| G | PDF Standard export | M | Disjoint from E and F (new package), but wants the font work done. |

E, F and G are mutually parallel once the font work lands. E and the font work are not.

### Block 3 — P1, small (high payoff per hour; all parallel)

| ∥ | Item | Effort | Notes |
|---|---|---|---|
| H | **Text effects: Shadow, Lift, Hollow, Outline** (§ C.1–C.5) | S each | One `effects[]` builder; ship these four together. |
| H | **Text effects: Splice, Echo, Glitch, Background** | S each | Same builder, same file. Serialise behind the four above. |
| I | **Image adjustments: brightness, contrast, saturation, hue, blur** (§ G) | S | One filter-builder function; the rest of § G is then data. |
| I | **Duotone, greyscale, sepia, invert, fade** | S | Same builder. |
| I | **Vignette** (`NATIVE`, radial gradient) | S | Touches the image render path, not the filter builder. |
| J | **Element shadows: Glow, Outline** (§ D.1) | S | Same `effects[]` builder as H — serialise with H. |
| K | Gradient/image fill on text (`TextNode.fill: Fill`) | S | `schema` + `render-svg`. |
| K | Radial gradients | S | `render-svg` `fillToPaint`. |
| L | Blend modes (`mix-blend-mode`) | M | `schema` + `render-svg` + CLI style emission. |
| M | QR code node | S | New file; fully disjoint. |
| N | ~~Colour-contrast + typography diagnostics~~ | S | **DONE.** `packages/diagnostics`, reached from the CLI as `artboard check`. |
| O | Eyedropper + photo-colour extraction | M | Editor only. |
| P | Bundled icon/shape library (MIT/CC0) | S | Pure data; fully disjoint. |
| Q | Full-screen presentation mode | S | Editor shell; fully disjoint. |
| R | ~~Bulk Create in the CLI (CSV → N renders)~~ | M | **DONE.** `artboard bulk`, `packages/cli/src/bulk/data.ts`. |

H/J share the effects builder. I owns the image-filter builder. K owns paint. Everything else in
this block (L, M, N, O, P, Q, R) touches its own files and can go in parallel.

### Block 4 — P1, medium/large

| ∥ | Item | Effort |
|---|---|---|
| S | Text effects: **Neon** (§ C.8) and **Curve via per-glyph placement** (§ C.10) | M each |
| S | Element shadows: **Angle**, **Curve/Page Lift** (§ D.2–D.3) | M each |
| T | Frames + `<clipPath>` masking | M |
| T | Grids (frame containers) | L |
| U | Highlights/Shadows/X-Process tone curves, Clarity, Grain (§ G.2, G.4, G.6) | M |
| U | Filter presets + intensity (data over U's builder) | M |
| V | Tables node | L |
| W | Charts node (bar/line/pie/donut/area/scatter first) | L |
| X | Custom font upload + Brand Kit (palettes, fonts, logos) | M |
| Y | **Magic Resize** (constraint relayout) | L |
| Z | Bulleted/numbered lists, justify, auto-fit | M |
| AA | SVG import (sanitised) + vector recolour | M |
| AB | Template gallery + placeholders + colour tokens | M |
| AC | PDF Print (bleed, crop marks) | M |
| AD | Freehand draw tool | M |

S depends on block 3's H/J (same builder). U depends on block 3's I. Z depends on block 2's E and
the font work. T, V, W, X, Y, AA, AB, AC, AD are mutually disjoint and parallel.

### Block 5 — P2 and beyond

Version history · animations (CSS keyframes) + page transitions · presenter view · PPTX export ·
animated-SVG export · inner shadow · stroke alignment · bezier pen and path editing · boolean ops ·
auto-layout · reading order · colour-blindness simulation · barcodes · CSV/XLSX chart import ·
PDF import (raster first) · palette generator · plugin API.

### Explicit non-goals (P3), stated once so they stop being "gaps"

Video and audio editing in any form · GIF/MP4 export · real-time collaboration, comments, share
links, teams, approvals · stock photo/video/audio libraries · Canva Print · Content Planner ·
Canva Docs/Sheets/Sites/Whiteboards · generative AI (image, video, text, code) · dynamic/trackable
QR · CMYK/ICC colour management · Magic Edit/Expand/Grab/Eraser.

Background Removal is the only heavyweight ML feature recommended for eventual inclusion, and only
as an optional, lazily-loaded plugin whose output is an ordinary raster asset.

---

## Sources

- https://www.canva.com/help/text-effects/ · https://designbundles.net/design-school/how-to-use-canva-text-effects · https://www.thebusyllama.com/canva-font-effects/ · https://www.keepcanva.com/2025/01/10-best-canva-text-effects.html
- https://allthings.how/how-to-use-canva-shadow-effect/ · https://www.bwillcreative.com/how-to-add-a-drop-shadow-in-canva/ · https://www.laisladesigns.com/2025/05/13/canva-hacks-part-8-shadows/ · https://hubdigitalcontent.com/tools/canva/how-to-add-drop-shadow-in-canva-images-elements-text/
- https://www.canva.com/help/image-settings/ · https://www.canva.com/help/image-editor/ · https://bringyourownlaptop.com/blog/how-to-adjust-images-in-canva · https://graphicdesignresource.com/how-to-adjust-light-settings-of-canva-images/ · https://graphicdesignresource.com/how-to-use-duotone-in-canva/ · https://www.canva.com/features/photo-effects/ · https://www.youtube.com/watch?v=43D28n-wJLQ
- https://www.canva.com/help/charts/ · https://www.canva.com/help/chart-types/ · https://www.canva.com/help/interactive-charts/ · https://www.canva.com/help/dot-charts/
- https://www.canva.com/help/tables/ · https://www.canva.com/help/merging-and-unmerging-cells/ · https://www.canva.com/help/formatting-tables/ · https://www.canva.com/help/adding-and-deleting-tables/
- https://www.canva.com/help/animate-designs/ · https://estudy247.com/courses/canva/lessons/canva-animations/ · https://thepowerpointblog.com/canva-animation/
- https://www.canva.com/help/download-file-types/ · https://www.canva.dev/docs/connect/api-reference/exports/ · https://www.designexporter.com/blog/canva-export-formats-compared/ · https://www.canva.com/help/upload-formats-requirements/
- https://www.canva.com/help/brand-kit/ · https://www.canva.com/help/using-brand-templates/ · https://www.canva.com/help/brand-kit-builder/ · https://www.canva.com/pro/brand-kit/
- https://www.canva.com/help/layer-group-align/ · https://www.canva.com/help/finding-and-arranging-layers/ · https://www.laisladesigns.com/2025/08/12/canva-basics-part-1/
- https://www.canva.com/help/bulk-create/ · https://www.canva.com/help/bulk-create-data-autofill/ · https://www.canva.com/help/data-autofill/
- https://www.canva.com/help/presenting-designs/ · https://www.canva.com/help/presentation-modes/ · https://www.canva.com/newsroom/news/new-canva-presentations-features/
- https://www.canva.com/help/using-design-accessibility/ · https://www.canva.com/help/canva-accessibility-features/ · https://www.canva.com/help/pdf-accessibility-features/ · https://www.canva.com/accessibility/ · https://venngage.com/blog/canva-accessibility-review/
- https://www.canva.com/design-school/resources/canva-editor-shortcuts · https://keyshortcuts.net/canva-shortcuts · https://www.skillademia.com/shortcuts/canva-shortcuts/
- https://www.canva.com/newsroom/news/canva-create-2025/ · https://www.canva.com/newsroom/news/canva-ai-launches/ · https://www.canva.com/newsroom/news/what-happened-at-canva-create-2025/ · https://www.businesswire.com/news/home/20250410082173/en/
- https://www.canva.com/pro/magic-resize/ · https://www.canva.com/help/resize/ · https://www.canva.com/help/magic-eraser/ · https://www.canva.com/features/magic-eraser/
- https://www.canva.com/help/creating-and-editing-videos/ · https://www.canva.com/help/trim-audio-and-adjust-volume/ · https://filmora.wondershare.com/video-editor-review/canva-video-editor.html
- https://www.canva.com/help/version-history/ · https://www.temperstack.com/learn/canva/use-blending-modes/ · https://www.canva.dev/blog/engineering/picking-color-via-eyedropper-on-web-app/
- https://www.canva.com/qr-code-generator/ · https://www.canva.com/features/ai-qr-code-generator/ · https://designhub.co/how-to-use-frames-in-canva/ · https://www.canva.com/learn/use-grids-canva/
- https://www.canva.com/pro/premium-content/ · https://www.canva.com/design-school/resources/using-and-editing-elements · https://www.canva.com/help/format-text/
