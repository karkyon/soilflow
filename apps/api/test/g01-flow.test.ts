/* 業務の流れ（受付 → 伝票・サイン → 締め → 確認 → メール送信 → freee 登録 → 取消・再発行）を、
 * 正解データ G-01（11 計算仕様書 7章）のとおり API だけで組み立てて確かめる */
import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFreee, FREEE } from '../src/adapters/freee';
import { FakeMail, MAIL } from '../src/adapters/mail';
import { Api, resetDb, sql, startApp, uuid } from './helpers';

const golden = JSON.parse(readFileSync(join(__dirname, '../../../docs/spec/billing-golden.json'), 'utf8'));
const G = golden.cases.find((c: { id: string }) => c.id === 'G-01');

let app: INestApplication;
let admin: Api, office: Api, reception: Api, tablet: Api;
const id = new Map<string, string>(); // 正解データの ID → DB の ID
const back = new Map<string, string>();
const put = (g: string, real: string) => { id.set(g, real); back.set(real, g); };
const tripOf = new Map<string, { id: string; version: number }>();

beforeAll(async () => {
  await resetDb();
  app = await startApp();
  [admin, office, reception, tablet] = await Promise.all(['admin', 'office', 'reception', 'tablet1'].map((l) => Api.login(app, l)));
});
afterAll(async () => { await app?.close(); });

describe('マスタ（FR-MST）', () => {
  it('車格・品目・請求先・客先・現場・印・単価表を登録する', async () => {
    const m = G.masters;
    for (const v of m.vehicleClasses) put(v.id, (await office.ok(office.post('/masters/vehicleClasses', { name: v.name, capacityM3: v.capacityM3, smallVehicle: v.smallVehicle, sortOrder: v.sortOrder }))).id);
    for (const i of m.items) put(i.id, (await office.ok(office.post('/masters/items', { reportLabel: i.reportLabel, priceItemName: i.priceItemName, direction: i.direction, sortOrder: i.sortOrder }))).id);
    for (const b of m.billingParties) {
      put(b.id, (await office.ok(office.post('/masters/billingParties', { name: b.name, kana: b.kana, closingDay: b.closingDay, paymentMonthOffset: b.paymentMonthOffset, paymentDay: b.paymentDay, mailTo: [`${b.id}@example.jp`] }))).id);
    }
    for (const c of m.customers) put(c.id, (await office.ok(office.post('/masters/customers', { name: c.name, kana: c.name, defaultBillingPartyId: id.get(c.defaultBillingPartyId) }))).id);
    for (const s of m.sites) put(s.id, (await office.ok(office.post('/masters/sites', { customerId: id.get(s.customerId), name: s.name, kana: s.kana, defaultBillingPartyId: s.defaultBillingPartyId ? id.get(s.defaultBillingPartyId) : null }))).id);
    const marks: Record<string, string[]> = {};
    for (const r of m.markRules) (marks[r.markId] ??= []).push(JSON.stringify({ fromItemId: id.get(r.fromItemId), toItemId: id.get(r.toItemId) }));
    let k = 1;
    for (const [mid, rules] of Object.entries(marks)) {
      const sym = mid === 'm_kusa' ? '草' : '○';
      put(mid, (await office.ok(office.post('/masters/marks', { symbol: sym, displayName: sym === '草' ? '草根' : '泥', color: '#2c6e3f', sortOrder: k++, rules: rules.map((x) => JSON.parse(x)) }))).id);
    }
    for (const t of m.priceTables) {
      const pt = await office.ok(office.post('/price-tables', { effectiveFrom: t.effectiveFrom, note: t.id }));
      await office.ok(office.put(`/price-tables/${pt.id}/entries`, t.entries.map((e: { itemId: string; vehicleClassId: string; unitPrice: number }) => ({ itemId: id.get(e.itemId), vehicleClassId: id.get(e.vehicleClassId), unitPrice: e.unitPrice }))));
    }
    const tables = await office.ok(office.get('/price-tables'));
    expect(tables).toHaveLength(2);
    // 受付には金額・freee の項目を返さない（FR-RCV-20）
    const items = await reception.ok(reception.get('/masters/items'));
    expect(items[0]).not.toHaveProperty('pricePerM3Ref');
    expect(Object.keys(items[0]).some((x: string) => x.startsWith('freee'))).toBe(false);
    expect((await reception.post('/masters/items', { reportLabel: 'x', priceItemName: 'x', direction: 'RECEIVE', sortOrder: 1 })).status).toBe(403);
  });
});

describe('受入日報（FR-RCV）', () => {
  it('行と便を記入し、印・取消を付ける', async () => {
    const byDay = new Map<string, string>();
    const rowFor = async (rowId: string, date: string) => {
      const key = `${rowId}:${date}`;
      if (byDay.has(key)) return byDay.get(key)!;
      const r = G.rows.find((x: { id: string }) => x.id === rowId);
      await reception.ok(reception.get(`/daily-reports/${date}`));
      const row = await reception.ok(reception.post('/report-rows', { date, customerId: id.get(r.customerId), siteId: id.get(r.siteId), vehicleNo: r.vehicleNo, itemId: id.get(r.itemId), vehicleClassId: id.get(r.vehicleClassId) }), 201);
      byDay.set(key, row.id);
      return row.id as string;
    };
    for (const t of G.trips) {
      const rowId = await rowFor(t.rowId, t.date);
      const op = uuid();
      const r = await reception.ok(reception.post('/trips', { date: t.date, rowIds: [rowId], time: t.time, clientOpId: op }), 201);
      // 同じ操作 ID の再送は二重に保存しない（NFR-01）
      const again = await reception.post('/trips', { date: t.date, rowIds: [rowId], time: t.time, clientOpId: op });
      expect(again.status).toBe(200);
      expect(again.body.trips[0].id).toBe(r.trips[0].id);
      let trip = r.trips[0];
      if (t.markId) trip = (await reception.ok(reception.patch(`/trips/${trip.id}`, { version: trip.version, markId: id.get(t.markId) })))[0];
      if (t.status === 'CANCELLED') trip = await reception.ok(reception.post(`/trips/${trip.id}/cancel`, { version: trip.version, reason: '記入の誤り' }));
      tripOf.set(t.id, { id: trip.id, version: trip.version });
      put(t.id, trip.id);
    }
    const rep = await reception.ok(reception.get('/daily-reports/2026-02-05'));
    expect(rep.counts.total).toBe(G.trips.filter((t: { date: string; status: string }) => t.date === '2026-02-05' && t.status === 'ACTIVE').length);
    const kusa = rep.trips.find((x: { id: string }) => x.id === id.get('t08'));
    expect(kusa.effectiveItemId).toBe(id.get('it_kusa12')); // 印で品目が切り替わる（11 3.1）
    expect(rep.trips[0]).not.toHaveProperty('unitPrice');
    // 変更分の取得（FR-RCV-17）
    const ch = await reception.ok(reception.get('/daily-reports/2026-02-05/changes', { since: rep.cursor }));
    expect(ch.counts.total).toBe(rep.counts.total);
  });

  it('今より後の時間帯・今日より後の日には記入できない', async () => {
    const r = await reception.post('/trips', { date: '2099-01-01', rowIds: [uuid()], time: '09:00', clientOpId: uuid() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('FUTURE_TIME');
  });

  it('有効な便がある行は削除できない', async () => {
    const [row] = await sql<{ id: string }>(`SELECT report_row_id AS id FROM trips WHERE id = $1`, [id.get('t01')]);
    const r = await reception.delete(`/report-rows/${row.id}`);
    expect(r.body.code).toBe('ROW_HAS_TRIPS');
  });
});

describe('伝票とサイン（FR-SLP・FR-SGN）', () => {
  it('請求先を選び直した伝票（ケースD）をタブレットでサインし、取消した伝票（sl3）の請求先は使わない', async () => {
    for (const s of G.slips) {
      const trips = G.trips.filter((t: { slipId: string }) => t.slipId === s.id);
      const t0 = trips[0]; const row = G.rows.find((r: { id: string }) => r.id === t0.rowId);
      const slip = await reception.ok(reception.post('/slips', { date: t0.date, customerId: id.get(row.customerId), siteId: id.get(row.siteId), tripIds: trips.map((t: { id: string }) => id.get(t.id)), billingPartyId: id.get(s.billingPartyId), billingChangeReason: '元請へ請求' }), 201);
      expect(slip.billingPartyChanged).toBe(true);
      expect(slip.slipNo).toMatch(/^\d{8}-\d{3}$/);
      if (s.status === 'SIGNED') {
        const sent = await reception.ok(reception.post(`/slips/${slip.id}/send-to-terminal`, {}));
        expect(sent.status).toBe('AWAITING_SIGNATURE');
        // 伝票に含まれる便は変えられない（FR-RCV-14）
        const tr = tripOf.get(trips[0].id)!;
        const locked = await reception.patch(`/trips/${tr.id}`, { version: (await sql<{ version: number }>('SELECT version FROM trips WHERE id = $1', [tr.id]))[0].version, time: '10:00' });
        expect(locked.body.code).toBe('TRIP_LOCKED_BY_SLIP');
        const cur = await tablet.ok(tablet.get('/terminal/current-slip'));
        expect(cur.slip.id).toBe(slip.id);
        expect(JSON.stringify(cur)).not.toMatch(/billingParty|unitPrice|amount/); // 金額・請求先を出さない（FR-SGN-02）
        const png = makePng(600, 200);
        const signed = await tablet.ok(tablet.post(`/terminal/slips/${slip.id}/sign`, { signaturePng: png, strokeCount: 3, signerName: '運転手' }));
        expect(signed.status).toBe('SIGNED');
        const again = await tablet.post(`/terminal/slips/${slip.id}/sign`, { signaturePng: png, strokeCount: 3 });
        expect(again.status).toBe(409);
        const pdf = await reception.ok(reception.get(`/slips/${slip.id}/pdf`));
        const file = await reception.agent.get(new URL(pdf.url).pathname);
        expect(file.status).toBe(200);
        expect(file.headers['content-type']).toBe('application/pdf');
      } else {
        const c = await reception.ok(reception.post(`/slips/${slip.id}/cancel`, { version: slip.version, reason: '請求先の誤り' }));
        expect(c.status).toBe('CANCELLED');
      }
      put(s.id, slip.id);
    }
    // 受付は当日の伝票だけ（FR-SLP-12）。本社は期間で見られる
    const list = await office.ok(office.get('/slips', { from: '2026-02-01', to: '2026-02-28' }));
    expect(list.items).toHaveLength(2);
    expect(list.unslipped.length).toBeGreaterThan(0);
    // サイン端末は他の API を使えない
    expect((await tablet.get('/slips')).status).toBe(403);
  });
});

describe('締め・請求書（FR-BIL）', () => {
  let invoices: { id: string; invoiceNo: string; billingPartyId: string; version: number; status: string }[] = [];
  it('締めの前の確認で、単価なしの請求先を知らせる', async () => {
    const p = await office.ok(office.get('/billing/precheck', { month: '2026-02' }));
    const pm = p.problems.find((x: { kind: string }) => x.kind === 'PRICE_MISSING');
    expect(pm.billingPartyId).toBe(id.get('bp_new'));
    expect(pm.tripIds).toEqual([id.get('t20')]);
    expect(p.billingParties.map((b: { billingPartyId: string }) => back.get(b.billingPartyId)).sort()).toEqual(G.expected.invoices.map((i: { billingPartyId: string }) => i.billingPartyId).sort());
  });

  it('締めで正解データ G-01 と1円も違わない請求書ができる', async () => {
    const run = await office.ok(office.post('/billing/runs', { month: '2026-02' }), 201);
    expect(run.status).toBe('DONE');
    expect(run.createdInvoiceIds).toHaveLength(G.expected.invoices.length);
    for (const e of G.expected.invoices) {
      const s = (await office.ok(office.get('/invoices', { month: '2026-02' }))).items.find((x: { invoiceNo: string }) => x.invoiceNo === e.invoiceNo);
      expect(s, e.invoiceNo).toBeTruthy();
      const d = await office.ok(office.get(`/invoices/${s.id}`));
      expect(back.get(d.billingPartyId)).toBe(e.billingPartyId);
      expect([d.periodFrom, d.periodTo, d.issueDate, d.dueDate]).toEqual([e.periodFrom, e.periodTo, e.issueDate, e.dueDate]);
      expect([d.subtotal, d.taxAmount, d.total]).toEqual([e.subtotal, e.taxAmount, e.total]);
      expect(d.lines.map((l: { lineNo: number; siteId: string; itemId: string; unitPrice: number; tripCount: number; amount: number }) => ({ lineNo: l.lineNo, siteId: back.get(l.siteId), itemId: back.get(l.itemId), unitPrice: l.unitPrice, tripCount: l.tripCount, amount: l.amount })))
        .toEqual(e.lines.map((l: { lineNo: number; siteId: string; itemId: string; unitPrice: number; tripCount: number; amount: number }) => ({ lineNo: l.lineNo, siteId: l.siteId, itemId: l.itemId, unitPrice: l.unitPrice, tripCount: l.tripCount, amount: l.amount })));
      expect(d.lines.flatMap((l: { tripIds: string[] }) => l.tripIds).map((x: string) => back.get(x)).sort()).toEqual([...e.tripIds].sort());
      expect(d.hasPdf).toBe(true);
      invoices.push(d);
    }
    // 2回目の締めでは二重に作らない
    const again = await office.ok(office.post('/billing/runs', { month: '2026-02' }), 201);
    expect(again.createdInvoiceIds).toHaveLength(0);
  });

  it('含まれる便が変わると要再確認になり、作り直すと元に戻る', async () => {
    const inv = invoices.find((i) => back.get(i.billingPartyId) === 'bp_sanko')!;
    const t = tripOf.get('t19')!;
    const v = (await sql<{ version: number }>('SELECT version FROM trips WHERE id = $1', [t.id]))[0].version;
    await office.ok(office.post(`/trips/${t.id}/cancel`, { version: v, reason: '試験' }));
    let d = await office.ok(office.get(`/invoices/${inv.id}`));
    expect(d.status).toBe('NEEDS_RECHECK');
    expect((await office.post(`/invoices/${inv.id}/confirm`, { version: d.version })).body.code).toBe('INVALID_STATE');
    d = await office.ok(office.post(`/invoices/${inv.id}/rebuild`, { version: d.version }));
    expect(d.status).toBe('DRAFT');
    expect(d.subtotal).toBe(52800 - 8250);
    expect(d.invoiceNo).toBe(inv.invoiceNo); // 番号は変えない
    invoices = invoices.map((x) => (x.id === inv.id ? d : x));
  });

  it('確認済にしてメールで送ると送信済になり、送信済の請求書は変えられない', async () => {
    for (const inv of invoices) {
      const cur = await office.ok(office.get(`/invoices/${inv.id}`));
      await office.ok(office.post(`/invoices/${inv.id}/confirm`, { version: cur.version }));
    }
    const pv = await office.ok(office.post('/invoices/mail-preview', { invoiceIds: invoices.map((i) => i.id) }));
    expect(pv.items[0].subject).toContain('2026年2月分 ご請求書');
    expect(pv.items[0].attachmentName).toMatch(/^請求書_.+_202602\.pdf$/);
    const r = await office.ok(office.post('/invoices/send', { invoiceIds: invoices.map((i) => i.id) }));
    expect(r.results.every((x: { status: string }) => x.status === 'SENT')).toBe(true);
    const mail = app.get<FakeMail>(MAIL);
    expect(mail.outbox.length).toBeGreaterThanOrEqual(invoices.length);
    expect(mail.outbox.at(-1)!.attachments![0].content.subarray(0, 5).toString()).toBe('%PDF-');
    const d = await office.ok(office.get(`/invoices/${invoices[0].id}`));
    expect(d.status).toBe('SENT');
    expect((await office.patch(`/invoices/${d.id}`, { version: d.version, issueDate: '2026-02-27' })).body.code).toBe('INVOICE_FROZEN');
    // DB のトリガーでも守る（07 5章）
    await expect(sql('UPDATE invoices SET total = total + 1, subtotal = subtotal + 1 WHERE id = $1', [d.id])).rejects.toThrow(/SF_INVOICE_FROZEN/);
    // 送信済の請求書に含まれる便は変えられない
    const t = tripOf.get('t08')!;
    const v = (await sql<{ version: number }>('SELECT version FROM trips WHERE id = $1', [t.id]))[0].version;
    expect((await reception.patch(`/trips/${t.id}`, { version: v, markId: null })).body.code).toBe('TRIP_LOCKED_BY_INVOICE');
    // freee 未連携なので登録は PENDING（09 4.2）
    const regs = await office.ok(office.get('/freee/registrations'));
    expect(regs.counts.PENDING).toBe(invoices.length);
  });

  it('メールの不達（webhook）で送信エラーになる', async () => {
    const [log] = await sql<{ id: string; invoice_id: string }>(`SELECT id, invoice_id FROM mail_logs WHERE invoice_id = $1`, [invoices[1].id]);
    const r = await office.agent.post('/api/v1/webhooks/mail-events').set('Content-Type', 'application/json').send(JSON.stringify([{ event: 'bounce', mail_log_id: log.id, email: 'x@example.jp', reason: '550 no such user' }]));
    expect(r.status).toBe(204);
    expect((await office.ok(office.get(`/invoices/${log.invoice_id}`))).status).toBe('SEND_ERROR');
    const re = await office.ok(office.post(`/invoices/${log.invoice_id}/resend`, { to: ['fixed@example.jp'] }));
    expect(re.status).toBe('SENT');
    expect((await office.ok(office.get(`/invoices/${log.invoice_id}`))).status).toBe('SENT');
    expect(await office.ok(office.get(`/invoices/${log.invoice_id}/mail-logs`))).toHaveLength(2);
  });

  describe('freee 会計連携（FR-FRE）', () => {
    it('連携し、取引先・品目を対応付けると、正解データの明細で freee に登録される', async () => {
      const fake = app.get<FakeFreee>(FREEE);
      const { authorizeUrl } = await admin.ok(admin.post('/freee/connection/authorize'));
      const state = new URL(authorizeUrl).searchParams.get('state');
      const cb = await admin.get('/freee/oauth/callback', { code: 'ok', state });
      expect(cb.status, JSON.stringify(cb.body)).toBe(302);
      expect(cb.headers.location).toContain('result=ok');
      const conn = await admin.ok(admin.get('/freee/connection'));
      expect(conn.status).toBe('CONNECTED');
      expect(JSON.stringify(conn)).not.toMatch(/token/i);
      const maps = await admin.ok(admin.post('/freee/partner-mappings/auto-match'));
      expect(maps.find((m: { billingPartyId: string }) => m.billingPartyId === id.get('bp_itoshima')).status).toBe('AUTO');
      for (const m of maps.filter((x: { status: string }) => x.status !== 'AUTO' && x.status !== 'MANUAL')) {
        await admin.ok(admin.post('/freee/partners', { billingPartyId: m.billingPartyId }), 201);
      }
      // 取引先は済んだが、品目の勘定科目がまだなので要対応（09 4.2）
      const regs0 = await office.ok(office.get('/freee/registrations'));
      expect(regs0.items.every((r: { status: string; reasons: { code: string }[] }) => r.status === 'NEEDS_ACTION' && r.reasons.every((x) => x.code === 'ITEM_UNMAPPED'))).toBe(true);
      const mapping = G.expected.freee.mapping;
      for (const it of G.masters.items) {
        const mp = mapping[it.id] ?? { accountItemId: 101, taxCode: 129, freeeItemId: 1003 };
        await admin.ok(admin.put(`/items/${id.get(it.id)}/freee-mapping`, mp));
      }
      const regs = await office.ok(office.get('/freee/registrations'));
      expect(regs.counts.NEEDS_ACTION).toBe(0);
      expect(regs.counts.PENDING).toBe(regs.items.length); // 確認してから登録（REVIEW）
      const target = regs.items.find((r: { invoiceNo: string }) => r.invoiceNo === G.expected.freee.invoiceNo);
      const pv = await office.ok(office.get(`/freee/registrations/${target.id}/preview`));
      expect(pv.canRegister).toBe(true);
      const res = await admin.ok(admin.post('/freee/registrations/register', { registrationIds: regs.items.map((r: { id: string }) => r.id) }));
      expect(res.results.every((r: { status: string }) => r.status === 'REGISTERED')).toBe(true);
      const deal = fake.deals.find((d) => d.ref_number === G.expected.freee.invoiceNo)!;
      expect((deal.details as { account_item_id: number; tax_code: number; item_id: number; amount: number; vat: number }[]).map((d) => ({ accountItemId: d.account_item_id, taxCode: d.tax_code, itemId: d.item_id, amount: d.amount, vat: d.vat }))).toEqual(G.expected.freee.details);
      expect(fake.receipts).toHaveLength(regs.items.length);
      // やり直しても二重に登録しない（FR-FRE-15）
      expect((await admin.post(`/freee/registrations/${target.id}/retry`)).body.code).toBe('INVALID_STATE');
      expect((await office.ok(office.get('/freee/api-logs'))).length).toBeGreaterThan(0);
    });

    it('取消すると freee の取引を削除し、再発行すると元の取引を更新する（FR-FRE-18・19）', async () => {
      const fake = app.get<FakeFreee>(FREEE);
      const [a, b] = invoices;
      const da = await office.ok(office.get(`/invoices/${a.id}`));
      const dealsBefore = fake.deals.length;
      const v = await office.ok(office.post(`/invoices/${a.id}/void`, { version: da.version, reason: '数量の訂正' }));
      expect(v.status).toBe('VOIDED');
      expect(fake.deals.length).toBe(dealsBefore - 1);
      expect((await office.ok(office.get('/freee/registrations'))).counts.DELETED).toBe(1);
      // 取消した請求書の便は再び請求の対象になる
      const p = await office.ok(office.get('/billing/precheck', { month: '2026-02' }));
      expect(p.billingParties.find((x: { billingPartyId: string }) => x.billingPartyId === a.billingPartyId).existingInvoiceId).toBeNull();

      const db = await office.ok(office.get(`/invoices/${b.id}`));
      const oldDeal = fake.deals.find((d) => d.ref_number === db.invoiceNo)!;
      const n = await office.ok(office.post(`/invoices/${b.id}/reissue`, { version: db.version, reason: '宛名の訂正' }), 201);
      expect(n.replacesInvoiceId).toBe(b.id);
      expect(n.invoiceNo).not.toBe(db.invoiceNo);
      expect(n.total).toBe(db.total);
      await office.ok(office.post(`/invoices/${n.id}/confirm`, { version: n.version }));
      await office.ok(office.post('/invoices/send', { invoiceIds: [n.id] }));
      const regs = await office.ok(office.get('/freee/registrations'));
      const nr = regs.items.find((r: { invoiceId: string }) => r.invoiceId === n.id);
      expect(nr.action).toBe('UPDATE');
      if (nr.status === 'PENDING') await admin.ok(admin.post('/freee/registrations/register', { registrationIds: [nr.id] }));
      const after = await office.ok(office.get('/freee/registrations'));
      expect(after.items.find((r: { invoiceId: string }) => r.invoiceId === n.id).status).toBe('REGISTERED');
      expect(fake.deals.find((d) => d.id === oldDeal.id)!.ref_number).toBe(n.invoiceNo);
    });

    it('freee で決済済みの取引は自動で削除しない', async () => {
      const fake = app.get<FakeFreee>(FREEE);
      const c = invoices[2];
      const d = await office.ok(office.get(`/invoices/${c.id}`));
      fake.deals.find((x) => x.ref_number === d.invoiceNo)!.payments.push({ amount: d.total });
      await office.ok(office.post(`/invoices/${c.id}/void`, { version: d.version, reason: '試験' }));
      const r = (await office.ok(office.get('/freee/registrations'))).items.find((x: { invoiceId: string }) => x.invoiceId === c.id);
      expect(r.status).toBe('NEEDS_ACTION');
      expect(r.reasons[0].code).toBe('FREEE_DEAL_SETTLED');
    });

    it('鍵の更新に失敗すると再連携が必要になる', async () => {
      const fake = app.get<FakeFreee>(FREEE);
      fake.revokeAll();
      await sql(`UPDATE freee_connection SET access_token_expires_at = now() - interval '1 hour'`);
      expect((await admin.get('/freee/partners')).body.code).toBe('FREEE_NOT_CONNECTED');
      expect((await admin.ok(admin.get('/freee/connection'))).status).toBe('REAUTH_REQUIRED');
      const dash = await office.ok(office.get('/dashboard'));
      expect(dash.alerts.some((a: { code: string }) => a.code === 'FREEE_REAUTH_REQUIRED')).toBe(true);
    });
  });

  it('集計（FR-AGG-03）と出力（CSV・Excel）', async () => {
    const a = await office.ok(office.get('/aggregates', { from: '2026-02-01', to: '2026-02-28', groupBy: 'billingParty' }));
    expect(a.total.priceMissingCount).toBe(1);
    expect(a.rows.find((r: { keys: { billingParty: string } }) => r.keys.billingParty === id.get('bp_itoshima')).amount).toBe(68750);
    const csv = await office.ok(office.get('/aggregates/export', { from: '2026-02-01', to: '2026-02-28', format: 'csv' }));
    const f = await office.agent.get(new URL(csv.url).pathname);
    expect(f.text.charCodeAt(0)).toBe(0xfeff);
    expect(f.text).toContain('合計');
    const x = await office.ok(office.get('/aggregates/export', { from: '2026-02-01', to: '2026-02-28', format: 'xlsx', groupBy: 'customer,item' }));
    expect(x.fileName).toBe('集計_20260201-20260228.xlsx');
  });

  it('操作履歴に残り、書き換えられない（FR-CMN-04）', async () => {
    const logs = await office.ok(office.get('/audit-logs', { targetType: 'invoice' }));
    expect(logs.total).toBeGreaterThan(5);
    await expect(sql('UPDATE audit_logs SET summary = $1', ['x'])).rejects.toThrow(/SF_AUDIT_APPEND_ONLY/);
  });
});

/** 単色の PNG（IHDR の大きさだけ正しければよい） */
function makePng(w: number, h: number) {
  const zlib = require('node:zlib');
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
