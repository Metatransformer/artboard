/**
 * Everything this server is allowed to touch on disk, and nothing else.
 *
 * An MCP server is driven by an agent, not by the person who launched it, so
 * the blast radius has to be a property of the server rather than a promise
 * about how it will be asked to behave. One root directory is chosen at launch
 * and every path an agent supplies is resolved against it and checked to still
 * be inside it before any read or write happens.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

import { parseDocument, type Document, type Diagnostic } from '@artboard/schema';

/** Named, because "Error" in a tool result tells an agent nothing to act on. */
export class OutsideWorkspaceError extends Error {
  constructor(public requested: string, public root: string) {
    super(`"${requested}" is outside the workspace this server was launched with (${root}). Paths must be relative to the workspace root.`);
    this.name = 'OutsideWorkspaceError';
  }
}
export class NotADocumentError extends Error {
  constructor(public path: string) {
    super(`"${path}" is not an Artboard document (expected a .artboard.json or .json file).`);
    this.name = 'NotADocumentError';
  }
}
export class ReadOnlyError extends Error {
  constructor() {
    super('This server was launched with --read-only, so it can inspect documents but not change them.');
    this.name = 'ReadOnlyError';
  }
}

/** A document is 64 MB of JSON at the very most; past that something is wrong. */
const MAX_DOC_BYTES = 64 * 1024 * 1024;

export interface Loaded { doc: Document; diagnostics: Diagnostic[]; path: string; rel: string; }

export class Workspace {
  readonly root: string;
  constructor(root: string, readonly readOnly = false) {
    // Canonicalised, not merely resolved. The containment test below compares a
    // real path against this one, so if the root is reached through a symlink —
    // and on macOS `/tmp` and `/var` both are — an uncanonicalised root makes
    // every legitimate path inside the workspace look like an escape.
    this.root = realish(resolve(root));
  }

  /**
   * Resolve an agent-supplied path inside the workspace.
   *
   * The containment test is done on the RESOLVED path with a trailing
   * separator, not on the string the agent passed: `../` segments, a symlink
   * pointing out of the tree, and a sibling directory whose name merely starts
   * with the root's name (`/w/project-evil` against root `/w/project`) all pass
   * a naive `startsWith` and all fail this one.
   */
  resolve(p: string): string {
    const target = resolve(this.root, p);
    // A path that does not exist yet cannot be canonicalised, so canonicalise
    // the nearest ancestor that does: that is what a symlinked parent would
    // redirect the eventual write through.
    const real = realish(nearestExisting(target));
    const inside = (x: string) => x === this.root || x.startsWith(this.root + sep);
    if (!inside(real) || !inside(target)) throw new OutsideWorkspaceError(p, this.root);
    return target;
  }

  rel(abs: string): string {
    const r = relative(this.root, abs);
    return r === '' ? '.' : r;
  }

  /** Every document under the workspace, deepest-last, node_modules skipped. */
  list(): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (isDocumentName(e.name)) out.push(full);
      }
    };
    walk(this.root, 0);
    return out.sort();
  }

  load(p: string): Loaded {
    const path = this.resolve(p);
    if (!existsSync(path)) throw new NotADocumentError(this.rel(path));
    const st = statSync(path);
    if (st.isDirectory()) throw new NotADocumentError(this.rel(path));
    if (st.size > MAX_DOC_BYTES) throw new NotADocumentError(`${this.rel(path)} (${Math.round(st.size / 1e6)} MB, over the 64 MB limit)`);
    const { doc, diagnostics } = parseDocument(readFileSync(path, 'utf8'));
    return { doc, diagnostics, path, rel: this.rel(path) };
  }

  /**
   * Write via a temp file in the same directory, then rename.
   *
   * An agent editing a document is an unattended writer: a crash or a bad
   * document halfway through a direct write leaves the user with a truncated
   * file and no copy of what they had. Rename within a directory is atomic, so
   * the file on disk is always either the old document or the new one.
   */
  save(path: string, doc: Document): void {
    this.saveText(path, `${JSON.stringify(doc, null, 2)}\n`);
  }

  /** Same atomic write, for output that is not a document (an SVG export). */
  saveText(path: string, contents: string): void {
    if (this.readOnly) throw new ReadOnlyError();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, path);
  }
}

const isDocumentName = (name: string): boolean => name.endsWith('.artboard.json') || name.endsWith('.json');

/** The deepest ancestor of `p` that exists, so a new file can still be checked. */
function nearestExisting(p: string): string {
  let cur = p;
  for (let i = 0; i < 64 && !existsSync(cur); i++) {
    const up = resolve(cur, '..');
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** resolve() already collapses `..`; this additionally follows symlinks. */
function realish(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}
