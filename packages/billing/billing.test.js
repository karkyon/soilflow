/* 請求計算の正解データとの照合（node packages/billing/billing.test.js） */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const B = require('./billing');

const root = path.join(__dirname, '..', '..', 'docs');
const golden = JSON.parse(fs.readFileSync(path.join(root, 'spec', 'billing-golden.json'), 'utf8'));
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok', name); };

for (const c of golden.cases) {
  console.log(c.id, c.title);
  if (c.id === 'G-01') {
    const m = c.masters;
    const ctx = { ...m, rows: c.rows, trips: c.trips, slips: c.slips, taxRate: c.taxRate, rounding: c.rounding };
    const { invoices, problems } = B.buildInvoices(c.month, ctx);
    ok('請求書の件数', () => assert.strictEqual(invoices.length, c.expected.invoices.length));
    c.expected.invoices.forEach((e, i) => ok(`${e.invoiceNo} ${e.billingPartyId}`, () => {
      const a = invoices[i];
      for (const k of ['invoiceNo', 'billingPartyId', 'periodFrom', 'periodTo', 'issueDate', 'dueDate', 'subtotal', 'taxAmount', 'total']) assert.strictEqual(a[k], e[k], k);
      assert.deepStrictEqual(a.tripIds, e.tripIds);
      assert.deepStrictEqual(a.lines.map(({ lineNo, siteId, itemId, vehicleClassId, unitPrice, tripCount, amount }) => ({ lineNo, siteId, itemId, vehicleClassId, unitPrice, tripCount, amount })), e.lines);
    }));
    ok('問題点（単価なし・請求書を作らない）', () => assert.deepStrictEqual(problems.map((p) => ({ kind: p.kind, ...(p.tripId ? { tripId: p.tripId } : {}), billingPartyId: p.billingPartyId })), c.expected.problems));
    const fe = c.expected.freee;
    ok('freee の明細', () => assert.deepStrictEqual(B.freeeDetails(invoices.find((x) => x.invoiceNo === fe.invoiceNo), fe.mapping).details, fe.details));
    ok('freee の明細の合計＝請求書の合計', () => {
      const inv = invoices[0]; const d = B.freeeDetails(inv, fe.mapping).details;
      assert.strictEqual(d.reduce((a, x) => a + x.amount, 0), inv.total); assert.strictEqual(d.reduce((a, x) => a + x.vat, 0), inv.taxAmount);
    });
    ok('対応付けがない品目は登録できない', () => assert.strictEqual(B.freeeDetails(invoices[0], {}).error, 'ITEM_MAPPING_MISSING'));
    ok('印の切り替え', () => {
      assert.strictEqual(B.effectiveItemId('it_hassei12', 'm_kusa', m.markRules), 'it_kusa12');
      assert.strictEqual(B.effectiveItemId('it_masa30', 'm_kusa', m.markRules), 'it_masa30');
      assert.strictEqual(B.effectiveItemId('it_hassei12', null, m.markRules), 'it_hassei12');
    });
    ok('台数（取消を除く）', () => {
      const day = c.trips.filter((t) => t.date === '2026-02-05');
      const r = B.tripCounts(c.rows, day);
      assert.strictEqual(r.total, 10); assert.strictEqual(r.byCustomer.c_kaya, 3); assert.strictEqual(r.byRow.r2, 4);
    });
  }
  if (c.id === 'G-02') {
    for (const mode of ['floor', 'round', 'ceil']) {
      ok(`税 ${mode}`, () => { assert.strictEqual(B.taxOf(c.subtotal, 10, mode), c.expected.tax[mode]); assert.strictEqual(B.taxOf(3705, 10, mode), c.expected.taxOf3705[mode]); });
    }
    const inv = { lines: c.lines, taxRate: 10, taxAmount: B.taxOf(c.subtotal, 10, 'floor') };
    ok('端数の配り方', () => assert.deepStrictEqual(B.freeeDetails(inv, c.expected.freee.mapping).details, c.expected.freee.details));
  }
  if (c.id === 'G-03') {
    c.periods.forEach((p) => ok(`期間 ${p.month} 締め${p.closingDay}`, () => assert.deepStrictEqual(B.billingPeriod(p.month, p.closingDay), { from: p.from, to: p.to })));
    c.dueDates.forEach((d) => ok(`期日 ${d.periodTo}+${d.offset}/${d.day}`, () => assert.strictEqual(B.dueDate(d.periodTo, d.offset, d.day), d.due)));
  }
  if (c.id === 'G-04') {
    ok('価格表の全セル', () => {
      const lines = fs.readFileSync(path.join(root, c.source), 'utf8').replace(/^﻿/, '').trim().split('\n');
      const head = lines[0].split(','); const cls = head.slice(4).map((h) => h.split('車')[0]);
      let checked = 0, mism = 0, feeOnly = 0;
      for (const ln of lines.slice(1)) {
        const f = ln.split(','); const perM3 = f[2] === '積込料' ? null : Number(f[2]); const add = Number(f[3] || 0);
        f.slice(4).forEach((v, i) => {
          if (perM3 === null) { feeOnly++; return; }
          checked++;
          if (B.referencePrice(perM3, c.capacities[cls[i]], c.smallVehicles.includes(cls[i]), add) !== Number(v)) mism++;
        });
      }
      assert.deepStrictEqual({ checkedCells: checked, mismatches: mism, loadingFeeOnlyCells: feeOnly }, c.expected);
    });
  }
}

/* 現金の領収書（FR-BIL-15、設計案）。正解データではなく、決まりの確認 */
{
  const pt = [{ id: 'p1', effectiveFrom: '2023-04-01', entries: [{ itemId: 'i1', vehicleClassId: 'v10', unitPrice: 8250 }, { itemId: 'i2', vehicleClassId: 'v10', unitPrice: 12100 }] }];
  ok('現金：明細と消費税（領収書ごとに1回）', () => {
    const r = B.buildCashReceipt([{ id: 'a', date: '2026-02-05', itemId: 'i1', vehicleClassId: 'v10' }, { id: 'b', date: '2026-02-05', itemId: 'i1', vehicleClassId: 'v10' }, { id: 'c', date: '2026-02-05', itemId: 'i2', vehicleClassId: 'v10' }], pt, 10, 'floor');
    assert.deepStrictEqual({ n: r.lines.length, subtotal: r.subtotal, tax: r.taxAmount, total: r.total }, { n: 2, subtotal: 28600, tax: 2860, total: 31460 });
  });
  ok('現金：単価がない便があれば作らない', () => assert.deepStrictEqual(B.buildCashReceipt([{ id: 'x', date: '2022-01-01', itemId: 'i1', vehicleClassId: 'v10' }], pt, 10, 'floor'), { error: 'PRICE_MISSING', tripIds: ['x'] }));
  ok('現金：番号と収入印紙', () => { assert.strictEqual(B.cashReceiptNo('2026-02-05', 7), 'R-2602-007'); assert.strictEqual(B.needsRevenueStamp(49999), false); assert.strictEqual(B.needsRevenueStamp(50000), true); });
  ok('現金：受け取り済みの便は締めで請求書に入れない', () => {
    const ctx = { rows: [{ id: 'r', customerId: 'c', siteId: null, itemId: 'i1', vehicleClassId: 'v10' }], slips: [], sites: [], customers: [{ id: 'c', defaultBillingPartyId: 'bp' }],
      billingParties: [{ id: 'bp', name: '現金のお客さま', kana: 'げんきん', closingDay: 0, paymentMonthOffset: 1, paymentDay: 0 }], items: [{ id: 'i1', sortOrder: 1 }], vehicleClasses: [{ id: 'v10', sortOrder: 1 }],
      priceTables: pt, markRules: [], trips: [{ id: 't1', rowId: 'r', date: '2026-02-05', time: '09:00', markId: null, status: 'ACTIVE', slipId: 's', cashReceiptId: 'cr1' }, { id: 't2', rowId: 'r', date: '2026-02-06', time: '09:00', markId: null, status: 'ACTIVE', slipId: null }] };
    const r = B.buildInvoices('2026-02', ctx);
    assert.deepStrictEqual(r.invoices.map((i) => i.tripIds), [['t2']]);
    assert.deepStrictEqual(r.problems.map((p) => p.kind), ['CASH_SETTLED']);
  });
}
console.log(`\n${passed} 件すべて一致`);
