/* 現金のお客さま（FR-BIL-15、設計案）：領収書を出した伝票の便は締めで請求書に入れない。取り消せば戻る */
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, resetDb, startApp, uuid } from './helpers';

let app: INestApplication;
let admin: Api, office: Api, reception: Api;
const d = new Date(Date.now() + 9 * 3600_000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
const MONTH = d.toISOString().slice(0, 7), DATE = `${MONTH}-10`;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await resetDb();
  app = await startApp();
  [admin, office, reception] = await Promise.all(['admin', 'office', 'reception'].map((l) => Api.login(app, l)));
  ids.vc = (await office.ok(office.post('/masters/vehicleClasses', { name: '10t', capacityM3: 5.5, smallVehicle: false, sortOrder: 1 }))).id;
  ids.item = (await office.ok(office.post('/masters/items', { reportLabel: '残土', priceItemName: '建設発生土', direction: 'RECEIVE', sortOrder: 1 }))).id;
  ids.bp = (await office.ok(office.post('/masters/billingParties', { name: '現金のお客さま', kana: 'げんきん', paymentMethod: 'CASH' }))).id;
  ids.cust = (await office.ok(office.post('/masters/customers', { name: '個人の方', kana: 'こじん', defaultBillingPartyId: ids.bp }))).id;
  const pt = await office.ok(office.post('/price-tables', { effectiveFrom: '2023-04-01' }));
  await office.ok(office.put(`/price-tables/${pt.id}/entries`, [{ itemId: ids.item, vehicleClassId: ids.vc, unitPrice: 8250 }]));
  await reception.ok(reception.get(`/daily-reports/${DATE}`));
  const row = await reception.ok(reception.post('/report-rows', { date: DATE, customerId: ids.cust, vehicleNo: '7777', itemId: ids.item, vehicleClassId: ids.vc }), 201);
  for (const time of ['09:00', '10:30', '13:15']) await reception.ok(reception.post('/trips', { date: DATE, rowIds: [row.id], time, clientOpId: uuid() }), 201);
  const slip = await reception.ok(reception.post('/slips', { date: DATE, customerId: ids.cust, siteId: null }), 201);
  ids.slip = slip.id;
});
afterAll(async () => { await app?.close(); });

describe('現金の領収書（FR-BIL-15）', () => {
  it('設定で使わない間は出せない。サイン・紙の印刷の前も出せない', async () => {
    expect((await reception.get(`/slips/${ids.slip}/cash-preview`)).body.code).toBe('INVALID_STATE');
    const st = await admin.ok(admin.get('/settings'));
    await admin.ok(admin.patch('/settings', { version: st.version, cashPaymentEnabled: true }));
    const r = await reception.get(`/slips/${ids.slip}/cash-preview`);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/サイン済・紙で印刷/);
  });

  it('紙伝票を印刷したら、受付が金額を見て領収書を出せる（1枚だけ）', async () => {
    await reception.ok(reception.post(`/slips/${ids.slip}/print-paper`));
    const pv = await reception.ok(reception.get(`/slips/${ids.slip}/cash-preview`));
    expect({ sub: pv.subtotal, tax: pv.taxAmount, total: pv.total, n: pv.tripCount, stamp: pv.revenueStamp }).toEqual({ sub: 24750, tax: 2475, total: 27225, n: 3, stamp: false });
    const rc = await reception.ok(reception.post(`/slips/${ids.slip}/cash-receipt`, {}), 201);
    expect(rc.receiptNo).toMatch(/^R-\d{4}-001$/);
    expect(rc.total).toBe(27225);
    ids.rc = rc.id;
    expect((await reception.post(`/slips/${ids.slip}/cash-receipt`, {})).body.code).toBe('INVALID_STATE');
    const slip = (await office.ok(office.get('/slips', { from: DATE, to: DATE }))).items.find((s: { id: string }) => s.id === ids.slip);
    expect(slip.paymentMethod).toBe('CASH');
    expect(slip.cashReceipt.receiptNo).toBe(rc.receiptNo);
    const list = await reception.ok(reception.get('/cash-receipts'));
    expect(list.total).toEqual({ count: 1, total: 27225 });
    const f = await reception.ok(reception.get(`/cash-receipts/${rc.id}/pdf`));
    const file = await reception.agent.get(new URL(f.url).pathname).buffer(true);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('領収書のある伝票は取り消せず、締めでは請求書に入れない', async () => {
    const s = (await office.ok(office.get('/slips', { from: DATE, to: DATE }))).items.find((x: { id: string }) => x.id === ids.slip);
    expect((await reception.post(`/slips/${ids.slip}/cancel`, { version: s.version, reason: '誤り' })).body.message).toMatch(/領収書を取り消して/);
    const pre = await office.ok(office.get('/billing/precheck', { month: MONTH }));
    expect(pre.billingParties).toHaveLength(0);
    expect(pre.problems.map((p: { kind: string }) => p.kind)).toContain('CASH_SETTLED');
  });

  it('取り消すと（本社だけ）便は請求の対象に戻り、出し直せる', async () => {
    const rc = (await office.ok(office.get('/cash-receipts'))).items[0];
    expect((await reception.post(`/cash-receipts/${rc.id}/void`, { version: rc.version, reason: '返金' })).status).toBe(403);
    const v = await office.ok(office.post(`/cash-receipts/${rc.id}/void`, { version: rc.version, reason: '返金' }));
    expect(v.status).toBe('VOIDED');
    const pre = await office.ok(office.get('/billing/precheck', { month: MONTH }));
    expect(pre.billingParties[0].tripCount).toBe(3);
    expect(pre.problems.map((p: { kind: string }) => p.kind)).toContain('CASH_UNRECEIVED');
    const again = await reception.ok(reception.post(`/slips/${ids.slip}/cash-receipt`, { addresseeName: '上様' }), 201);
    expect(again.receiptNo).toMatch(/-002$/);
    expect(again.addresseeName).toBe('上様');
  });
});
