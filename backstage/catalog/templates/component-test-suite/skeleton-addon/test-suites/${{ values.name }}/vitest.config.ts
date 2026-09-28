import { defineConfig } from 'vitest/config';

// *.component.ts, not *.test.ts: this suite lives inside the service's repo,
// and the service's own Jest/Vitest collect *.test.ts — they tried to run
// these against a service that is not running and failed its unit-test job.
export default defineConfig({
  test: {
    include: ['tests/**/*.component.ts'],
  },
});
