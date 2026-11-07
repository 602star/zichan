import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  test: {
    environment: 'node',
    // Server and SQLite integration suites share CPU and filesystem bandwidth on CI runners.
    maxWorkers: process.env.CI ? 1 : 2,
    minWorkers: 1,
    testTimeout: 240_000,
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'packages/*/src/**/*.ts',
        'apps/web/src/**/*.{ts,tsx}',
        'apps/sync-server/src/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        '**/main.tsx',
      ],
      thresholds: {
        branches: 25,
        functions: 35,
        lines: 35,
        statements: 35,
      },
    },
  },
});
