import { defineConfig } from 'vitest/config';

/*
 * Pin the zone so date behaviour is identical on every machine and in CI.
 * Node otherwise inherits the host zone, which makes any assertion touching a
 * local calendar day pass in Shanghai and fail on a UTC runner. Asia/Shanghai
 * is the product's primary zone, and being non-UTC it exposes UTC/local mixups
 * instead of hiding them.
 */
process.env.TZ = 'Asia/Shanghai';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
