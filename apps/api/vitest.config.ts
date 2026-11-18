import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], globals: false, testTimeout: 30000, hookTimeout: 60000, fileParallelism: false, pool: 'forks' },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
