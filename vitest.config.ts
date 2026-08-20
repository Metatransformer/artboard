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
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
