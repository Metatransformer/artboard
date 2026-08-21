import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDocument } from '@artboard/schema';
import { renderToString } from '@artboard/render-svg';

/**
 * Correctness of the generated symbols, as opposed to their stability.
 *
 * `artboard golden` proves the fixture's SVG bytes have not changed. It cannot
 * prove they were ever right -- a symbol that was wrong the day it was
 * baselined stays green forever, and `--update` re-bakes the baseline without
 * re-establishing anything. These assertions are the other half: they read the
 * SAME rendered output the golden pins, and compare it against values obtained
 * from tools OUTSIDE this codebase.
 *
 * That direction matters. Comparing against `qrMatrix()` or `ean13()` would
 * only prove the generator agrees with itself.
 *
 * PROVENANCE of every expected value below -- established 2026-08-20 against
 * the rendered `tests/golden/insert-data.svg`, not against the generators:
 *
 *   EAN-13   `python-barcode` 0.16.1, `EAN13('590123412345').build()[0]`.
 *
 * The fixture itself is generated, not hand-written: `tools/make-insert-fixture.mjs`
 * emits it through the real insert path. Re-run that after changing a payload,
 * then re-bake the SVG with `npm run golden -- --update`, then regenerate the
 * constant above. Restoring a deliberately mutated fixture is the same command -
 * never `git checkout`, which discards whatever else is uncommitted in the file.
 *            95 modules, bit-identical.
 *   QR       OpenCV 4.8.1 `QRCodeDetector().detectAndDecode()` on the fixture
 *            rasterized at 4200px wide. Decoded to exactly
 *            'https://artboard.dev'. The grid below is that decoded symbol.
 *
 * Re-running `artboard golden --update` does NOT re-establish either one. If a
 * change makes these fail, the symbol changed meaning -- re-baking the golden
 * is not the fix, and re-deriving the expectation from our own encoder would
 * defeat the purpose. Re-run the external tools.
 *
 * A note on why the QR is pinned as a grid rather than decoded here: bit
 * equality is the stronger oracle. A decode proves one reader coped; the grid
 * proves the symbol is the specified symbol, module for module. The decode is
 * what established the grid means what we claim.
 */

/** EAN-13 for '590123412345', check digit 7. From python-barcode. */
const EAN13_EXPECTED =
  '10100010110100111011001100100110111101001110101010110011011011001000010101110010011101000100101';

/** The QR for 'https://artboard.dev', including its 4-module quiet margin. */
const QR_EXPECTED: readonly string[] = [
  '00000000000000000000000000000',
  '00000000000000000000000000000',
  '00000000000000000000000000000',
  '00000000000000000000000000000',
  '00001111111011100110001111111',
  '00001000001011110100001000001',
  '00001011101011111100001011101',
  '00001011101001000101101011101',
  '00001011101011111010001011101',
  '00001000001000011010101000001',
  '00001111111010101010101111111',
  '00000000000001100100100000000',
  '00001001111111010011110010111',
  '00000011010111001001010111110',
  '00001000011110000101011111001',
  '00000110110001011001110001111',
  '00001001101011010111001100001',
  '00001000110110101011110010010',
  '00001100001011100011011011111',
  '00001001100110001110101101101',
  '00001011111110111001111110110',
  '00000000000011110000100010110',
  '00001111111011001110101010001',
  '00001000001011110101100010001',
  '00001011101010110101111110011',
  '00001011101010001101011000011',
  '00001011101001110100110011111',
  '00001000001000111100011110111',
  '00001111111010011100110001001',
];

const fixture = () => loadDocument(JSON.parse(readFileSync(
  fileURLToPath(new URL('./golden/insert-data.json', import.meta.url)), 'utf8'))).doc;

/** The two <path> elements in the rendered fixture: the QR and the barcode. */
function pathsOf(svg: string): string[] {
  return [...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]!);
}

/** Barcode bars are full height; QR modules are one unit tall. */
const isBarcode = (d: string) => /v9\d\d|v1000/.test(d);

describe('insert-data fixture: the symbols say what they should', () => {
  const svg = renderToString(fixture(), 0, { inlineAssets: false }).svg;
  const paths = pathsOf(svg);

  it('renders exactly the two symbol paths the fixture should contain', () => {
    // If this changes, the selectors below are picking up something else and
    // every assertion after it is worthless.
    expect(paths).toHaveLength(2);
    expect(paths.filter(isBarcode)).toHaveLength(1);
  });

  it('the EAN-13 is bit-identical to an independent reference encoder', () => {
    const d = paths.find(isBarcode)!;
    const QUIET_LEFT = 9;
    const bars = [...d.matchAll(/M(\d+) 0h(\d+)v/g)].map(m => [Number(m[1]), Number(m[2])] as const);
    const width = Math.max(...bars.map(([x, w]) => x + w));
    const mods = Array<string>(width + 1).fill('0');
    for (const [x, w] of bars) for (let i = x; i < x + w; i++) mods[i] = '1';

    expect(mods.slice(QUIET_LEFT, QUIET_LEFT + 95).join('')).toBe(EAN13_EXPECTED);
  });

  it('the QR is module-for-module the symbol that decoded to the payload', () => {
    const d = paths.find(p => !isBarcode(p))!;
    const runs = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
    const n = Math.max(
      Math.max(...runs.map(([x, , w]) => x + w)),
      Math.max(...runs.map(([, y]) => y)) + 1);
    const grid = Array.from({ length: n }, () => Array<string>(n).fill('0'));
    for (const [x, y, w] of runs) for (let i = x; i < x + w; i++) grid[y]![i] = '1';

    expect(grid.map(r => r.join(''))).toEqual(QR_EXPECTED);
  });

  it('the chart bars are proportional to the data', () => {
    // The structural oracle in generators.test.ts validates the shape of these
    // nodes and is blind to whether the shape means anything. Data is 42/68/
    // 55/91, so the bar widths must sit in those ratios.
    const doc = fixture();
    const chart = doc.artboards[0]!.nodes.find((n: any) => n.name === 'Quarterly revenue') as any;
    const bars = (chart.children as any[])
      .filter(n => n.kind === 'rect' && n.width > 1 && n.height > 1)
      .sort((a, b) => a.y - b.y);

    expect(bars).toHaveLength(4);
    const data = [42, 68, 55, 91];
    const unit = bars[0]!.width / data[0]!;
    for (const [i, bar] of bars.entries()) {
      expect(bar.width / data[i]!).toBeCloseTo(unit, 1);
    }
    // and they share a left origin, so the widths are comparable at a glance
    expect(new Set(bars.map(b => b.x)).size).toBe(1);
  });
});
