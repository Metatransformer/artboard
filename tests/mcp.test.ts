import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Workspace, OutsideWorkspaceError, ReadOnlyError } from '@artboard/mcp/workspace';

/**
 * The MCP server is driven by an agent rather than by the person who launched
 * it, so its containment is the only thing standing between a crafted prompt
 * and the rest of the disk. Everything else about the server was proven by
 * driving it over a real stdio transport; this is here because a containment
 * regression is silent — the server keeps working, it just also works on files
 * it should never have touched.
 */
describe('mcp workspace containment', () => {
  let root: string, outside: string, ws: Workspace;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'artboard-ws-'));
    root = join(base, 'project');
    outside = join(base, 'secrets');
    mkdirSync(root); mkdirSync(outside);
    writeFileSync(join(root, 'a.artboard.json'), '{}');
    writeFileSync(join(outside, 'keys.json'), '{}');
    // A sibling whose name merely STARTS WITH the root's name. A containment
    // check written as `startsWith(root)` without the separator lets this in.
    mkdirSync(`${root}-evil`);
    writeFileSync(join(`${root}-evil`, 'x.json'), '{}');
    symlinkSync(outside, join(root, 'escape'));
    ws = new Workspace(root);
  });
  afterAll(() => { try { rmSync(resolve(root, '..'), { recursive: true, force: true }); } catch { /* best effort */ } });

  it('allows paths inside the root', () => {
    // Against `ws.root`, not the path handed to the constructor: the workspace
    // canonicalises its root, and on macOS the tmpdir is reached through a
    // symlink (/var -> /private/var), so the two differ on exactly the platform
    // this runs on.
    expect(ws.resolve('a.artboard.json')).toBe(join(ws.root, 'a.artboard.json'));
    expect(ws.resolve('./nested/deep.json')).toBe(join(ws.root, 'nested', 'deep.json'));
  });

  it('a file that does not exist yet is still checked against the root', () => {
    expect(ws.resolve('new/deeper/out.svg')).toBe(join(ws.root, 'new', 'deeper', 'out.svg'));
    expect(() => ws.resolve('escape/new-file.json')).toThrow(OutsideWorkspaceError);
  });

  for (const bad of ['../secrets/keys.json', '/etc/hosts', 'a/../../secrets/keys.json', 'escape/keys.json']) {
    it(`refuses ${bad}`, () => {
      expect(() => ws.resolve(bad)).toThrow(OutsideWorkspaceError);
    });
  }

  it('refuses a sibling directory that shares the root as a name prefix', () => {
    // `${root}-evil` starts with `${root}` as a string but is not inside it.
    expect(() => ws.resolve(join(`${root}-evil`, 'x.json'))).toThrow(OutsideWorkspaceError);
  });

  it('a read-only workspace refuses every write', () => {
    const ro = new Workspace(root, true);
    expect(() => ro.saveText(join(root, 'a.artboard.json'), 'x')).toThrow(ReadOnlyError);
  });
});
