import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './account-tests',
  // Visual baselines are a local tool with their own config; see visual.config.mjs.
  testIgnore: 'visual-baselines.spec.mjs',
  outputDir: './test-results/accounts',
  workers: 1,
  timeout: 90_000,
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
