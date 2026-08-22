// wdio 9 moved the testrunner config shape: Options.Testrunner no longer
// carries `capabilities`. WebdriverIO.Config (global, from @wdio/globals/types)
// is the v9 equivalent.
import '@wdio/globals/types';

const DEVICE_FARM = process.env.DEVICE_FARM ?? '${{ values.deviceFarm }}';
const APP_PATH = process.env.APP_PATH ?? 'path/to/your.app';

// Device profiles for cloud device farms
const DEVICE_PROFILES: Record<string, object> = {
  'pixel6-android13': {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'Google Pixel 6',
    'appium:platformVersion': '13',
  },
  'samsung-s21-android12': {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'Samsung Galaxy S21',
    'appium:platformVersion': '12',
  },
  'pixel7-android14': {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'Google Pixel 7',
    'appium:platformVersion': '14',
  },
  'iphone14-ios16': {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:deviceName': 'iPhone 14',
    'appium:platformVersion': '16',
  },
};

const selectedDevices = (${{ JSON.stringify(values.deviceMatrix) }} as string[])
  .map((d) => ({ ...DEVICE_PROFILES[d], 'appium:app': APP_PATH }))
  .filter(Boolean);

// Cloud device-farm capabilities. Each vendor reads its credentials from a
// different vendor-prefixed options block; the platform injects all of them as
// repository secrets, and the CI workflow exports only the pair this suite needs.
const cloudCapabilities = selectedDevices.map((device) => {
  if (DEVICE_FARM === 'browserstack') {
    return {
      ...device,
      'bstack:options': {
        userName: process.env.BROWSERSTACK_USERNAME,
        accessKey: process.env.BROWSERSTACK_ACCESS_KEY,
        projectName: '${{ values.name }}',
        buildName: process.env.GITHUB_SHA ?? 'local',
        sessionName: 'Appium Mobile Suite',
        debug: true,
        networkLogs: true,
      },
    };
  }
  if (DEVICE_FARM === 'sauce-labs') {
    return {
      ...device,
      'sauce:options': {
        username: process.env.SAUCE_USERNAME,
        accessKey: process.env.SAUCE_ACCESS_KEY,
        build: '${{ values.name }}-' + (process.env.GITHUB_SHA ?? 'local'),
      },
    };
  }
  if (DEVICE_FARM === 'lambdatest') {
    // DEVICE_PROFILES uses BrowserStack's vendor-prefixed names ("Google Pixel 6",
    // "Samsung Galaxy S21"). LambdaTest names the same hardware without the
    // manufacturer ("Pixel 6", "Galaxy S21") and rejects the prefixed form, so
    // normalise rather than duplicating the whole profile table.
    const ltDevice = {
      ...device,
      'appium:deviceName': (device as Record<string, string>)['appium:deviceName']?.replace(
        /^(Google|Samsung|Apple) /,
        '',
      ),
    };
    return {
      ...ltDevice,
      'LT:Options': {
        user: process.env.LT_USERNAME,
        accessKey: process.env.LT_ACCESS_KEY,
        project: '${{ values.name }}',
        build: '${{ values.name }}-' + (process.env.GITHUB_SHA ?? 'local'),
        name: 'Appium Mobile Suite',
        // Real hardware, not LambdaTest's emulator pool — the whole point of
        // choosing a device farm over the local-emulator option.
        isRealMobile: true,
        w3c: true,
        deviceLog: true,
        network: true,
        visual: true,
      },
    };
  }
  return device;
});

// Local emulator capability (single device)
const localCapability = {
  platformName: '${{ values.platform }}' === 'ios' ? 'iOS' : 'Android',
  'appium:automationName': '${{ values.platform }}' === 'ios' ? 'XCUITest' : 'UiAutomator2',
  'appium:deviceName': '${{ values.platform }}' === 'ios' ? 'iPhone Simulator' : 'Android Emulator',
  'appium:app': APP_PATH,
};

const capabilities = DEVICE_FARM === 'local-emulator' ? [localCapability] : cloudCapabilities;

const hostname =
  DEVICE_FARM === 'browserstack'
    ? 'hub-cloud.browserstack.com'
    : DEVICE_FARM === 'sauce-labs'
      ? 'ondemand.us-west-1.saucelabs.com'
      : DEVICE_FARM === 'lambdatest'
        ? 'mobile-hub.lambdatest.com'
        : '127.0.0.1';

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./tests/**/*.spec.ts'],
  framework: 'mocha',
  reporters: ['spec', ['junit', { outputDir: './reports' }]],
  mochaOpts: { timeout: 120000 },
  maxInstances: DEVICE_FARM === 'local-emulator' ? 1 : 3,
  hostname,
  port: 4723,
  path: DEVICE_FARM === 'local-emulator' ? '/' : '/wd/hub',
  capabilities,
  services:
    DEVICE_FARM === 'local-emulator'
      ? [['appium', { command: 'appium', args: { address: '127.0.0.1', port: 4723 } }]]
      : [],
};
