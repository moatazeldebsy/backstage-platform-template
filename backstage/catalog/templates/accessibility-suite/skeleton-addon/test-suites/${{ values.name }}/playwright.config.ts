import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // *.e2e.ts, not *.spec.ts: this suite lives inside the service's repo, and
  // the service's own Jest/Vitest collect *.spec.ts — they tried to run these
  // Playwright specs and failed the service's unit-test job.
  testMatch: '**/*.e2e.ts',
  reporter: [['html', { open: 'never' }], ['github']],
  use: {
    baseURL: process.env.BASE_URL ?? '${{ values.baseUrl }}',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
