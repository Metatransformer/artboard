#!/usr/bin/env node
/**
 * `artboard-mcp` launcher.
 *
 * Mirrors packages/cli/bin/artboard.mjs: the workspace is TypeScript with no
 * build step, so this stays plain JS and registers tsx in-process.
 *
 * One rule specific to an MCP server: stdout is the JSON-RPC transport, so
 * NOTHING may ever be written to it but protocol frames. Every message this
 * launcher emits goes to stderr, where the host shows it as server log output.
 */

const entry = new URL('../src/main.ts', import.meta.url).href;

let register;
try {
  ({ register } = await import('tsx/esm/api'));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`artboard-mcp: cannot load the TypeScript loader -- ${message}\n`);
  process.stderr.write('artboard-mcp: run `npm install` at the repo root, then try again.\n');
  process.exit(2);
}

const registered = register();

try {
  const { main } = await import(entry);
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`artboard-mcp: ${message}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  if (typeof registered === 'function') registered();
  else if (registered && typeof registered.unregister === 'function') registered.unregister();
}
