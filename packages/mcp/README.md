# @artboard/mcp

An MCP server over the Artboard document model, so an agent can look at a design
and move things around in it without a browser.

```bash
node packages/mcp/bin/artboard-mcp.mjs ~/designs            # read + write
node packages/mcp/bin/artboard-mcp.mjs ~/designs --read-only # inspect only
```

Register it with Claude Code:

```bash
claude mcp add artboard -- node /path/to/artboard/packages/mcp/bin/artboard-mcp.mjs ~/designs
```

## Tools

| Tool | Does |
|---|---|
| `list_documents` | Every document in the workspace |
| `open_document` | An outline: artboards, and each node's id, kind, box and look |
| `get_node` | One node, every property |
| `render_artboard` | The artboard as SVG source, from the renderer the editor uses |
| `edit_document` | Apply commands and save; `dryRun` to preview |
| `export_document` | Write an artboard out as a file |

## Why it is safe to point at an agent

Both properties are structural. Neither depends on how the server is asked to
behave, which matters because the thing driving it is a language model reading
attacker-influenceable content.

**One workspace root.** Chosen at launch. Every agent-supplied path is resolved
against it and checked to still be inside it, comparing canonical paths so that
`../`, an absolute path, a symlink pointing out of the tree, and a sibling
directory that merely shares the root's name as a prefix are all refused. There
is no flag to widen it; relaunch with a different root instead.

**Edits go through the real command layer.** `edit_document` runs
`@artboard/commands` — the same code path as the editor's own undo stack — and
then re-parses the result through the schema before anything reaches disk. An
agent cannot write a document the editor would refuse to open. Commands are
all-or-nothing: one bad command in a list leaves the file untouched.

Writes are atomic (temp file plus rename), because an agent is an unattended
writer and a crash mid-write should leave the user with their old document
rather than half of a new one.

## Notes

- Coordinates are absolute within an artboard, **including for a group's
  children**. Moving a group does not move what is inside it.
- `render_artboard` omits image data by default. Inline assets are usually
  megabytes of base64 and rarely what the agent is looking at.
- Raster export needs a canvas, so it stays in the editor; the server exports
  SVG.

## Not done yet

- No resources or prompts, only tools.
- No PNG/PDF export (the CLI does both; `export_document` is SVG only).
- No watch/notification support — an agent sees a document as of the moment it
  asks, and a document changed underneath it is not announced.
