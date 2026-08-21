import { describe, it, expect } from 'vitest';
import { loadDocument } from '@artboard/schema';
import { renderToString } from '@artboard/render-svg';

/**
 * Inside an element with `xml:space="preserve"`, the newline and indent a
 * pretty-printer puts before a child are REAL CHARACTERS, not formatting. A
 * `<text text-anchor="middle">` containing indented `<tspan>`s centres on its
 * text plus that whitespace, so the run drifts -- and the drift grows with
 * nesting depth.
 *
 * This is asserted as a PROPERTY OF THE SERIALIZER rather than left to the
 * golden baselines, because the goldens cannot catch it: the bug was in the
 * output, so re-baking makes it the expected output. `GOLDEN GREEN` after a
 * re-bake says only that the renderer agrees with itself. This test says the
 * renderer agrees with the SVG specification, which is the part a re-bake
 * cannot quietly satisfy.
 *
 * Asserted against a FRESHLY RENDERED document rather than by scanning the
 * golden corpus: a baseline can only contain this whitespace if the serializer
 * emitted it, so scanning the corpus adds no failure the serializer test does
 * not already produce -- and it would tie this file to whichever re-bake
 * happens to be in the tree.
 *
 * It is also why the export and the editor disagreed: the editor draws the
 * same scene graph through React, which never emits inter-element whitespace,
 * so only the exported file was wrong.
 */

/** Every `<text …>…</text>` run, with its inner content. */
const textRuns = (svg: string): { open: string; inner: string }[] =>
  [...svg.matchAll(/(<text\b[^>]*>)([\s\S]*?)<\/text>/g)].map(m => ({ open: m[1]!, inner: m[2]! }));

/** Whitespace sitting BETWEEN tags -- the kind a pretty-printer adds. */
const hasInterTagWhitespace = (inner: string): boolean => /(^|>)\s+</.test(inner) || />\s+$/.test(inner);

describe('svg: whitespace inside preserve-space elements is content, not formatting', () => {
  it('detects the whitespace it is looking for', () => {
    // The control. Every other assertion here is that a detector returns
    // false, and a detector that can never return true satisfies all of them
    // while checking nothing. This is the case that must come back positive.
    const bad = '<text xml:space="preserve">\n    <tspan>a</tspan>\n    <tspan>b</tspan>\n  </text>';
    const good = '<text xml:space="preserve"><tspan>a</tspan><tspan>b</tspan></text>';
    expect(hasInterTagWhitespace(textRuns(bad)[0]!.inner)).toBe(true);
    expect(hasInterTagWhitespace(textRuns(good)[0]!.inner)).toBe(false);
  });

  it('renders a centred multi-line run with no whitespace between its tspans', () => {
    // Renders fresh rather than reading a baseline, so the property is checked
    // against the serializer itself and not against a file that could be
    // re-baked to agree with a bug.
    const doc = loadDocument({
      id: 'd', name: 'd',
      artboards: [{ id: 'ab', name: 'ab', width: 400, height: 300,
        background: { kind: 'solid', color: '#ffffff' },
        nodes: [{ id: 't', kind: 'text', x: 20, y: 20, width: 200, height: 120,
          text: 'one two three four five six seven', fontSize: 24, align: 'center' }] }],
      assets: {},
    }).doc;
    const svg = renderToString(doc).svg;
    const runs = textRuns(svg);
    expect(runs.length).toBeGreaterThan(0);
    // The fixture must actually wrap, or this proves nothing about multi-line.
    expect(runs.some(r => (r.inner.match(/<tspan/g) ?? []).length > 1)).toBe(true);
    for (const { inner } of runs) expect(hasInterTagWhitespace(inner)).toBe(false);
  });

  it('still indents elements whose whitespace is NOT content', () => {
    // The fix must be scoped to preserve-space elements. A serializer that
    // stopped indenting everything would pass every assertion above while
    // making the output unreadable, so this pins the other side.
    const doc = loadDocument({
      id: 'd', name: 'd',
      artboards: [{ id: 'ab', name: 'ab', width: 400, height: 300,
        background: { kind: 'solid', color: '#ffffff' },
        nodes: [{ id: 'r', kind: 'rect', x: 10, y: 10, width: 50, height: 50 }] }],
      assets: {},
    }).doc;
    expect(renderToString(doc).svg).toMatch(/\n\s+<rect/);
  });
});
