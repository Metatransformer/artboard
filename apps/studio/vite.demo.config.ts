import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Single-file build: everything inlined into one .html for the shareable demo.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      '@artboard/schema': p('../../packages/schema/src/index.ts'),
      '@artboard/engine': p('../../packages/engine/src/index.ts'),
      '@artboard/render-svg': p('../../packages/render-svg/src/index.ts'),
      '@artboard/commands': p('../../packages/commands/src/index.ts'),
      '@artboard/templates': p('../../packages/templates/src/index.ts'),
    },
  },
  build: { outDir: 'dist-demo', assetsInlineLimit: 100000000, cssCodeSplit: false, reportCompressedSize: false },
});
