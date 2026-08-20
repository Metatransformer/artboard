import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

/* ── primitives ─────────────────────────────────────────────────────────── */
export const Hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

export const Gradient = z.object({
  kind: z.literal('gradient'),
  angle: z.number().default(90),
  stops: z.array(z.object({ offset: z.number().min(0).max(1), color: Hex })).min(2),
});
export const SolidFill = z.object({ kind: z.literal('solid'), color: Hex });
export const NoFill = z.object({ kind: z.literal('none') });
export const Fill = z.discriminatedUnion('kind', [SolidFill, Gradient, NoFill]);
export type Fill = z.infer<typeof Fill>;

export const Stroke = z.object({
  color: Hex.default('#000000'),
  width: z.number().min(0).default(0),
  dash: z.array(z.number()).default([]),
});

export const Shadow = z.object({
  x: z.number().default(0), y: z.number().default(4),
  blur: z.number().min(0).default(12), color: z.string().default('#00000033'),
});

/* ── nodes ──────────────────────────────────────────────────────────────── */
const NodeBase = {
  id: z.string().min(1),
  name: z.string().default(''),
  x: z.number(), y: z.number(),
  width: z.number().min(0), height: z.number().min(0),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  shadow: Shadow.nullable().default(null),
};

export const TextNode = z.object({
  ...NodeBase,
  kind: z.literal('text'),
  text: z.string().default(''),
  fontFamily: z.string().default('Inter'),
  fontSize: z.number().min(1).default(48),
  fontWeight: z.number().default(600),
  italic: z.boolean().default(false),
  lineHeight: z.number().min(0.5).default(1.2),
  letterSpacing: z.number().default(0),
  align: z.enum(['left', 'center', 'right']).default('left'),
  valign: z.enum(['top', 'middle', 'bottom']).default('top'),
  color: Hex.default('#111111'),
  uppercase: z.boolean().default(false),
});

export const RectNode = z.object({
  ...NodeBase, kind: z.literal('rect'),
  fill: Fill.default({ kind: 'solid', color: '#4f46e5' }),
  stroke: Stroke.default({ color: '#000000', width: 0, dash: [] }),
  radius: z.number().min(0).default(0),
});

export const EllipseNode = z.object({
  ...NodeBase, kind: z.literal('ellipse'),
  fill: Fill.default({ kind: 'solid', color: '#f59e0b' }),
  stroke: Stroke.default({ color: '#000000', width: 0, dash: [] }),
});

export const LineNode = z.object({
  ...NodeBase, kind: z.literal('line'),
  stroke: Stroke.default({ color: '#111111', width: 2, dash: [] }),
});

export const PathNode = z.object({
  ...NodeBase, kind: z.literal('path'),
  d: z.string(),                       // SVG path data, validated by allowlist on import
  viewBox: z.tuple([z.number(), z.number()]).default([24, 24]),
  fill: Fill.default({ kind: 'solid', color: '#111111' }),
  stroke: Stroke.default({ color: '#000000', width: 0, dash: [] }),
});

export const ImageNode = z.object({
  ...NodeBase, kind: z.literal('image'),
  assetId: z.string(),
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  radius: z.number().min(0).default(0),
});

export const GroupNode: z.ZodType<any> = z.lazy(() => z.object({
  ...NodeBase, kind: z.literal('group'),
  children: z.array(Node).default([]),
}));

/** Forward-compatibility: an unknown node kind is preserved verbatim, never dropped. */
export const OpaqueNode = z.object({
  ...NodeBase, kind: z.literal('opaque'),
  originalKind: z.string(),
  raw: z.unknown(),
});

export const Node: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    TextNode, RectNode, EllipseNode, LineNode, PathNode, ImageNode, OpaqueNode, (GroupNode as any).schema,
  ]) as any
);
export type Node = z.infer<typeof TextNode> | z.infer<typeof RectNode> | z.infer<typeof EllipseNode>
  | z.infer<typeof LineNode> | z.infer<typeof PathNode> | z.infer<typeof ImageNode>
  | z.infer<typeof OpaqueNode> | { kind: 'group'; children: Node[] } & Record<string, any>;

/* ── document ───────────────────────────────────────────────────────────── */
export const Asset = z.object({
  id: z.string(),
  mime: z.string(),
  width: z.number(), height: z.number(),
  /** data: URI. Content-addressed copy — never a path to the user's filesystem. */
  data: z.string(),
});

export const Artboard = z.object({
  id: z.string(),
  name: z.string().default('Artboard'),
  width: z.number().min(1),
  height: z.number().min(1),
  background: Fill.default({ kind: 'solid', color: '#ffffff' }),
  nodes: z.array(Node).default([]),
});

export const Diagnostic = z.object({
  level: z.enum(['info', 'warn', 'error']),
  code: z.string(),
  nodeId: z.string().nullable().default(null),
  message: z.string(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

export const Document = z.object({
  version: z.number().int().default(SCHEMA_VERSION),
  id: z.string(),
  name: z.string().default('Untitled'),
  artboards: z.array(Artboard).min(1),
  assets: z.record(z.string(), Asset).default({}),
  diagnostics: z.array(Diagnostic).default([]),
});
export type Document = z.infer<typeof Document>;
export type Artboard = z.infer<typeof Artboard>;
export type Asset = z.infer<typeof Asset>;
export type TextNode = z.infer<typeof TextNode>;
export type RectNode = z.infer<typeof RectNode>;
export type EllipseNode = z.infer<typeof EllipseNode>;
export type ImageNode = z.infer<typeof ImageNode>;
export type PathNode = z.infer<typeof PathNode>;
export type LineNode = z.infer<typeof LineNode>;

/* ── errors (named, never a bare catch) ─────────────────────────────────── */
export class DocumentParseError extends Error { constructor(public detail: string) { super(`Document is damaged: ${detail}`); this.name = 'DocumentParseError'; } }
export class UnsupportedVersionError extends Error { constructor(public found: number) { super(`Made in a newer version (v${found}). Opened read-only.`); this.name = 'UnsupportedVersionError'; } }
export class DocumentIntegrityError extends Error { constructor(public refs: string[]) { super(`Missing assets: ${refs.join(', ')}`); this.name = 'DocumentIntegrityError'; } }

/* ── open pipeline: parse → schema → migrate → integrity ─────────────────── */
export interface OpenResult { doc: Document; readOnly: boolean; diagnostics: Diagnostic[]; }

export function parseDocument(raw: string): OpenResult {
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) { throw new DocumentParseError(e instanceof SyntaxError ? e.message : 'unreadable'); }
  return loadDocument(json);
}

export function loadDocument(json: unknown): OpenResult {
  const diagnostics: Diagnostic[] = [];
  const version = (json as any)?.version ?? SCHEMA_VERSION;
  let readOnly = false;
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    readOnly = true;
    diagnostics.push({ level: 'warn', code: 'VERSION_NEWER', nodeId: null,
      message: `Document is v${version}; this build understands v${SCHEMA_VERSION}. Opened read-only.` });
  }
  const parsed = Document.safeParse(migrate(json));
  if (!parsed.success) throw new DocumentParseError(parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const doc = parsed.data;

  // integrity: dangling asset refs become diagnostics, never a crash
  const missing: string[] = [];
  walk(doc, (n) => {
    if (n.kind === 'image' && !doc.assets[(n as any).assetId]) {
      missing.push((n as any).assetId);
      diagnostics.push({ level: 'error', code: 'ASSET_MISSING', nodeId: n.id, message: `Image asset "${(n as any).assetId}" is missing.` });
    }
  });
  return { doc: { ...doc, diagnostics: [...doc.diagnostics, ...diagnostics] }, readOnly, diagnostics };
}

/** Migrations are additive and forward-only. Never down-migrate a user's file. */
export function migrate(json: any): any {
  if (!json || typeof json !== 'object') return json;
  const v = json.version ?? 0;
  let out = json;
  if (v < 1) out = { ...out, version: 1, diagnostics: out.diagnostics ?? [] };
  return out;
}

export function walk(doc: Document, fn: (n: Node, artboard: Artboard) => void): void {
  for (const ab of doc.artboards) walkNodes(ab.nodes as Node[], (n) => fn(n, ab));
}
export function walkNodes(nodes: Node[], fn: (n: Node) => void): void {
  for (const n of nodes) { fn(n); if ((n as any).kind === 'group') walkNodes((n as any).children ?? [], fn); }
}
export function findNode(doc: Document, id: string): Node | null {
  let found: Node | null = null;
  walk(doc, (n) => { if (n.id === id) found = n; });
  return found;
}
