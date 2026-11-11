import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: '.', base: '/static/',
  build: { outDir: '../python/src/llm_engine/static', emptyOutDir: true },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], restoreMocks: true },
});
