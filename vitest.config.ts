import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Include every production tools file, including files not imported by tests.
      include: ['src/tools/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 70, perFile: true },
    },
  },
});
