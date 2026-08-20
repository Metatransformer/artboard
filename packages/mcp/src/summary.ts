/**
 * How a document is described back to an agent.
 *
 * The temptation is to hand over `JSON.stringify(doc)` and let the model sort
 * it out. That is a bad trade: a single artboard of real design work is tens of
 * kilobytes of gradients, effect stacks and inline asset data, and an agent
 * that spends its context on base64 has none left to do the work. So reads
 * return an outline — identity, kind, geometry, and the handful of properties
 * that decide what a node LOOKS like — and `get_node` exists for when the agent
 * genuinely wants everything about one node.
 */
import type { Document, Artboard, Node } from '@artboard/schema';

const n = (v: unknown): string => {
  const x = Number(v);
  return Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '?';
};

/** `x,y w×h` — the four numbers an agent needs to move something. */
export const box = (node: any): string => `${n(node.x)},${n(node.y)} ${n(node.width)}×${n(node.height)}`;

/** The one-line "what does this look like" for a node. */
function traits(node: any): string {
  const bits: string[] = [];
  if (node.kind === 'text') {
    const t = String(node.text ?? '').replace(/\s+/g, ' ').trim();
    bits.push(JSON.stringify(t.length > 48 ? `${t.slice(0, 47)}…` : t));
    bits.push(`${n(node.fontSize)}px`);
    if (node.family) bits.push(String(node.family));
    if (node.weight && node.weight !== 400) bits.push(`w${node.weight}`);
  }
  if (node.kind === 'image') bits.push(`asset:${node.assetId} fit:${node.fit}`);
  if (node.kind === 'group') bits.push(`${(node.children ?? []).length} children`);
  if (node.fill?.kind === 'solid') bits.push(node.fill.color);
  else if (node.fill?.kind === 'gradient') bits.push(`${node.fill.type ?? 'linear'} gradient`);
  else if (node.color) bits.push(String(node.color));
  if (node.rotation) bits.push(`rot ${n(node.rotation)}°`);
  if (node.opacity !== undefined && node.opacity !== 1) bits.push(`opacity ${n(node.opacity)}`);
  if (node.blend && node.blend !== 'normal') bits.push(String(node.blend));
  if (Array.isArray(node.effects) && node.effects.length) bits.push(`effects: ${node.effects.map((e: any) => e.kind).join('+')}`);
  if (node.visible === false) bits.push('HIDDEN');
  if (node.locked) bits.push('LOCKED');
  return bits.join(' ');
}

/** Layers are listed top-of-stack LAST, matching the SVG paint order. */
export function outline(nodes: Node[], depth = 0): string[] {
  const out: string[] = [];
  nodes.forEach(node => {
    const a = node as any;
    out.push(`${'  '.repeat(depth + 1)}${a.id}  ${a.kind}  ${box(a)}  ${traits(a)}`.trimEnd());
    if (a.kind === 'group') out.push(...outline((a.children ?? []) as Node[], depth + 1));
  });
  return out;
}

export function describeArtboard(ab: Artboard, index: number): string {
  const a = ab as any;
  const bg = a.background?.kind === 'solid' ? a.background.color
    : a.background?.kind === 'none' ? 'transparent' : (a.background?.kind ?? 'none');
  const head = `[${index}] ${a.id}  "${a.name}"  ${n(a.width)}×${n(a.height)}  bg ${bg}  ${(a.nodes ?? []).length} top-level nodes`;
  return [head, ...outline((a.nodes ?? []) as Node[])].join('\n');
}

export function describeDocument(doc: Document, rel: string, diagnostics: readonly { message: string }[]): string {
  const d = doc as any;
  const lines = [
    `${rel}`,
    `document ${d.id}  "${d.name ?? 'Untitled'}"  ${d.artboards.length} artboard(s)  ${Object.keys(d.assets ?? {}).length} asset(s)`,
    '',
    ...d.artboards.map((ab: Artboard, i: number) => describeArtboard(ab, i)),
  ];
  if (diagnostics.length) {
    lines.push('', `diagnostics (${diagnostics.length}):`, ...diagnostics.map(x => `  - ${x.message}`));
  }
  return lines.join('\n');
}
