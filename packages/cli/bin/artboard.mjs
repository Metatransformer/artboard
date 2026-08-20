#!/usr/bin/env node
/**
 * `artboard` launcher.
 *
 * The workspace packages are TypeScript with no build step, so this file stays
 * plain JS: it registers tsx's ESM hook in-process and then imports the real
 * entry point. No spawn, no compile step, no dist/ to keep in sync -- one
 * process, so the exit code the command returns is the exit code you get.
 */

const entry = new URL('../src/main.ts', import.meta.url).href;

let register;
try {
  ({ register } = await import('tsx/esm/api'));
} catch (error) {
  const name = error instanceof Error ? error.name : 'ThrownValue';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`artboard: cannot load the TypeScript loader -- ${name}: ${message}\n`);
  process.stderr.write('artboard: run `npm install` at the repo root (it installs tsx), then try again.\n');
  process.exit(2);
}

const registered = register();

try {
  const { run } = await import(entry);
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  const name = error instanceof Error ? error.name : 'ThrownValue';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`artboard: ${name}: ${message}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  // Release tsx's resolver so the process can exit on its own, which lets
  // stdout flush properly instead of being truncated by process.exit().
  if (typeof registered === 'function') registered();
  else if (registered && typeof registered.unregister === 'function') registered.unregister();
}
