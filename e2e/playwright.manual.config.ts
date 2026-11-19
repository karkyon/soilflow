/* 操作マニュアルの画面写真（docs/manual/img）を撮る。E2E と同じ環境（にせものの freee・メール）
 *   pnpm --filter e2e manual */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({ ...base, testDir: './manual', timeout: 120_000, reporter: 'list', use: { ...base.use, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } });
