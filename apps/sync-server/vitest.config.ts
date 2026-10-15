import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests start real HTTP servers and SQLite writers. Parallel
    // workers intermittently lose loopback connections during account setup on Windows.
    maxWorkers: 1,
    minWorkers: 1,
    // Account login and multi-request admin flows can exceed Vitest's 5 s
    // default on Windows even without parallel workers.
    testTimeout: 15_000,
  },
});
