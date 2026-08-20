import type { Document } from '@artboard/schema';
import { renderToString } from '@artboard/render-svg';

export class ExportBudgetExceededError extends Error {
  constructor(public pixels: number) { super(`Export is ${(pixels / 1e6).toFixed(0)}MP. The limit is 500MP.`); this.name = 'ExportBudgetExceededError'; }
}
const MAX_PIXELS = 500_000_000;

export function exportSvg(doc: Document, index: number): string {
  return renderToString(doc, index).svg;
}

export async function exportRaster(doc: Document, index: number, scale = 2, mime: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Blob> {
  const ab = doc.artboards[index];
  if (!ab) throw new Error('No such artboard');
  const w = Math.round(ab.width * scale), h = Math.round(ab.height * scale);
  if (w * h > MAX_PIXELS) throw new ExportBudgetExceededError(w * h);

  const svg = renderToString(doc, index).svg;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable in this browser');
    if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob(b => (b ? res(b) : rej(new Error('Rasterization produced no data'))), mime, 0.92));
  } finally { URL.revokeObjectURL(url); }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not rasterize the design. The SVG may reference an unavailable font.'));
    img.src = url;
  });
}

/* ---------------------------------------------------------------------------
 * Saving a file.
 *
 * Two hosts, two mechanisms. In a browser or the Electron shell we synthesise an
 * <a download> click. Inside the claude.ai artifact viewer that anchor is inert
 * by design: the page must hand the file to the host, which asks the viewer to
 * confirm it. We ask for the capability once and cache the answer; `null` means
 * this view cannot run it, and we fall back to the anchor.
 * ------------------------------------------------------------------------- */

interface DownloadsNamespace {
  save(req: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<{ status: 'saved' }>;
}

export interface SaveResult {
  /** 'declined' is a normal outcome - the viewer said no. Never an error. */
  status: 'saved' | 'declined';
  /** Set when the host would not accept the extension we asked for. */
  note?: string;
}

let cached: DownloadsNamespace | null | undefined;

async function downloadsHost(): Promise<DownloadsNamespace | null> {
  if (cached !== undefined) return cached;
  const claude = (globalThis as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  cached = claude?.use
    ? ((await claude.use('downloads').catch(() => null)) as DownloadsNamespace | null)
    : null;
  return cached;
}

/** True when this view can hand the viewer a file at all. */
export async function canSave(): Promise<boolean> {
  return typeof document !== 'undefined' || (await downloadsHost()) !== null;
}

function errorCode(e: unknown): string {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : 'unavailable';
}

export async function saveFile(data: Blob | string, filename: string, mime: string): Promise<SaveResult> {
  const host = await downloadsHost();
  if (host) {
    try {
      await host.save({ filename, data });
      return { status: 'saved' };
    } catch (e) {
      const code = errorCode(e);
      if (code === 'declined') return { status: 'declined' };
      // The host serves a base extension set; svg is only in the extended set.
      // Rather than lose the export, offer the identical bytes as .txt and say so.
      if (code === 'rejected_extension' || code === 'extension_not_enabled') {
        const alt = filename + '.txt';
        await host.save({ filename: alt, data });
        return { status: 'saved', note: 'Saved as ' + alt + ' - rename it to ' + filename };
      }
      if (code === 'too_large') throw new Error('That export is over the 16 MB limit this viewer allows. Try a smaller scale.');
      if (code === 'rate_limited') throw new Error('A save prompt is already open. Finish that one first.');
      throw new Error(e instanceof Error && e.message ? e.message : 'This view cannot save files.');
    }
  }
  download(data instanceof Blob ? data : new Blob([data], { type: mime }), filename);
  return { status: 'saved' };
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
