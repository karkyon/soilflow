/* SoilFlow 請求計算（11 計算仕様書の実装）
 * 画面・DB・API から独立した純粋な関数だけで構成する。
 * Node（require）とブラウザ（window.SFBilling）の両方で同じコードを使う。
 * 金額はすべて整数（円）。日付は 'YYYY-MM-DD' の文字列で扱い、タイムゾーンに依存させない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFBilling = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 日付 ---------- */
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
  const parseYm = (ym) => { const [y, m] = ym.split('-').map(Number); return { y, m }; };
  const addMonths = (y, m, k) => { const t = y * 12 + (m - 1) + k; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; };

  /** 締め日 closingDay（0＝月末、1〜28）の、対象月 ym の請求期間 [from, to]（11 計算仕様書 4.1） */
  function billingPeriod(ym, closingDay) {
    const { y, m } = parseYm(ym);
    const dayOf = (yy, mm) => (closingDay === 0 ? lastDay(yy, mm) : Math.min(closingDay, lastDay(yy, mm)));
    const to = ymd(y, m, dayOf(y, m));
    const p = addMonths(y, m, -1);
    const prevTo = dayOf(p.y, p.m);
    const from = prevTo === lastDay(p.y, p.m) ? ymd(y, m, 1) : ymd(p.y, p.m, prevTo + 1);
    return { from, to };
  }

  /** 入金期日：締め日の月から offsetMonths か月後の payDay（0＝末日）。その月にない日は末日（4.3） */
  function dueDate(periodTo, offsetMonths, payDay) {
    const { y, m } = parseYm(periodTo.slice(0, 7));
    const t = addMonths(y, m, offsetMonths);
    const ld = lastDay(t.y, t.m);
    return ymd(t.y, t.m, payDay === 0 ? ld : Math.min(payDay, ld));
  }

  /* ---------- 便の品目・単価・請求先 ---------- */

  /** 便の品目＝印の切り替え規則（印×行の品目）があれば切り替え先、なければ行の品目（3.1） */
  function effectiveItemId(rowItemId, markId, markRules) {
    if (!markId) return rowItemId;
    const r = markRules.find((x) => x.markId === markId && x.fromItemId === rowItemId);
    return r ? r.toItemId : rowItemId;
  }

  /** 便の日付に適用される単価表：適用開始日が便の日付以前で最も新しいもの（3.2） */
  function priceTableFor(date, priceTables) {
    let best = null;
    for (const t of priceTables) if (t.effectiveFrom <= date && (!best || t.effectiveFrom > best.effectiveFrom)) best = t;
    return best;
  }

  /** 単価（1台・税抜）。見つからなければ null */
  function unitPrice(date, itemId, vehicleClassId, priceTables) {
    const t = priceTableFor(date, priceTables);
    if (!t) return null;
    const e = t.entries.find((x) => x.itemId === itemId && x.vehicleClassId === vehicleClassId);
    return e && Number.isInteger(e.unitPrice) ? e.unitPrice : null;
  }

  /** 参考値：㎥単価×容量（＋4t車以下の積込料加算）。価格表の照合に使う（3.3） */
  function referencePrice(pricePerM3, capacityM3, smallVehicle, smallLoadingFee) {
    if (pricePerM3 == null) return null;
    return Math.round(pricePerM3 * capacityM3) + (smallVehicle ? smallLoadingFee || 0 : 0);
  }

  const SLIP_EFFECTIVE = new Set(['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED', 'PAPER_PRINTED', 'PAPER_SIGNED']);

  /** 便の請求先：①伝票（取消以外）の請求先 ②現場の既定 ③客先の既定（3.4） */
  function billingPartyIdFor(trip, row, ctx) {
    if (trip.slipId) {
      const s = ctx.slips.find((x) => x.id === trip.slipId);
      if (s && SLIP_EFFECTIVE.has(s.status) && s.billingPartyId) return s.billingPartyId;
    }
    const site = row.siteId ? ctx.sites.find((x) => x.id === row.siteId) : null;
    if (site && site.defaultBillingPartyId) return site.defaultBillingPartyId;
    const c = ctx.customers.find((x) => x.id === row.customerId);
    return c ? c.defaultBillingPartyId : null;
  }

  /* ---------- 消費税 ---------- */

  /** 税率 ratePercent（整数）の税額。端数処理 mode：floor（切り捨て）／round（四捨五入）／ceil（切り上げ）（4.5） */
  function taxOf(subtotal, ratePercent, mode) {
    const n = subtotal * ratePercent; // 100倍の税額（整数）
    if (mode === 'ceil') return Math.ceil(n / 100);
    if (mode === 'round') return Math.floor((n + 50) / 100);
    return Math.floor(n / 100);
  }

  const invoiceNo = (periodTo, seq) => `SF-${periodTo.slice(2, 4)}${periodTo.slice(5, 7)}-${pad(seq, 3)}`;

  /* ---------- 請求書の作成 ---------- */

  /**
   * 対象月 ym の締めで請求書を作る（4章）。
   * ctx: { rows, trips, slips, sites, customers, billingParties, items, vehicleClasses, priceTables, markRules,
   *        taxRate=10, rounding='floor', billingPartyIds?（対象を絞る場合）, seqStart=1 }
   * trips の各要素：{ id, rowId, date, time, markId, status: 'ACTIVE'|'CANCELLED', slipId, lockedInvoiceId? }
   * 戻り値：{ invoices, problems }
   */
  function buildInvoices(ym, ctx) {
    const taxRate = ctx.taxRate ?? 10, rounding = ctx.rounding || 'floor';
    const byId = (arr) => new Map(arr.map((x) => [x.id, x]));
    const rows = byId(ctx.rows), items = byId(ctx.items), vcs = byId(ctx.vehicleClasses), sites = byId(ctx.sites), bps = byId(ctx.billingParties);
    const target = ctx.billingParties.filter((b) => b.active !== false && (!ctx.billingPartyIds || ctx.billingPartyIds.includes(b.id)));
    const periods = new Map(target.map((b) => [b.id, billingPeriod(ym, b.closingDay)]));
    const problems = [];
    const buckets = new Map(); // bpId -> Map(key -> line)
    const tripIdsOf = new Map();
    const blocked = new Set();

    for (const t of ctx.trips) {
      if (t.status !== 'ACTIVE') continue;
      const row = rows.get(t.rowId);
      if (!row) { problems.push({ kind: 'ROW_MISSING', tripId: t.id }); continue; }
      const bpId = billingPartyIdFor(t, row, ctx);
      if (!bpId) { problems.push({ kind: 'BILLING_PARTY_MISSING', tripId: t.id, date: t.date }); continue; }
      const per = periods.get(bpId);
      if (!per || t.date < per.from || t.date > per.to) continue;
      if (t.lockedInvoiceId) { problems.push({ kind: 'ALREADY_INVOICED', tripId: t.id, billingPartyId: bpId, invoiceId: t.lockedInvoiceId }); continue; }
      const itemId = effectiveItemId(row.itemId, t.markId, ctx.markRules);
      const price = unitPrice(t.date, itemId, row.vehicleClassId, ctx.priceTables);
      if (price === null) {
        problems.push({ kind: 'PRICE_MISSING', tripId: t.id, billingPartyId: bpId, date: t.date, itemId, vehicleClassId: row.vehicleClassId });
        blocked.add(bpId); continue;
      }
      const key = [row.siteId || '', itemId, row.vehicleClassId, price].join('|');
      if (!buckets.has(bpId)) { buckets.set(bpId, new Map()); tripIdsOf.set(bpId, []); }
      const b = buckets.get(bpId);
      if (!b.has(key)) b.set(key, { siteId: row.siteId || null, itemId, vehicleClassId: row.vehicleClassId, unitPrice: price, tripCount: 0, amount: 0 });
      const ln = b.get(key); ln.tripCount += 1; ln.amount += price;
      tripIdsOf.get(bpId).push(t.id);
    }

    const kanaOf = (bp) => bp.kana || bp.name;
    const order = [...buckets.keys()].filter((id) => !blocked.has(id)).sort((a, b) => kanaOf(bps.get(a)).localeCompare(kanaOf(bps.get(b)), 'ja') || (a < b ? -1 : 1));
    const seqByMonth = {};
    const invoices = order.map((bpId) => {
      const bp = bps.get(bpId), per = periods.get(bpId);
      const siteKey = (id) => { const s = id && sites.get(id); return s ? (s.kana || s.name) : ''; };
      const lines = [...buckets.get(bpId).values()].sort((x, y) =>
        siteKey(x.siteId).localeCompare(siteKey(y.siteId), 'ja') ||
        (items.get(x.itemId).sortOrder - items.get(y.itemId).sortOrder) ||
        (vcs.get(x.vehicleClassId).sortOrder - vcs.get(y.vehicleClassId).sortOrder) ||
        (x.unitPrice - y.unitPrice));
      lines.forEach((l, i) => { l.lineNo = i + 1; });
      const subtotal = lines.reduce((a, l) => a + l.amount, 0);
      const taxAmount = taxOf(subtotal, taxRate, rounding);
      const ymKey = per.to.slice(0, 7);
      seqByMonth[ymKey] = (seqByMonth[ymKey] ?? (ctx.seqStart || 1) - 1) + 1;
      return {
        invoiceNo: invoiceNo(per.to, seqByMonth[ymKey]), billingPartyId: bpId, periodFrom: per.from, periodTo: per.to,
        issueDate: per.to, dueDate: dueDate(per.to, bp.paymentMonthOffset ?? 1, bp.paymentDay ?? 0),
        lines, subtotal, taxRate, taxAmount, total: subtotal + taxAmount, tripIds: tripIdsOf.get(bpId).slice().sort(),
      };
    });
    for (const id of blocked) problems.push({ kind: 'INVOICE_BLOCKED', billingPartyId: id });
    return { invoices, problems };
  }

  /* ---------- freee の取引の明細（5章） ---------- */

  /**
   * 請求書の明細を freee の「勘定科目×税区分×品目」でまとめ、税込金額（amount）と消費税額（vat）を返す。
   * Σvat ＝ 請求書の消費税額、Σamount ＝ 請求書の合計 になるよう、端数の差を金額の大きい明細から1円ずつ配る。
   * mapping: itemId -> { accountItemId, taxCode, freeeItemId|null }。未設定があれば { error } を返す。
   */
  function freeeDetails(invoice, mapping, rounding) {
    const groups = new Map(), missing = [];
    for (const l of invoice.lines) {
      const m = mapping[l.itemId];
      if (!m || !m.accountItemId || m.taxCode == null) { missing.push(l.itemId); continue; }
      const key = [m.accountItemId, m.taxCode, m.freeeItemId ?? ''].join('|');
      if (!groups.has(key)) groups.set(key, { accountItemId: m.accountItemId, taxCode: m.taxCode, freeeItemId: m.freeeItemId ?? null, subtotal: 0, firstLine: l.lineNo });
      groups.get(key).subtotal += l.amount;
    }
    if (missing.length) return { error: 'ITEM_MAPPING_MISSING', itemIds: [...new Set(missing)] };
    const list = [...groups.values()].sort((a, b) => a.firstLine - b.firstLine);
    if (list.length > 100) return { error: 'TOO_MANY_DETAILS', count: list.length };
    list.forEach((g) => { g.vat = taxOf(g.subtotal, invoice.taxRate, rounding || 'floor'); });
    let diff = invoice.taxAmount - list.reduce((a, g) => a + g.vat, 0);
    const prio = list.map((g, i) => ({ g, i })).sort((a, b) => b.g.subtotal - a.g.subtotal || a.i - b.i);
    for (let k = 0; diff !== 0; k = (k + 1) % prio.length) { const s = Math.sign(diff); prio[k].g.vat += s; diff -= s; }
    return { details: list.map((g) => ({ accountItemId: g.accountItemId, taxCode: g.taxCode, itemId: g.freeeItemId, amount: g.subtotal + g.vat, vat: g.vat })) };
  }

  /* ---------- 日報の台数 ---------- */

  /** 行ごと・客先ごと・日計の台数（取消を除く）（2章） */
  function tripCounts(rows, trips) {
    const byRow = {}, byCustomer = {}; let total = 0;
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const t of trips) {
      if (t.status !== 'ACTIVE') continue;
      const r = rowMap.get(t.rowId); if (!r) continue;
      byRow[r.id] = (byRow[r.id] || 0) + 1;
      byCustomer[r.customerId] = (byCustomer[r.customerId] || 0) + 1;
      total += 1;
    }
    return { byRow, byCustomer, total };
  }

  /** 時刻 'HH:MM' の時間帯の列（範囲外は端の列にまとめる）（2.2） */
  function hourSlot(time, firstHour, lastHour) {
    const h = Number(time.slice(0, 2));
    return Math.min(Math.max(h, firstHour), lastHour);
  }

  return { billingPeriod, dueDate, effectiveItemId, priceTableFor, unitPrice, referencePrice, billingPartyIdFor, taxOf, invoiceNo, buildInvoices, freeeDetails, tripCounts, hourSlot };
});
