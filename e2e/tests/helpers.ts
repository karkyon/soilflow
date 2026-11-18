import { Browser, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD = 'e2e-correct-horse-battery';
export const state = () => JSON.parse(readFileSync(join(__dirname, '..', '.state.json'), 'utf8'));
export const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
export const lastMonth = () => { const d = new Date(jstToday()); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

export async function login(page: Page, loginId: string, landing: RegExp) {
  await page.goto('/login/');
  await page.getByLabel('ログインID').fill(loginId);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(landing);
}

/** 別のブラウザ（タブレット・本社）を開いてログインする */
export async function newUser(browser: Browser, loginId: string, landing: RegExp, viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  await login(page, loginId, landing);
  return page;
}

export const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();

/** 新しいタブで PDF（署名付き URL）が開くことを確かめる。PDF の表示がないブラウザではダウンロードになるため、要求と中身で見る */
export async function expectPdfOpened(page: Page, trigger: () => Promise<unknown>) {
  const ctx = page.context();
  const [req] = await Promise.all([ctx.waitForEvent('request', (r) => /\/api\/v1\/files\//.test(r.url())), trigger()]);
  const res = await page.request.get(req.url());
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
  for (const p of ctx.pages()) if (p !== page && p.url() !== 'about:blank' ? /\/api\/v1\/files\//.test(p.url()) : p !== page) await p.close().catch(() => undefined);
}
