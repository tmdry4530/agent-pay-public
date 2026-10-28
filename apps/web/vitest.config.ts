import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.resolve(root, '../../packages/core/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@agent-pay/core/policy.ts', replacement: path.join(coreSrc, 'policy.ts') },
      { find: '@agent-pay/core/orchestrator.ts', replacement: path.join(coreSrc, 'orchestrator.ts') },
      { find: '@agent-pay/core', replacement: path.join(coreSrc, 'index.ts') },
      { find: /^@agent-pay\/core\/(.+)$/, replacement: `${coreSrc}/$1` },
      { find: 'node:util', replacement: path.resolve(root, 'src/shims/node-util.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
});
