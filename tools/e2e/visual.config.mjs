import { defineConfig, devices } from '@playwright/test';

/*
 * Local visual baselines only. Kept out of `account.config.mjs` so the enforced
 * suite never depends on pixels: see the header of visual-baselines.spec.mjs.
 *
 * Baselines are written to ./visual-baselines, which is gitignored on purpose -
 * they describe this machine's font stack and rasteriser, not the product.
 */
export default defineConfig({
  testDir: './account-tests',
  testMatch: 'visual-baselines.spec.mjs',
  outputDir: './test-results/visual',
  snapshotDir: './visual-baselines',
  workers: 1,
  timeout: 1_200_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } }
      : {}),
  },
});
