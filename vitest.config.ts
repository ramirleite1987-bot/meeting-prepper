import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.sandcastle/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/views/**',
        'src/index.ts',
      ],
      // Thresholds are pinned slightly below current coverage so CI fails on
      // regressions but passes today. Raise as new tests land.
      thresholds: {
        lines: 55,
        functions: 70,
        branches: 75,
        statements: 55,
      },
    },
  },
});
