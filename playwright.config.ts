import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  reporter: 'list',
  use: { browserName: 'chromium' },
});
