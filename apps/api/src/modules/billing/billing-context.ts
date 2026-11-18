/* packages/billing（11 計算仕様書）に渡す入力を DB から作る。計算そのものは packages/billing だけで行う（14 4章 No.2） */
import { BillingContext, BInvoice, billingPeriod, unitPrice } from '@soilflow/billing';
import { addDays, hhmm, ymd } from '../../common/dates';
import { Tx, PrismaService } from '../../common/prisma.service';

export interface LoadedContext extends BillingContext {
  /** 便 → 保存されている便の品目（印で切り替えた後） */
  effectiveOf: Map<string, string>;
  rowOf: Map<string, { siteId: string | null; vehicleClassId: string; customerId: string }>;
}

/**
 * [from, to] の便と、計算に必要なマスタを読む。
 * 便の品目は保存されている trips.effective_item_id を使う（伝票・請求書でロックされた便は、規則を変えても前の品目のまま）。
 * そのため、便ごとの切り替え規則を作って billing.js に渡す。
 */
export async function loadContext(db: Tx | PrismaService, from: string, to: string, o: { excludeInvoiceId?: string } = {}): Promise<LoadedContext> {
  const trips = await db.$queryRaw<{ id: string; report_row_id: string; trip_date: Date; trip_time: Date; status: 'ACTIVE' | 'CANCELLED'; slip_id: string | null; invoice_id: string | null; inv_status: string | null; effective_item_id: string }[]>`
    SELECT t.id, t.report_row_id, t.trip_date, t.trip_time, t.status, t.slip_id, t.invoice_id, i.status AS inv_status, t.effective_item_id
    FROM trips t LEFT JOIN invoices i ON i.id = t.invoice_id
    WHERE t.trip_date BETWEEN ${from}::date AND ${to}::date AND t.status = 'ACTIVE'`;
  const rowIds = [...new Set(trips.map((t) => t.report_row_id))];
  const slipIds = [...new Set(trips.map((t) => t.slip_id).filter((x): x is string => !!x))];
  const [rows, slips, sites, customers, bps, items, vcs, tables, entries] = await Promise.all([
    db.reportRow.findMany({ where: { id: { in: rowIds } } }),
    db.slip.findMany({ where: { id: { in: slipIds } }, select: { id: true, status: true, billingPartyId: true } }),
    db.site.findMany(), db.customer.findMany(), db.billingParty.findMany(), db.item.findMany(), db.vehicleClass.findMany(),
    db.priceTable.findMany(), db.priceTableEntry.findMany(),
  ]);
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const markRules: BillingContext['markRules'] = [];
  const effectiveOf = new Map<string, string>();
  const ctxTrips = trips.map((t) => {
    const row = rowMap.get(t.report_row_id);
    effectiveOf.set(t.id, t.effective_item_id);
    let markId: string | null = null;
    if (row && row.itemId !== t.effective_item_id) { markId = `eff:${t.id}`; markRules.push({ markId, fromItemId: row.itemId, toItemId: t.effective_item_id }); }
    const locked = t.invoice_id && t.inv_status !== 'VOIDED' && t.invoice_id !== o.excludeInvoiceId ? t.invoice_id : null;
    return { id: t.id, rowId: t.report_row_id, date: ymd(t.trip_date), time: hhmm(t.trip_time), markId, status: t.status, slipId: t.slip_id, lockedInvoiceId: locked };
  });
  return {
    rows: rows.map((r) => ({ id: r.id, customerId: r.customerId, siteId: r.siteId, itemId: r.itemId, vehicleClassId: r.vehicleClassId })),
    trips: ctxTrips, slips: slips.map((s) => ({ id: s.id, status: s.status, billingPartyId: s.billingPartyId })),
    sites: sites.map((s) => ({ id: s.id, name: s.name, kana: s.kana, defaultBillingPartyId: s.defaultBillingPartyId })),
    customers: customers.map((c) => ({ id: c.id, defaultBillingPartyId: c.defaultBillingPartyId })),
    billingParties: bps.map((b) => ({ id: b.id, name: b.name, kana: b.kana, closingDay: b.closingDay, paymentMonthOffset: b.paymentMonthOffset, paymentDay: b.paymentDay, active: b.active })),
    items: items.map((i) => ({ id: i.id, sortOrder: i.sortOrder })), vehicleClasses: vcs.map((v) => ({ id: v.id, sortOrder: v.sortOrder })),
    priceTables: tables.map((p) => ({ id: p.id, effectiveFrom: ymd(p.effectiveFrom), entries: entries.filter((e) => e.priceTableId === p.id).map((e) => ({ itemId: e.itemId, vehicleClassId: e.vehicleClassId, unitPrice: e.unitPrice })) })),
    markRules, effectiveOf,
    rowOf: new Map(rows.map((r) => [r.id, { siteId: r.siteId, vehicleClassId: r.vehicleClassId, customerId: r.customerId }])),
  };
}

/** 対象月 M の締めで読む便の範囲（締め日は 1〜28・月末なので、前の月の1日〜M の末日に収まる） */
export function monthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { from: `${prev}-01`, to: billingPeriod(ym, 0).to };
}

/** 請求期間を作り直すための締め日（請求期間の終わりの日から） */
export function closingDayOf(periodTo: string) {
  return addDays(periodTo, 1).slice(8, 10) === '01' ? 0 : Number(periodTo.slice(8, 10));
}

/** 請求書の明細の行番号を便ごとに求める（invoice_trips） */
export function tripLines(inv: BInvoice, ctx: LoadedContext) {
  const key = (siteId: string | null, itemId: string, vc: string, price: number) => [siteId ?? '', itemId, vc, price].join('|');
  const lineOf = new Map(inv.lines.map((l) => [key(l.siteId, l.itemId, l.vehicleClassId, l.unitPrice), l]));
  const tripMap = new Map(ctx.trips.map((t) => [t.id, t]));
  return inv.tripIds.map((tid) => {
    const t = tripMap.get(tid)!; const row = ctx.rowOf.get(t.rowId)!; const item = ctx.effectiveOf.get(tid)!;
    const price = unitPrice(t.date, item, row.vehicleClassId, ctx.priceTables)!;
    const l = lineOf.get(key(row.siteId, item, row.vehicleClassId, price));
    if (!l) throw new Error(`明細の対応が見つからない便 ${tid}`);
    return { tripId: tid, lineNo: l.lineNo, effectiveItemId: item, unitPrice: price };
  });
}
