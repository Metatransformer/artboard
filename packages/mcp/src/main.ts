/**
 * artboard-mcp -- an MCP server over the Artboard document model.
 *
 *   artboard-mcp [workspace-dir] [--read-only]
 *
 * It exists so an agent can look at a design and move things around in it
 * without a browser: `list_documents` / `open_document` / `get_node` /
 * `render_artboard` to see, `edit_document` to change, `export_document` to
 * produce a file.
 *
 * Two properties make this safe enough to hand to an agent, and both are
 * structural rather than advisory:
 *
 *   - Every path is confined to one workspace root chosen at launch (see
 *     workspace.ts), so no prompt can talk the server into reading ~/.ssh.
 *   - Every mutation goes through @artboard/commands and is re-parsed by the
 *     schema before it is written, so an agent cannot produce a document the
 *     editor would refuse to open. This is the same code path the editor's own
 *     undo stack runs on, which is why an edit made here behaves identically to
 *     one made by hand.
 *
 * stdout belongs to the JSON-RPC transport. Anything this process wants to say
 * to a human goes to stderr.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { apply, uid, StaleCommandError, type Command } from '@artboard/commands';
import { buildNode, loadDocument, findNode, type Document } from '@artboard/schema';
import { renderToString } from '@artboard/render-svg';

import { Workspace, OutsideWorkspaceError, NotADocumentError, ReadOnlyError } from './workspace.js';
import { describeDocument, describeArtboard, box } from './summary.js';

const VERSION = '0.1.0';

/* ── tool results ─────────────────────────────────────────────────────────── */

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/**
 * Failures come back as a tool result with isError, never as a thrown
 * exception: a throw becomes a protocol error the model cannot read, and the
 * whole point of a named error is that the agent gets told what to do instead.
 */
const fail = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
};

/* ── the command shape agents send ────────────────────────────────────────── */

/**
 * Deliberately a permissive schema over the command union rather than a mirror
 * of it. `@artboard/commands` is the authority on what a command means and the
 * document schema is the authority on what a node may contain; duplicating
 * either here would create a second definition to keep in sync, and the first
 * time they disagreed the server would reject edits the editor accepts.
 */
/**
 * Every `Command['type']`, listed once so the compiler can check the list.
 *
 * The `satisfies` is the whole point and the reason this is not a bare array:
 * `Record<Command['type'], true>` fails to typecheck the moment the union grows
 * a member this object lacks, so adding a command to `@artboard/commands` and
 * forgetting the server is a build error rather than a runtime rejection an
 * agent discovers at the boundary. The previous version hand-copied these into
 * a `z.enum` under a comment promising not to duplicate the union — the comment
 * was right and the code under it was the duplication.
 *
 * Values are `true` only because an object is what `satisfies Record<...>` can
 * check; the keys are the payload.
 */
const COMMAND_TYPES = {
  addNode: true, removeNode: true, updateNode: true, reorder: true,
  group: true, ungroup: true, setArtboard: true, translate: true,
  addAsset: true, batch: true,
} satisfies Record<Command['type'], true>;

const CommandInput = z.object({
  type: z.enum(Object.keys(COMMAND_TYPES) as [Command['type'], ...Command['type'][]]),
  artboardId: z.string().optional(),
  nodeId: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
  groupId: z.string().optional(),
  node: z.record(z.unknown()).optional(),
  patch: z.record(z.unknown()).optional(),
  index: z.number().optional(),
  to: z.number().optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
}).passthrough();

export function main(argv: readonly string[]): Promise<void> {
  const readOnly = argv.includes('--read-only');
  const positional = argv.filter(a => !a.startsWith('--'));
  const ws = new Workspace(positional[0] ?? process.cwd(), readOnly);

  const server = new McpServer(
    { name: 'artboard', version: VERSION },
    { instructions: [
      'Artboard documents are declarative JSON: every node has an id, a kind, and an x/y/width/height box in artboard coordinates.',
      'Read with open_document (an outline) or get_node (one node in full); change with edit_document, which takes the same commands the editor uses.',
      'Coordinates are absolute within an artboard, including for a group\'s children. Move things with the "translate" command (dx/dy), which shifts a whole subtree; patching x/y with updateNode moves a group\'s bounds without its children and is refused.',
      'A group cannot be resized: patching its width/height is refused too, and nothing scales a subtree yet. To make grouped artwork bigger, resize each child. A group CAN be rotated, renamed, hidden and restyled.',
      `Paths are relative to the workspace root: ${ws.root}`,
      readOnly ? 'This server is READ-ONLY: edit_document will refuse.' : '',
    ].filter(Boolean).join('\n') },
  );

  /* ── look at stuff ──────────────────────────────────────────────────── */

  server.registerTool('list_documents', {
    title: 'List documents',
    description: 'Every Artboard document in the workspace, as paths you can pass to the other tools.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const found = ws.list();
      if (found.length === 0) return text(`No documents under ${ws.root}.`);
      return text(found.map(f => ws.rel(f)).join('\n'));
    } catch (e) { return fail(e); }
  });

  server.registerTool('open_document', {
    title: 'Open document',
    description: 'An outline of a document: its artboards, and every node with its id, kind, box and the properties that decide how it looks. Start here.',
    inputSchema: { path: z.string().describe('Document path, relative to the workspace root.') },
    annotations: { readOnlyHint: true },
  }, async ({ path }) => {
    try {
      const { doc, diagnostics, rel } = ws.load(path);
      return text(describeDocument(doc, rel, diagnostics));
    } catch (e) { return fail(e); }
  });

  server.registerTool('get_node', {
    title: 'Get node',
    description: 'One node with every property it has, including effects, fills and stroke. Use after open_document when the outline is not enough.',
    inputSchema: {
      path: z.string().describe('Document path, relative to the workspace root.'),
      nodeId: z.string().describe('Node id, as shown by open_document.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ path, nodeId }) => {
    try {
      const { doc } = ws.load(path);
      const node = findNode(doc, nodeId);
      if (!node) return fail(new Error(`No node "${nodeId}" in this document. Run open_document to see the ids it does have.`));
      return text(JSON.stringify(node, null, 2));
    } catch (e) { return fail(e); }
  });

  server.registerTool('render_artboard', {
    title: 'Render artboard',
    description: 'The artboard as SVG source -- the same renderer the editor and the CLI use, so what you read here is what a person sees.',
    inputSchema: {
      path: z.string().describe('Document path, relative to the workspace root.'),
      artboard: z.number().int().min(0).default(0).describe('Artboard index, as shown in brackets by open_document.'),
      inlineAssets: z.boolean().default(false)
        .describe('Embed image data. Off by default: it is usually megabytes of base64 and rarely what you are looking at.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ path, artboard, inlineAssets }) => {
    try {
      const { doc } = ws.load(path);
      const count = (doc as any).artboards.length;
      if (artboard >= count) return fail(new Error(`Artboard ${artboard} does not exist (this document has ${count}).`));
      const { svg, diagnostics } = renderToString(doc, artboard, { inlineAssets });
      const notes = diagnostics.length ? `\n\n<!-- ${diagnostics.length} diagnostic(s): ${diagnostics.map(d => d.message).join('; ')} -->` : '';
      return text(svg + notes);
    } catch (e) { return fail(e); }
  });

  /* ── move stuff around ──────────────────────────────────────────────── */

  server.registerTool('edit_document', {
    title: 'Edit document',
    description: [
      'Apply commands to a document and save it. Commands run in order and either ALL apply or none do.',
      '',
      'move                : {"type":"translate","nodeIds":["t1"],"dx":40,"dy":80}',
      'resize/restyle      : {"type":"updateNode","nodeId":"t1","patch":{"width":200}}',
      'add                 : {"type":"addNode","artboardId":"ab","node":{"kind":"rect","x":0,"y":0,"width":80,"height":40}}',
      'delete              : {"type":"removeNode","artboardId":"ab","nodeId":"r2"}',
      'restack             : {"type":"reorder","artboardId":"ab","nodeId":"r2","to":0}',
      'group / ungroup     : {"type":"group","artboardId":"ab","nodeIds":["a","b"]}',
      'artboard itself     : {"type":"setArtboard","artboardId":"ab","patch":{"width":1200}}',
      '',
      'A node in `addNode` needs only `kind` and its box; every other field takes its schema default. An `id` is generated if you omit one.',
    ].join('\n'),
    inputSchema: {
      path: z.string().describe('Document path, relative to the workspace root.'),
      commands: z.array(CommandInput).min(1).describe('Commands to apply, in order.'),
      dryRun: z.boolean().default(false).describe('Apply and report the result WITHOUT writing to disk.'),
    },
  }, async ({ path, commands, dryRun }) => {
    try {
      if (ws.readOnly) throw new ReadOnlyError();
      const { doc, path: abs, rel } = ws.load(path);

      // Applied to a copy. A command that throws half way through leaves the
      // document on disk untouched rather than partly edited.
      let next: Document = doc;
      const applied: string[] = [];
      for (const [i, raw] of commands.entries()) {
        const cmd = normalize(raw, next);
        try {
          next = apply(next, cmd);
        } catch (e) {
          if (e instanceof StaleCommandError) {
            throw new Error(`Command ${i + 1} (${cmd.type}) targets "${e.nodeId}", which is not in the document. Nothing was written. Run open_document for the current ids.`);
          }
          throw new Error(`Command ${i + 1} (${cmd.type}) failed: ${e instanceof Error ? e.message : String(e)}. Nothing was written.`);
        }
        applied.push(describeCommand(cmd));
      }

      // The schema, not the command layer, is the final word on whether this is
      // still a document -- so re-parse before it reaches disk. An agent that
      // patches `width` to a string finds out here, not when a person next
      // tries to open the file.
      const reloaded = loadDocument(JSON.parse(JSON.stringify(next)));
      if (reloaded.diagnostics.some(d => (d as any).severity === 'error')) {
        throw new Error(`The result would not load cleanly: ${reloaded.diagnostics.map(d => d.message).join('; ')}. Nothing was written.`);
      }

      if (!dryRun) ws.save(abs, reloaded.doc);
      const head = dryRun ? `Dry run -- ${rel} NOT written.` : `Wrote ${rel}.`;
      return text([head, ...applied.map(a => `  ${a}`), '', describeDocument(reloaded.doc, rel, [])].join('\n'));
    } catch (e) { return fail(e); }
  });

  server.registerTool('export_document', {
    title: 'Export document',
    description: 'Write an artboard out as a file. `svg` and `pdf` are produced headlessly; raster formats need a canvas and are only available in the editor.',
    inputSchema: {
      path: z.string().describe('Document path, relative to the workspace root.'),
      out: z.string().describe('Destination path, relative to the workspace root.'),
      artboard: z.number().int().min(0).default(0),
      format: z.enum(['svg']).default('svg'),
    },
  }, async ({ path, out, artboard, format }) => {
    try {
      if (ws.readOnly) throw new ReadOnlyError();
      const { doc } = ws.load(path);
      const count = (doc as any).artboards.length;
      if (artboard >= count) return fail(new Error(`Artboard ${artboard} does not exist (this document has ${count}).`));
      const target = ws.resolve(out);
      const { svg } = renderToString(doc, artboard, { inlineAssets: true });
      ws.saveText(target, svg);
      return text(`Wrote ${ws.rel(target)} (${format}, ${svg.length} bytes).`);
    } catch (e) { return fail(e); }
  });

  process.stderr.write(`artboard-mcp ${VERSION} on ${ws.root}${readOnly ? ' (read-only)' : ''}\n`);
  return server.connect(new StdioServerTransport());
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * Fill in what an agent can reasonably leave out.
 *
 * Requiring an artboardId on every command would be correct and tedious: most
 * documents have one artboard, and an agent that has to ask for its id before
 * every edit burns a round trip to learn something the server already knows.
 * Same for generated ids.
 */
/**
 * The command types that actually carry an `artboardId`, derived from the union.
 *
 * `normalize` phrased this as a denylist -- `type !== 'updateNode'`, then
 * `&& type !== 'translate'` once translate landed -- i.e. a hand-made claim
 * that every OTHER command is artboard-scoped. `batch` and `addAsset` are not,
 * so that test threw "needs an artboardId" at commands with no such field on
 * any document with more than one artboard, and the list needed a human to
 * remember it each time the union grew. The `satisfies` makes both halves the
 * compiler's problem: a new artboard-scoped command missing from this list
 * fails to build, and a name here that is not artboard-scoped is an
 * excess-property error.
 */
const NEEDS_ARTBOARD = {
  addNode: true, removeNode: true, reorder: true,
  setArtboard: true, group: true, ungroup: true,
} satisfies Record<Extract<Command, { artboardId: string }>['type'], true>;

function normalize(raw: z.infer<typeof CommandInput>, doc: Document): Command {
  const cmd: any = { ...raw };
  const boards = (doc as any).artboards;

  if (cmd.type === 'batch') {
    // Sub-commands are commands. Without this they skip artboardId inference
    // and the buildNode pass below, so a batch was a way to smuggle in exactly
    // the raw literals the rest of this function exists to prevent.
    cmd.commands = (cmd.commands ?? []).map((c: any) => normalize(c, doc));
    return cmd as Command;
  }

  if (cmd.artboardId === undefined && cmd.type in NEEDS_ARTBOARD) {
    if (boards.length === 1) cmd.artboardId = boards[0].id;
    else if (cmd.nodeId || cmd.nodeIds?.length) {
      const probe = cmd.nodeId ?? cmd.nodeIds[0];
      const owner = boards.find((b: any) => containsNode(b.nodes, probe));
      if (owner) cmd.artboardId = owner.id;
    }
    if (cmd.artboardId === undefined) {
      throw new Error(`This document has ${boards.length} artboards, so "${cmd.type}" needs an artboardId. They are: ${boards.map((b: any) => b.id).join(', ')}.`);
    }
  }

  // A node literal from an agent goes through buildNode for the same reason
  // every other node in this codebase does: it is the only way to be sure the
  // result carries every field the current schema defines.
  if (cmd.type === 'addNode' && cmd.node) cmd.node = buildNode({ id: cmd.node.id ?? uid(), ...cmd.node });
  if (cmd.type === 'group' && !cmd.groupId) cmd.groupId = uid('g');
  return cmd as Command;
}

const containsNode = (nodes: any[], id: string): boolean =>
  nodes.some(n => n.id === id || (n.kind === 'group' && containsNode(n.children ?? [], id)));

function describeCommand(cmd: any): string {
  switch (cmd.type) {
    case 'addNode': return `+ ${cmd.node.kind} ${cmd.node.id} at ${box(cmd.node)}`;
    case 'removeNode': return `- removed ${cmd.nodeId}`;
    case 'updateNode': return `~ ${cmd.nodeId}: ${Object.entries(cmd.patch ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`;
    case 'reorder': return `↕ ${cmd.nodeId} -> index ${cmd.to}`;
    case 'group': return `▣ grouped ${cmd.nodeIds.join(', ')} as ${cmd.groupId}`;
    case 'ungroup': return `▢ ungrouped ${cmd.groupId}`;
    case 'translate': return `→ moved ${cmd.nodeIds.join(', ')} by (${cmd.dx}, ${cmd.dy})`;
    case 'setArtboard': return `⬚ artboard ${cmd.artboardId}: ${Object.entries(cmd.patch ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`;
    case 'batch': return `[${cmd.label}] ${(cmd.commands ?? []).map(describeCommand).join('; ')}`;
    case 'addAsset': return `+ asset ${cmd.asset.id} (${cmd.asset.mime} ${cmd.asset.width}x${cmd.asset.height})`;
    default: return cmd.type;
  }
}

export { OutsideWorkspaceError, NotADocumentError, ReadOnlyError };
