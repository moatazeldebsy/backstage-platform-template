import { defineConfig, devices } from '@playwright/test';
{%- if values.cloudGrid === 'lambdatest' or values.cloudGrid === 'browserstack' %}

// Cloud browser grid: ${{ values.cloudGrid }}.
//
// Playwright does not reach a remote grid through environment variables alone —
// it needs an explicit CDP endpoint, so each project connects over
// `connectOptions` with its capabilities encoded in the URL. That is why the
// browser list below is expressed as vendor platform capabilities rather than
// Playwright's bundled `devices` descriptors.
//
// Sauce Labs is absent here on purpose: it has no Playwright CDP endpoint and
// runs suites through the saucectl CLI instead (see .sauce/config.yml).
{%- if values.cloudGrid === 'lambdatest' %}
const LT_USERNAME = process.env.LT_USERNAME;
const LT_ACCESS_KEY = process.env.LT_ACCESS_KEY;

function gridEndpoint(browserName: string, browserVersion: string, platform: string) {
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
const GRID_BROWSERS: Record<string, { name: string; version: string; platform: string }> = {
  chromium: { name: 'Chrome', version: 'latest', platform: 'Windows 11' },
  firefox: { name: 'MicrosoftEdge', version: 'latest', platform: 'Windows 11' },
  webkit: { name: 'pw-webkit', version: 'latest', platform: 'macOS Ventura' },
};
{%- else %}
const BROWSERSTACK_USERNAME = process.env.BROWSERSTACK_USERNAME;
const BROWSERSTACK_ACCESS_KEY = process.env.BROWSERSTACK_ACCESS_KEY;

// BrowserStack takes a flat `caps` object under a different query parameter than
// LambdaTest's nested `capabilities` — the two are not interchangeable.
function gridEndpoint(browserName: string, browserVersion: string, platform: string) {
  const caps = {
    browser: browserName,
    browser_version: browserVersion,
    os: platform.split(' ')[0],
    os_version: platform.split(' ').slice(1).join(' '),
    name: '${{ values.name }}',
    build: '${{ values.name }}-' + (process.env.GITHUB_SHA ?? 'local'),
    'browserstack.username': BROWSERSTACK_USERNAME,
    'browserstack.accessKey': BROWSERSTACK_ACCESS_KEY,
    'client.playwrightVersion': '1.44.0',
  };
  return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(
    JSON.stringify(caps),
  )}`;
}

// BrowserStack exposes real Safari as "playwright-webkit"; chromium/firefox keep
// their Playwright names here, unlike LambdaTest.
const GRID_BROWSERS: Record<string, { name: string; version: string; platform: string }> = {
  chromium: { name: 'playwright-chromium', version: 'latest', platform: 'Windows 11' },
  firefox: { name: 'playwright-firefox', version: 'latest', platform: 'Windows 11' },
  webkit: { name: 'playwright-webkit', version: 'latest', platform: 'OS X Ventura' },
};
{%- endif %}
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
          wsEndpoint: gridEndpoint(
            GRID_BROWSERS.chromium.name,
            GRID_BROWSERS.chromium.version,
            GRID_BROWSERS.chromium.platform,
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
