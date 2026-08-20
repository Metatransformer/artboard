import { loadDocument, type Document } from '@artboard/schema';

/** Deterministic PRNG (mulberry32). Same seed → same stream, so failures reproduce. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
export const int = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** A fully-defaulted document: everything below is run through the schema first. */
export function baseDoc(): Document {
  return loadDocument({
    id: 'doc-1',
    name: 'Fixture',
    artboards: [
      {
        id: 'ab-1',
        name: 'Page 1',
        width: 800,
        height: 600,
        background: { kind: 'solid', color: '#ffffff' },
        nodes: [
          { id: 'r1', kind: 'rect', x: 10, y: 20, width: 100, height: 50, radius: 4 },
          { id: 'e1', kind: 'ellipse', x: 200, y: 40, width: 80, height: 80 },
          { id: 't1', kind: 'text', x: 30, y: 300, width: 300, height: 120, text: 'Hello world', fontSize: 24 },
          {
            id: 'g1', kind: 'group', x: 0, y: 0, width: 400, height: 400,
            children: [{ id: 'r2', kind: 'rect', x: 5, y: 5, width: 20, height: 20 }],
          },
        ],
      },
    ],
    assets: {
      'img-1': { id: 'img-1', mime: 'image/png', width: 200, height: 100, data: 'data:image/png;base64,AAAA' },
    },
  }).doc;
}

/** Stack-based well-formedness check: every opened tag is closed, in order. */
export function checkXml(xml: string): { ok: boolean; error?: string } {
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const closing = m[1] === '/';
    const name = m[2]!;
    const selfClose = m[4] === '/';
    if (closing) {
      const top = stack.pop();
      if (top !== name) return { ok: false, error: `</${name}> closes <${top ?? 'nothing'}>` };
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) return { ok: false, error: `unclosed tags: ${stack.join(', ')}` };
  return { ok: true };
}
