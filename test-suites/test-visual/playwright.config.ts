import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    screenshot: 'on',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.2 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
