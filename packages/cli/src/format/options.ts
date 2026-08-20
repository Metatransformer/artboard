/**
 * Export options, and the vector half of the export itself.
 *
 * Both hosts share this file so that "SVG at 2x, pages 2-4, transparent" means
 * exactly one thing. The raster formats live in the editor, because rasterising
 * needs a canvas; everything deterministic — SVG, JSON, PDF — is produced here
 * and is therefore byte-identical from the CLI and from the Export dialog.
 */

import type { Document } from '@artboard/schema';
import { renderArtboard, serialize } from '@artboard/render-svg';
import { round } from '@artboard/engine';

import { renderPdf } from './pdf.js';

export const FORMATS = ['png', 'jpg', 'svg', 'json', 'pdf'] as const;
export type ExportFormat = (typeof FORMATS)[number];

export const isFormat = (s: string): s is ExportFormat => (FORMATS as readonly string[]).includes(s);

/** Formats a headless process can produce without a rasteriser. */
export const HEADLESS_FORMATS: readonly ExportFormat[] = ['svg', 'json', 'pdf'];

/** Formats whose output can be made genuinely transparent. */
export const TRANSPARENT_FORMATS: readonly ExportFormat[] = ['png', 'svg', 'pdf'];

export const EXTENSION: Record<ExportFormat, string> = {
  png: 'png', jpg: 'jpg', svg: 'svg', json: 'artboard.json', pdf: 'pdf',
};

export const MIME: Record<ExportFormat, string> = {
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
  json: 'application/json', pdf: 'application/pdf',
};

export interface ExportOptions {
  format: ExportFormat;
  /** Output size multiplier. Pixels for raster, page size for PDF, `width`/`height` for SVG. */
  scale: number;
  /**
   * `true` forces every exported page's background to `none`; `false` forces an
   * opaque white behind a page that has none. `undefined` leaves the document
   * exactly as the designer set it.
   */
  transparent?: boolean;
  /** Zero-based artboard indices, in output order. */
  pages: number[];
  /** JPEG quality, 0-1. Ignored by every other format. */
  quality: number;
}

export class PageRangeError extends Error {
  constructor(message: string) { super(message); this.name = 'PageRangeError'; }
}

/**
 * `all` · `3` · `2-5` · `1,4,7-9` → zero-based indices, de-duplicated,
 * in the order written. Page numbers are 1-based, because that is what the
 * page bar shows.
 */
export function parsePages(spec: string, count: number): number[] {
  const text = spec.trim().toLowerCase();
  if (text === '' || text === 'all') return Array.from({ length: count }, (_, i) => i);

  const seen = new Set<number>();
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    const single = /^(\d+)$/.exec(piece);
    if (!range && !single) throw new PageRangeError(`"${piece}" is not a page or a range. Try 2, 1-3, or all.`);
    const from = Number(range ? range[1] : single![1]);
    const to = Number(range ? range[2] : single![1]);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    if (lo < 1 || hi > count) {
      throw new PageRangeError(`This design has ${count} page${count === 1 ? '' : 's'}; "${piece}" is outside that.`);
    }
    for (let i = lo; i <= hi; i++) seen.add(i - 1);
  }
  if (seen.size === 0) throw new PageRangeError('No pages selected.');
  return [...seen];
}

/**
 * The document as this export wants it painted.
 *
 * Transparency is a document transform, not a renderer flag, so the CLI, the
 * editor and the golden renderer all keep exactly one code path.
 */
export function withExportBackground(doc: Document, transparent: boolean | undefined): Document {
  if (transparent === undefined) return doc;
  const artboards = doc.artboards.map(ab => {
    if (transparent) {
      return ab.background.kind === 'none' ? ab : { ...ab, background: { kind: 'none' as const } };
    }
    return ab.background.kind === 'none'
      ? { ...ab, background: { kind: 'solid' as const, color: '#ffffff' } }
      : ab;
  });
  return { ...doc, artboards };
}

/** A filename stem from a document name: safe on every filesystem, never empty. */
export function fileStem(name: string | undefined): string {
  const stem = (name ?? '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return stem === '' ? 'design' : stem;
}

/** `design.png` for one page, `design-3.png` for page 3 of several. */
export function pageFileName(stem: string, page: number, extension: string, multiple: boolean): string {
  return multiple ? `${stem}-${page + 1}.${extension}` : `${stem}.${extension}`;
}

export interface ExportFile {
  name: string;
  mime: string;
  data: string | Uint8Array;
}

export interface VectorExport {
  files: ExportFile[];
  notes: string[];
}

/** One page as SVG, honouring the scale multiplier on `width`/`height` only. */
export function exportSvgPage(doc: Document, index: number, scale = 1): string {
  const artboard = doc.artboards[index];
  if (!artboard) throw new Error(`Artboard ${index} does not exist`);
  const { scene } = renderArtboard(doc, artboard);
  if (scale !== 1) {
    scene.attrs['width'] = round(artboard.width * scale);
    scene.attrs['height'] = round(artboard.height * scale);
  }
  return serialize(scene);
}

/**
 * Everything a headless process can export: SVG (one file per page), the
 * document itself, and a PDF (one file, one page per artboard).
 */
export async function buildVectorExport(doc: Document, opts: ExportOptions, stem: string): Promise<VectorExport> {
  const painted = withExportBackground(doc, opts.transparent);

  if (opts.format === 'json') {
    return { files: [{ name: `${stem}.${EXTENSION.json}`, mime: MIME.json, data: JSON.stringify(doc, null, 2) }], notes: [] };
  }

  if (opts.format === 'svg') {
    const multiple = opts.pages.length > 1;
    return {
      files: opts.pages.map(index => ({
        name: pageFileName(stem, index, EXTENSION.svg, multiple),
        mime: MIME.svg,
        data: exportSvgPage(painted, index, opts.scale),
      })),
      notes: [],
    };
  }

  if (opts.format === 'pdf') {
    const pages = opts.pages.map(index => {
      const artboard = painted.artboards[index];
      if (!artboard) throw new Error(`Artboard ${index} does not exist`);
      return { scene: renderArtboard(painted, artboard).scene, width: artboard.width, height: artboard.height };
    });
    const { bytes, notes } = await renderPdf(pages, { scale: opts.scale, title: doc.name });
    return { files: [{ name: `${stem}.${EXTENSION.pdf}`, mime: MIME.pdf, data: bytes }], notes };
  }

  throw new Error(`${opts.format.toUpperCase()} needs a canvas to rasterise and cannot be produced here.`);
}
