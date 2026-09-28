/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 60000,
  // *.it.ts, not *.spec.ts: this suite lives inside the service's repo, and the
  // service's own test runner collects *.spec.ts from the whole repo — it tried
  // to run these (they need Docker and ts-jest) and failed its unit-test job.
  testMatch: ['<rootDir>/tests/**/*.it.ts'],
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: 'reports', outputName: 'junit.xml' }],
  ],
};
