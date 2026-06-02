import type { Options } from '@wdio/types';

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

// BrowserStack / Sauce Labs cloud capabilities
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
      : '127.0.0.1';

export const config: Options.Testrunner = {
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
