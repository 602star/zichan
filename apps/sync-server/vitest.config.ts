import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests start real HTTP servers and SQLite writers. Parallel
    // workers intermittently lose loopback connections during account setup on Windows.
    maxWorkers: 1,
    minWorkers: 1,
    // GitHub's Windows runners can take over 15 s for real HTTP and SQLite
    // integration flows, even with a single worker.
    testTimeout: 180_000,
  },
});
