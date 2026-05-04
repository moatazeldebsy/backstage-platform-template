/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
module.exports = {
  packageManager: 'npm',
  testRunner: '${{ values.testRunner }}',
  reporters: ${{ values.reporters | dump }},
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  coverageAnalysis: 'perTest',
  thresholds: {
    high: ${{ values.mutationScore }},
    low: ${{ values.mutationScore - 10 }},
    break: ${{ values.mutationScore - 20 }},
  },
};
