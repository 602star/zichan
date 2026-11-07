import { defineConfig, devices } from '@playwright/test';

// Keep browser fixtures on a known deployment path; production derives a random default.
process.env.ADMIN_ACCESS_PATH = 'e2e-private-entry';

export default defineConfig({
  testDir: './account-tests',
  // Visual baselines are a local tool with their own config; see visual.config.mjs.
  testIgnore: 'visual-baselines.spec.mjs',
  outputDir: './test-results/accounts',
  workers: 2,
  timeout: 360_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } }
      : {}),
  },
});
