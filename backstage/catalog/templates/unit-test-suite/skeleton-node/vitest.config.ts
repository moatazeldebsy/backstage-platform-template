import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx,js}'],
      exclude: ['**/*.test.{ts,tsx,js}', '**/*.spec.{ts,tsx,js}'],
    },
  },
});
