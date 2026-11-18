/* E2E 試験（15 2.5）。本番と同じ形（静的な画面＋/api の転送）で、にせものの freee・メールを使う */
import { defineConfig } from '@playwright/test';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/soilflow_e2e';
const WEB = 'http://localhost:3100';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 1本の流れで状態を引き継ぐため、やり直しはしない
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: WEB,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH } } : {}),
  },
  webServer: [
    {
      command: 'pnpm --filter api exec tsx scripts/e2e-reset.ts && node ../apps/api/dist/src/main.js',
      url: 'http://localhost:4100/api/v1/healthz',
      reuseExistingServer: !!process.env.E2E_REUSE,
      timeout: 120_000,
      env: { NODE_ENV: 'development', PORT: '4100', DATABASE_URL: DB, ADAPTERS: 'fake', STORAGE_DIR: '/tmp/soilflow-e2e-files', PUBLIC_BASE_URL: WEB, SESSION_SECRET: 'e2e-session-secret', LOGIN_RATE_PER_MIN: '1000' },
    },
    { command: 'node serve.mjs', url: `${WEB}/login/`, reuseExistingServer: !!process.env.E2E_REUSE, env: { API_ORIGIN: 'http://localhost:4100', WEB_PORT: '3100' } },
  ],
});
