import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    environmentOptions: {
      node: {
        env: {
          VITEST_INTEGRATION_TEST: process.env.VITEST_INTEGRATION_TEST || 'false'
        }
      }
    }
  },
});