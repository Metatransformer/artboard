# Font metrics

`packages/engine` measures text with **real per-glyph advance widths** read out of
the actual font binaries, not with a guessed table. This is what makes the wrap
the editor shows and the wrap a browser performs on the exported SVG the same
wrap.

- `tools/gen-font-metrics.mjs` — the generator. Runs offline, at author time.
- `packages/engine/src/metrics.ts` — the generated table. **Checked in. Do not edit by hand.**
- `packages/engine/src/index.ts` — `metricMeasurer` / `resolveFont`, which consume it.

## Regenerating

```sh
npm i -D --no-save fontkit    # generator-only dependency
npm run metrics
npm run test                  # 132 tests
npm run golden -- --update    # baselines move if the numbers moved — that is correct
```

Then **look at the re-baked SVGs**, don't just trust the diff. `fontkit` is
deliberately *not* in `package.json`: `@artboard/engine` ships with zero runtime
dependencies, and a font parser must never end up in that graph.

The generator is deterministic. Running it twice produces a byte-identical file:
the font binaries are pinned to a `google/fonts` commit, the codepoint set is a
fixed literal, keys are sorted by codepoint, and every number is emitted with
`toFixed(4)`. Downloads are cached in `os.tmpdir()`, never in the repo. Verify
with `npm run metrics && shasum packages/engine/src/metrics.ts` twice.

To pick up upstream font updates, bump `FONTS_REF` in the generator. That is a
deliberate, reviewable act — the pin exists so a regeneration in a year does not
silently reflow every document in the product.

## What is in the table

Five families, measured from the Google Fonts binaries:

| Family | Source | Weights available |
| --- | --- | --- |
| Inter | variable (`opsz`, `wght`) | 400, 500, 600, 700, 800 |
| Playfair Display | variable (`wght`) | 400, 500, 600, 700, 800 |
| DM Serif Display | static | 400 only |
| Space Grotesk | variable (`wght` 300–700) | 400, 500, 600, 700 |
| JetBrains Mono | variable (`wght` 100–800) | 400, 500, 600, 700, 800 |

The sampled weights are the ones the product actually uses (`grep -rn fontWeight`).
Variable families are instanced with `fontkit`'s `getVariation({ wght })`, so an
800 is the font's real 800 master, not a synthetic smear of the 400.

Per codepoint we store `advanceWidth / unitsPerEm` — a **fraction of the em**, so
the table is font-size independent and a measurement is one multiply.

The codepoint set is ASCII printable (U+0020–U+007E), the Latin-1 supplement
(U+00A0–U+00FF, which is where `×`, `÷`, `£`, `·` and the accented letters live),
plus the typographic marks the editor and templates can produce: the dashes and
hyphens, the curly quotes, dagger, bullet, ellipsis, per-mille, primes,
guillemets, the common currency symbols, №, ™, the four arrows and the maths
comparisons. Codepoints a family has no glyph for are omitted rather than
recorded as `.notdef`.

Per family we also store `ascender`, `descender`, `lineGap` (from `hhea`, again
as a fraction of the em) and the derived `naturalLineHeight`, exposed as
`fontVerticalMetrics(family, weight)`. `layoutText` still honours the node's own
`lineHeight` — this is for callers that want an *auto* line height without
inventing a number.

## The fallback chain

`metricMeasurer` never fails and never guesses silently. `resolveFont(family, weight)`
returns exactly what was used, and the level it came from:

1. **`exact`** — that family, that weight, straight out of the table.
2. **`weight`** — that family, the **nearest weight it can actually supply**.
   Ties go to the lighter weight (only reachable at an exact midpoint like 450).
   This is routine, not an error: DM Serif Display has one weight, so every
   request lands on 400; Space Grotesk stops at 700, so a request for 800 is
   measured at 700.
3. **`family`** — the family is unknown, so **Inter** is used, then rule 2 for the
   weight. `layoutText` emits a `FONT_SUBSTITUTED` warning diagnostic for this
   case, and only this case.
4. **Per codepoint** — anything outside the sampled set falls back to that
   weight's `fallbackWidth`, the mean advance across every glyph sampled for it.
   `FamilyMetrics.fallbackWidth` (the mean of the per-weight means) is the last
   resort above that.

Family names are matched loosely: case, surrounding whitespace, quotes and a CSS
fallback tail are all ignored, so `Playfair Display`, `playfair display` and
`"Playfair Display", serif` all resolve to the same table.

### Surfacing the substitution

`layoutText` returns two new fields:

- `font: FontMatch` — `{ requestedFamily, requestedWeight, family, weight, fallback }`.
  Every level of the chain is observable here, including weight substitutions,
  which are too common to be worth a diagnostic.
- `diagnostics: Diagnostic[]` — carries `FONT_SUBSTITUTED` when `fallback === 'family'`.

`packages/render-svg` builds its own `diagnostics` array and pushes to it
(`TEXT_TRUNCATED`, `CURVE_SINGLE_LINE`, …). Forwarding these is a one-line change
in its `case 'text'` branch — `diagnostics.push(...layout.diagnostics)` — but
`render-svg` was outside the scope of this change, so the engine exposes them and
the renderer does not yet forward them.

## Tradeoffs, stated plainly

**Kerning is out of scope.** We sum advance widths; we do not apply `kern`/`GPOS`
pair adjustments. Measured against Chromium rendering the real webfonts across
all 24 golden documents, 221 text lines, the remaining error is **0.27% mean,
0.92% p95, 1.68% max** — and 1.68% is Space Grotesk 800, which is the weight
fallback, not kerning. The old hand-waved table was 7.07% mean / 29.4% max.
Applying kerning would mean shipping a GPOS subset and a shaping loop into a
package that is meant to stay dependency-free, to chase a fraction of a percent.
Not worth it.

**No shaping.** No ligatures, no contextual alternates, no bidi, no combining-mark
composition. Latin text at these five families does not need it. CJK, Arabic and
Devanagari would, and would measure as `fallbackWidth` per codepoint — badly. Any
work to support those scripts starts here.

**Letter spacing** is added as `(glyphs - 1) × letterSpacing`, i.e. between glyphs
only. Browsers add it *after* every glyph including the last, so a run with letter
spacing is one `letterSpacing` narrower in our measurement than on screen. That
predates this change and was left alone.

**The table is ~73 KB of source** (4537 advances across 20 family+weight tables).
It is plain data, it minifies and gzips well, and it is the price of a renderer
that does not have to load a font to know how wide a word is.

**Weights the product requests but a family cannot supply** are measured at the
nearest available weight, while the SVG still asks the browser for the requested
weight. For Space Grotesk 800 the browser will render its own 700 (or synthesise),
so the two stay consistent in practice — but the honest fix is for the UI not to
offer a weight the family does not have.
