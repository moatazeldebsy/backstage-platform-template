import { defineConfig, devices } from '@playwright/test';
{%- if values.cloudGrid === 'lambdatest' %}

// LambdaTest cloud grid.
//
// Playwright does not reach a remote grid through environment variables alone —
// it needs an explicit CDP endpoint. Each project connects over `connectOptions`
// with its capabilities encoded in the URL, which is why the browser list below
// is expressed as LambdaTest platform capabilities rather than Playwright's
// bundled `devices` descriptors.
const LT_USERNAME = process.env.LT_USERNAME;
const LT_ACCESS_KEY = process.env.LT_ACCESS_KEY;

function lambdaTestEndpoint(browserName: string, browserVersion: string, platform: string) {
  const capabilities = {
    browserName,
    browserVersion,
    'LT:Options': {
      platform,
      name: '${{ values.name }}',
      build: '${{ values.name }}-' + (process.env.GITHUB_SHA ?? 'local'),
      user: LT_USERNAME,
      accessKey: LT_ACCESS_KEY,
      network: true,
      video: true,
      console: true,
    },
  };
  return `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(
    JSON.stringify(capabilities),
  )}`;
}

// Chromium maps to LambdaTest's "Chrome", webkit does not exist on the grid and
// maps to a real Safari on macOS — passing Playwright's own names straight
// through would fail with an unrecognised-browser error.
const LT_BROWSERS: Record<string, { name: string; version: string; platform: string }> = {
  chromium: { name: 'Chrome', version: 'latest', platform: 'Windows 11' },
  firefox: { name: 'MicrosoftEdge', version: 'latest', platform: 'Windows 11' },
  webkit: { name: 'pw-webkit', version: 'latest', platform: 'macOS Ventura' },
};
{%- endif %}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['github']],
  use: {
    baseURL: process.env.BASE_URL ?? '${{ values.baseUrl }}',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
{%- if values.cloudGrid === 'lambdatest' %}
  projects: ${{ JSON.stringify(values.browsers) }}.map((b: string) => ({
    name: b,
    use: {
      connectOptions: {
        wsEndpoint: lambdaTestEndpoint(
          LT_BROWSERS[b].name,
          LT_BROWSERS[b].version,
          LT_BROWSERS[b].platform,
        ),
      },
    },
  })),
{%- else %}
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
{%- endif %}
});
