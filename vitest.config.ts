import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@artboard/schema': pkg('schema'),
      '@artboard/engine': pkg('engine'),
      '@artboard/render-svg': pkg('render-svg'),
      '@artboard/commands': pkg('commands'),
      '@artboard/templates': pkg('templates'),
      '@artboard/charts': pkg('charts'),
      '@artboard/codes': pkg('codes'),
      '@artboard/icons': pkg('icons'),
      // The MCP server has no barrel export -- its modules are reached directly,
      // because `main.ts` starts a stdio server the moment it is imported.
      '@artboard/mcp/workspace': fileURLToPath(new URL('./packages/mcp/src/workspace.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
