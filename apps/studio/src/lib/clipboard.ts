/**
 * The clipboard model.
 *
 * Nodes travel on the SYSTEM clipboard as `text/plain`, wrapped in a magic
 * envelope so we can tell our own payload apart from every other piece of text
 * in the world. The system clipboard is the only channel that spans pages,
 * documents and browser tabs at once, which is why it is the primary store
 * rather than a module-level array.
 *
 * Two rules govern everything below.
 *
 *  1. **Nothing reaches the document unparsed.** Every node comes back through
 *     `buildNode` (`Node.safeParse`), so a truncated, hand-edited or hostile
 *     payload becomes either a valid node or nothing at all. Anything that is
 *     not our envelope is ignored — except plain text, which becomes a text
 *     node, because that is what a design tool should do with a pasted quote.
 *  2. **There is always an in-memory mirror.** `navigator.clipboard` does not
 *     exist on insecure origins and can be refused by permission at any moment;
 *     when that happens copy/paste keeps working for the rest of the session.
 */
import { buildNode, type Node } from '@artboard/schema';
import { uid } from '@artboard/commands';

/** How far a paste lands from the thing it was copied from, per paste. */
export const PASTE_OFFSET = 16;

const MAGIC = 'artboard/nodes';
const ENVELOPE_VERSION = 1;
/** A paste larger than this is not a design; refuse to even parse it. */
const MAX_PAYLOAD_CHARS = 8_000_000;
/** A pasted quote becomes a text node; a pasted novel does not. */
const MAX_TEXT_CHARS = 5_000;

interface Envelope { [MAGIC]: number; nodes: unknown[] }

/* ── in-memory mirror ────────────────────────────────────────────────────── */

let memory: string | null = null;
/**
 * True when the last copy could not reach the system clipboard. The system
 * clipboard may still hold an OLDER payload of ours, and pasting that instead
 * of what the user just copied would be plainly wrong — so while this is set,
 * the mirror wins.
 */
let memoryIsFresher = false;

/* ── paste cascade ───────────────────────────────────────────────────────── */

let cascadeSig = '';
let cascadeCount = 0;

/**
 * The offset for the next paste of `sig`. Pasting the same payload repeatedly
 * walks +16, +32, +48… so a run of pastes fans out instead of stacking into one
 * indistinguishable pile. Copying anything (even the same nodes again) restarts
 * the walk, because the user has re-anchored on the original.
 */
export function nextPasteOffset(sig: string): number {
  if (sig !== cascadeSig) { cascadeSig = sig; cascadeCount = 0; }
  cascadeCount += 1;
  return cascadeCount * PASTE_OFFSET;
}

function resetCascade(sig: string): void { cascadeSig = sig; cascadeCount = 0; }

/* ── serialise ───────────────────────────────────────────────────────────── */

export function serializeNodes(nodes: Node[]): string {
  const envelope: Envelope = { [MAGIC]: ENVELOPE_VERSION, nodes };
  return JSON.stringify(envelope);
}

/**
 * Read our envelope out of arbitrary text. Returns `null` for anything that is
 * not ours — including valid JSON that simply is not a node payload — and drops
 * individual nodes that fail the schema rather than rejecting the whole paste.
 */
export function parseNodes(text: string): Node[] | null {
  if (!text || text.length > MAX_PAYLOAD_CHARS) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes(MAGIC)) return null;

  let json: unknown;
  try { json = JSON.parse(trimmed); } catch { return null; }
  if (!json || typeof json !== 'object') return null;

  const env = json as Partial<Envelope>;
  if (typeof env[MAGIC] !== 'number' || env[MAGIC] > ENVELOPE_VERSION) return null;
  if (!Array.isArray(env.nodes)) return null;

  const nodes: Node[] = [];
  for (const raw of env.nodes) {
    if (!raw || typeof raw !== 'object') continue;
    try { nodes.push(buildNode(raw as Record<string, unknown>)); } catch { /* one bad node, not a bad paste */ }
  }
  return nodes.length ? nodes : null;
}

/* ── clone ───────────────────────────────────────────────────────────────── */

/**
 * Copy a set of nodes with fresh ids and a translation applied.
 *
 * Every node in the tree is re-identified, group children included: two nodes
 * sharing an id in one document breaks selection, hit-testing and every command
 * that finds a node by id. Every node in the tree is also translated, because
 * `render-svg` draws group children with their own absolute artboard
 * coordinates — a group whose box moved but whose children did not would paint
 * exactly where it started.
 */
export function cloneNodes(nodes: Node[], dx: number, dy: number): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    try { out.push(cloneNode(n, dx, dy)); } catch { /* skip anything the schema rejects */ }
  }
  return out;
}

function cloneNode(n: Node, dx: number, dy: number): Node {
  const src = n as Record<string, unknown> & { kind?: string; children?: Node[] };
  const next: Record<string, unknown> = {
    ...src,
    id: uid('n'),
    x: Math.round((src.x as number) + dx),
    y: Math.round((src.y as number) + dy),
  };
  if (src.kind === 'group') next.children = (src.children ?? []).map(c => cloneNode(c, dx, dy));
  return buildNode(next);
}

/* ── plain text ──────────────────────────────────────────────────────────── */

/** A pasted string becomes a text box roughly filling the page's inner column. */
export function textNodeFromText(
  text: string,
  page: { width: number; height: number },
  offset: number,
): Node | null {
  const body = text.replace(/\r\n/g, '\n').slice(0, MAX_TEXT_CHARS).trim();
  if (!body) return null;
  const fontSize = Math.max(16, Math.round(Math.min(page.width, page.height) * 0.045));
  const width = Math.round(page.width * 0.8);
  const lines = body.split('\n').length;
  // A rough two-lines-per-paragraph guess; the box is a starting point the user
  // drags, not a layout result.
  const height = Math.round(fontSize * 1.2 * Math.max(lines, Math.ceil(body.length / Math.max(1, width / (fontSize * 0.55)))));
  return buildNode({
    kind: 'text', id: uid('n'), name: 'Text', text: body,
    x: Math.round(page.width * 0.1) + offset,
    y: Math.round(page.height * 0.1) + offset,
    width, height: Math.max(fontSize, height),
    fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111',
  });
}

/* ── system clipboard ────────────────────────────────────────────────────── */

/** Write nodes to the system clipboard, always mirroring them in memory. */
export async function writeNodes(nodes: Node[]): Promise<'system' | 'memory'> {
  const text = serializeNodes(nodes);
  memory = text;
  resetCascade(text);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      memoryIsFresher = false;
      return 'system';
    }
  } catch { /* no clipboard, or the user said no */ }
  memoryIsFresher = true;
  return 'memory';
}

export type ClipboardRead =
  | { kind: 'nodes'; nodes: Node[]; sig: string }
  | { kind: 'text'; text: string; sig: string }
  | null;

/**
 * Read the clipboard, preferring the system so that a copy made in another tab
 * or another app wins. The mirror is used when the system read is unavailable,
 * refused, empty, or known to be staler than our own last copy.
 */
export async function readClipboard(): Promise<ClipboardRead> {
  if (!memoryIsFresher) {
    let text: string | null = null;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch { text = null; }
    if (text && text.trim()) {
      const nodes = parseNodes(text);
      if (nodes) return { kind: 'nodes', nodes, sig: text };
      return { kind: 'text', text, sig: text };
    }
  }
  if (memory) {
    const nodes = parseNodes(memory);
    if (nodes) return { kind: 'nodes', nodes, sig: memory };
  }
  return null;
}

/** Test/reset seam — used by nothing in the shipping UI. */
export function _resetClipboard(): void {
  memory = null; memoryIsFresher = false; cascadeSig = ''; cascadeCount = 0;
}
