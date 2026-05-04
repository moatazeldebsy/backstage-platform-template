import type { Options } from '@wdio/types';

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/**/*.spec.ts'],
  framework: 'mocha',
  reporters: ['spec', ['junit', { outputDir: './reports' }]],
  mochaOpts: { timeout: 60000 },
  capabilities: [
    {
      platformName: '${{ values.platform }}' === 'ios' ? 'iOS' : 'Android',
      'appium:automationName': '${{ values.platform }}' === 'ios' ? 'XCUITest' : 'UiAutomator2',
      'appium:deviceName': '${{ values.platform }}' === 'ios' ? 'iPhone Simulator' : 'Android Emulator',
      'appium:app': process.env.APP_PATH ?? 'path/to/your.app',
    },
  ],
  services: [['appium', { command: 'appium', args: { address: '127.0.0.1', port: 4723 } }]],
};
