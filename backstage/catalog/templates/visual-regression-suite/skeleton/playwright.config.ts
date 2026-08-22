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
  fullyParallel: false,
  retries: 0,
  reporter: [['html', { open: 'never' }], ['github']],
  use: {
    baseURL: process.env.BASE_URL ?? '${{ values.baseUrl }}',
    screenshot: 'on',
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: ${{ values.diffThreshold }} / 100,
    },
  },
{%- if values.cloudGrid === 'lambdatest' %}
  // Screenshot baselines are resolution- and renderer-sensitive, so the cloud
  // grid runs a single pinned platform rather than a spread — a baseline
  // captured on one OS will not match another.
  projects: [
    {
      name: 'chromium',
      use: {
        connectOptions: {
          wsEndpoint: lambdaTestEndpoint(
            LT_BROWSERS.chromium.name,
            LT_BROWSERS.chromium.version,
            LT_BROWSERS.chromium.platform,
          ),
        },
      },
    },
  ],
{%- else %}
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
{%- endif %}
});
