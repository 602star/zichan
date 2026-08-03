import { defineConfig } from 'vitest/config';

// Selectors/derive/format are pure TS (no DOM), so tests run in node.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
