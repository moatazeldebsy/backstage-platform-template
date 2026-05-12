/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
module.exports = {
  packageManager: 'npm',
  testRunner: 'jest',
  reporters: ['progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  coverageAnalysis: 'perTest',
  thresholds: { high: 75, low:65, break: 55 },
};
