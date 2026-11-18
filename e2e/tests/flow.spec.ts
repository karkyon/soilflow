/* E2E-01〜08（15 2.5）。受付 → 伝票・サイン → 紙伝票・スキャン → 締め → 確認 → メール → freee → 取消して再発行 → オフライン */
import { expect, Page, test } from '@playwright/test';
import { lastMonth, login, newUser, toast } from './helpers';

test.describe.configure({ mode: 'serial' });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
let reception: Page;

const row = (p: Page, vehicleNo: string) => p.locator('tbody tr').filter({ has: p.getByRole('button', { name: vehicleNo, exact: true }) });
const nowCell = (p: Page, vehicleNo: string) => row(p, vehicleNo).locator('td.bg-gold-pale');
const dialog = (p: Page) => p.getByRole('dialog');

test('E2E-01 受付：引き継ぎ → 行の追加 → マスのクリック → 車列 → 印', async ({ browser }) => {
  reception = await newUser(browser, 'reception', /\/reception\/$/);
  await reception.getByRole('button', { name: '前日の行を引き継ぐ' }).click();
  await toast(reception, /2 行引き継ぎました/);
  await expect(row(reception, '1234')).toBeVisible();

  await reception.getByRole('button', { name: '＋ 行を追加' }).click();
  const d = dialog(reception);
  await d.getByRole('button', { name: 'か', exact: true }).click();
  await d.getByRole('button', { name: 'かや工業' }).click();
  await d.getByLabel('現場').selectOption({ label: '北区造成' });
  await d.getByLabel('車番').fill('5678');
  await d.getByLabel('品名').selectOption({ label: '残土' });
  await d.getByLabel('車格').selectOption({ label: '10t' });
  await expect(d.getByText('日報の表示：')).toBeVisible();
  await d.getByRole('button', { name: '追加する' }).click();
  await toast(reception, '行を追加しました（かや工業 5678）');

  await nowCell(reception, '1234').click();
  await toast(reception, /を記入しました$/);
  await expect(nowCell(reception, '1234').locator('button')).toHaveCount(1);

  await reception.getByLabel('1234 を車列に選ぶ').check();
  await reception.getByLabel('5678 を車列に選ぶ').check();
  await reception.getByRole('button', { name: '選んだ 2 行に今の時刻で記入' }).click();
  await toast(reception, /（車列 2 台）/);
  await expect(reception.getByText(/本日\s*3\s*台/)).toBeVisible();

  // 車列の便に印を付けると、車列の全部に付く（FR-RCV-10）
  await nowCell(reception, '5678').locator('button').first().click();
  await dialog(reception).getByRole('button', { name: '草（草根）' }).click();
  await toast(reception, /の印を草にしました/);
  await expect(nowCell(reception, '1234').getByRole('button', { name: /草/ })).toHaveCount(1);
  await expect(nowCell(reception, '5678').getByRole('button', { name: /草/ })).toHaveCount(1);
});

test('E2E-02 伝票の発行 → タブレットでサイン → 控えの印刷が開く', async ({ browser }) => {
  await reception.getByRole('button', { name: '伝票を発行' }).click();
  const d = dialog(reception);
  await d.getByRole('button', { name: /かや工業\s*北区造成/ }).click();
  await expect(d.getByText('客先の既定で決まりました')).toBeVisible();
  await expect(d.getByLabel('請求先')).toHaveValue(/.+/);
  await d.getByRole('button', { name: 'サイン用タブレットへ送る' }).click();
  await toast(reception, /をタブレットへ送りました/);
  await reception.getByRole('link', { name: '伝票一覧' }).click();
  await expect(reception.getByText('サイン待ち')).toBeVisible();

  const tablet = await newUser(browser, 'tablet1', /\/terminal\/$/, { width: 1280, height: 800 });
  await expect(tablet.getByText('かや工業 様')).toBeVisible();
  await expect(tablet.getByText(/円/)).toHaveCount(0); // 金額は出さない（FR-SGN-02）
  const box = (await tablet.getByLabel('サインの枠').boundingBox())!;
  await tablet.mouse.move(box.x + 80, box.y + 120); await tablet.mouse.down();
  for (let i = 1; i <= 20; i++) await tablet.mouse.move(box.x + 80 + i * 25, box.y + 120 + Math.sin(i) * 40);
  await tablet.mouse.up();
  await tablet.getByRole('button', { name: '確定する' }).click();
  await expect(tablet.getByText('ありがとうございました')).toBeVisible();

  const done = dialog(reception);
  await expect(done.getByText('サインが確定しました')).toBeVisible({ timeout: 15_000 });
  const [pdf] = await Promise.all([reception.context().waitForEvent('page'), done.getByRole('button', { name: 'お客さま控えを印刷' }).click()]);
  await pdf.waitForURL(/\/api\/v1\/files\//);
  await pdf.close();
  await tablet.context().close();
});

test('E2E-03・04 請求先の選び直し（ケースD）→ 紙伝票 → 本社でスキャンの登録', async ({ browser }) => {
  await reception.getByRole('link', { name: '受入日報' }).click();
  await nowCell(reception, '2222').click();
  await toast(reception, /を記入しました$/);
  await reception.getByRole('button', { name: '伝票を発行' }).click();
  const d = dialog(reception);
  await d.getByRole('button', { name: /三幸工務店/ }).click();
  await d.getByLabel('請求先').selectOption({ label: '岡山土建' });
  await expect(d.getByText('既定から変えています')).toBeVisible();
  await d.getByLabel('変更の理由（任意）').fill('元請へ請求');
  const [paper] = await Promise.all([reception.context().waitForEvent('page'), d.getByRole('button', { name: '紙伝票で印刷' }).click()]);
  await toast(reception, /を紙伝票で印刷します/);
  await paper.waitForURL(/\/api\/v1\/files\//); await paper.close();

  const office = await newUser(browser, 'office', /\/office\/$/);
  await office.getByRole('link', { name: '伝票', exact: true }).click();
  const tr = office.locator('tbody tr').filter({ hasText: '三幸工務店' });
  await expect(tr.getByText('変更')).toBeVisible();
  await expect(tr.getByText('岡山土建')).toBeVisible();
  await tr.getByRole('button', { name: 'スキャンを登録' }).click();
  await dialog(office).locator('input[type=file]').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: PDF });
  await dialog(office).getByRole('button', { name: '登録する' }).click();
  await toast(office, 'スキャンを登録しました');
  await expect(tr.getByRole('button', { name: 'スキャンを見る' })).toBeVisible();
  // PDF でないファイルは登録できない（ST-06）
  await tr.getByRole('button', { name: 'スキャンを登録し直す' }).click();
  await dialog(office).locator('input[type=file]').setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf') });
  await dialog(office).getByRole('button', { name: '登録する' }).click();
  await expect(dialog(office).getByRole('alert')).toBeVisible();
  await office.context().close();
});

test('E2E-05 本社：締め → 確認 → メール送信 → freee の登録待ち', async ({ browser }) => {
  const office = await newUser(browser, 'office', /\/office\/$/);
  await office.getByRole('link', { name: '請求', exact: true }).click();
  const [y, m] = lastMonth().split('-');
  await expect(office.getByText(`${y}年${Number(m)}月分`)).toBeVisible();
  await office.getByRole('button', { name: '締めを実行（2 件作成）' }).click();
  await dialog(office).getByRole('button', { name: '締めを実行する' }).click();
  await toast(office, /請求書 2 件を作成しました/);
  const rows = office.locator('tbody tr').filter({ has: office.getByRole('link', { name: /\d/ }) });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'かや工業' }).getByText('作成済')).toBeVisible();

  await office.getByLabel('すべて選ぶ').check();
  await office.getByRole('button', { name: '選んだものを確認済にする' }).click();
  await toast(office, '2 件を確認済にしました');
  await expect(rows.getByText('確認済')).toHaveCount(2);
  await expect(office.getByText('PDF 作成中')).toHaveCount(0, { timeout: 30_000 });

  await office.getByLabel('すべて選ぶ').check();
  await office.getByRole('button', { name: '選んだものをメール送信' }).click();
  const md = dialog(office);
  await expect(md.getByText('宛先：kaya@example.jp')).toBeVisible();
  await md.getByRole('button', { name: '2 件を送信する' }).click();
  await toast(office, '2 件を送信しました');
  await md.getByRole('button', { name: '閉じる' }).last().click();
  await expect(rows.getByText('送信済')).toHaveCount(2);
  await expect(rows.getByText(/登録待ち|要対応/)).toHaveCount(2);
  await office.context().close();
});

test('E2E-06 管理者：freee と連携 → 要対応の対応付け → 登録', async ({ page }) => {
  await login(page, 'admin', /\/office\/$/);
  await page.goto('/office/freee/settings/');
  await page.getByRole('button', { name: 'freee と連携する' }).click();
  await expect(page).toHaveURL(/\/office\/freee\/settings\/\?result=ok/);
  await expect(page.getByText('連携中')).toBeVisible();
  await expect(page.getByText('株式会社フジモト').first()).toBeVisible();

  await page.goto('/office/freee/partners/');
  await page.getByRole('button', { name: '名前で自動照合' }).click();
  await toast(page, '名前で自動照合しました');

  await page.goto('/office/freee/items/');
  await page.getByRole('button', { name: /未設定を「売上高・課税売上10%」/ }).click();
  await page.getByRole('button', { name: /^変更した \d+ 件を保存$/ }).click();
  await toast(page, /件を対応付けました/);
  await expect(page.getByRole('button', { name: /^変更した/ })).toHaveCount(0);

  await page.goto('/office/freee/');
  await page.getByRole('button', { name: /^登録待ち/ }).click();
  const regs = page.locator('tbody tr');
  await expect(regs).toHaveCount(2);
  for (const cb of await regs.getByRole('checkbox').all()) await cb.check();
  await page.getByRole('button', { name: '選んだ 2 件を freee へ登録' }).click();
  await toast(page, '2 件を freee に登録しました');
  await page.getByRole('button', { name: /^登録済/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody tr').first().getByText(/取引 \d+/)).toBeVisible();
});

test('E2E-07 取消して再発行', async ({ page }) => {
  await login(page, 'office', /\/office\/$/);
  await page.goto('/office/billing/');
  await page.locator('tbody tr').filter({ hasText: 'かや工業' }).getByRole('link').click();
  await expect(page).toHaveURL(/\/office\/invoice\/\?id=/);
  const oldUrl = page.url();
  await page.getByRole('button', { name: '取消して再発行' }).click();
  await dialog(page).getByLabel('理由').fill('単価の誤り');
  await dialog(page).getByRole('button', { name: '再発行する' }).click();
  await toast(page, /を作りました/);
  await expect(page).not.toHaveURL(oldUrl);
  await expect(page.getByText('再発行した請求書です')).toBeVisible();
  await page.getByRole('link', { name: '元の請求書' }).click();
  await expect(page.getByText(/取消（/)).toBeVisible();
  await expect(page.getByText('単価の誤り')).toBeVisible();
});

test('E2E-08 オフラインの表示（通信を切る）', async ({ browser }) => {
  reception ??= await newUser(browser, 'reception', /\/reception\/$/);
  await reception.getByRole('link', { name: '受入日報' }).click();
  await expect(row(reception, '1234')).toBeVisible();
  await reception.context().setOffline(true);
  await expect(reception.getByText(/オフライン/).first()).toBeVisible();
  await nowCell(reception, '5678').click();
  await toast(reception, 'オフラインのため記入できません');
  await reception.context().setOffline(false);
  await expect(reception.getByText(/オンライン|接続中/).first()).toBeVisible();
});
