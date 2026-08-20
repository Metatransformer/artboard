import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@artboard/schema': p('../../packages/schema/src/index.ts'),
      '@artboard/engine': p('../../packages/engine/src/index.ts'),
      '@artboard/render-svg': p('../../packages/render-svg/src/index.ts'),
      '@artboard/commands': p('../../packages/commands/src/index.ts'),
      '@artboard/templates': p('../../packages/templates/src/index.ts'),
    },
  },
  server: { port: 5273 },
});
