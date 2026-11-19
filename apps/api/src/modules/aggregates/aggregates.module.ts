/* 集計・本社の状況（FR-AGG、SCR-30・33、11 6章、10 6章 RPT-06） */
import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { billingPartyIdFor, unitPrice } from '@soilflow/billing';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Roles } from '../../common/actor';
import { hhmm, now, todayJst, ymd } from '../../common/dates';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { parse, zCsvQ, zDate, zUuid } from '../../common/validation';
import { loadContext } from '../billing/billing-context';
import { PdfService } from '../pdf/pdf.module';

const KEYS = ['date', 'customer', 'site', 'billingParty', 'item', 'vehicleClass'] as const;
type Key = (typeof KEYS)[number];
const KEY_JA: Record<Key, string> = { date: '日付', customer: '客先', site: '現場', billingParty: '請求先', item: '品目', vehicleClass: '車格' };

interface TripFact {
  id: string; date: string; time: string; customerId: string; siteId: string | null; billingPartyId: string | null; itemId: string; vehicleClassId: string;
  unitPrice: number | null; markSymbol: string | null; slipNo: string | null; invoiceNo: string | null; vehicleNo: string;
  slipId: string | null; slipStatus: string | null; hasScan: boolean; invoiceId: string | null;
}

@Injectable()
export class AggregatesService {
  constructor(private readonly prisma: PrismaService, private readonly pdf: PdfService) {}

  /** 便ごとの事実（品目・請求先・単価）。送信済の請求書に含まれる便は請求書に書き残した単価（11 6章） */
  private async facts(from: string, to: string): Promise<{ facts: TripFact[]; names: Record<Key, Map<string, string>>; order: Record<Key, Map<string, number | string>> }> {
    if (from > to) throw new AppError('VALIDATION_ERROR', '期間の始まりと終わりが逆です');
    if ((new Date(to).getTime() - new Date(from).getTime()) / 86400000 > 400) throw new AppError('VALIDATION_ERROR', '期間は1年までにしてください');
    const ctx = await loadContext(this.prisma, from, to);
    const extra = await this.prisma.$queryRaw<{ id: string; symbol: string | null; slip_id: string | null; slip_no: string | null; slip_status: string | null; has_scan: boolean; invoice_id: string | null; invoice_no: string | null; inv_status: string | null; fixed_price: number | null; vehicle_no: string }[]>`
      SELECT t.id, m.symbol, s.id AS slip_id, s.slip_no, s.status AS slip_status, (s.paper_scan_object_key IS NOT NULL) AS has_scan, i.id AS invoice_id, i.invoice_no, i.status AS inv_status, it.unit_price AS fixed_price, v.vehicle_no
      FROM trips t JOIN report_rows r ON r.id = t.report_row_id JOIN vehicles v ON v.id = r.vehicle_id
      LEFT JOIN marks m ON m.id = t.mark_id LEFT JOIN slips s ON s.id = t.slip_id LEFT JOIN invoices i ON i.id = t.invoice_id
      LEFT JOIN invoice_trips it ON it.invoice_id = t.invoice_id AND it.trip_id = t.id
      WHERE t.trip_date BETWEEN ${from}::date AND ${to}::date AND t.status = 'ACTIVE'`;
    const ex = new Map(extra.map((e) => [e.id, e]));
    const rowMap = new Map(ctx.rows.map((r) => [r.id, r]));
    const facts = ctx.trips.map((t) => {
      const row = rowMap.get(t.rowId)!; const item = ctx.effectiveOf.get(t.id)!; const e = ex.get(t.id)!;
      const fixed = e.inv_status && ['SENDING', 'SENT', 'SEND_ERROR'].includes(e.inv_status) ? e.fixed_price : null;
      return {
        id: t.id, date: t.date, time: t.time, customerId: row.customerId, siteId: row.siteId, billingPartyId: billingPartyIdFor(t, row, ctx), itemId: item, vehicleClassId: row.vehicleClassId,
        unitPrice: fixed ?? unitPrice(t.date, item, row.vehicleClassId, ctx.priceTables), markSymbol: e.symbol, slipNo: e.slip_status !== 'CANCELLED' ? e.slip_no : null, invoiceNo: e.invoice_no, vehicleNo: e.vehicle_no,
        slipId: e.slip_status !== 'CANCELLED' ? e.slip_id : null, slipStatus: e.slip_status !== 'CANCELLED' ? e.slip_status : null, hasScan: !!e.has_scan, invoiceId: e.invoice_id,
      };
    });
    const [customers, sites, bps, items, vcs] = await Promise.all([this.prisma.customer.findMany(), this.prisma.site.findMany(), this.prisma.billingParty.findMany(), this.prisma.item.findMany(), this.prisma.vehicleClass.findMany()]);
    return {
      facts,
      names: {
        date: new Map(), customer: new Map(customers.map((c) => [c.id, c.name])), site: new Map(sites.map((s) => [s.id, s.name])), billingParty: new Map(bps.map((b) => [b.id, b.name])),
        item: new Map(items.map((i) => [i.id, i.priceItemName])), vehicleClass: new Map(vcs.map((v) => [v.id, v.name])),
      },
      order: {
        date: new Map(), customer: new Map(customers.map((c) => [c.id, `${String(c.sortOrder).padStart(6, '0')}${c.kana}`])), site: new Map(sites.map((s) => [s.id, s.kana])),
        billingParty: new Map(bps.map((b) => [b.id, b.kana])), item: new Map(items.map((i) => [i.id, i.sortOrder])), vehicleClass: new Map(vcs.map((v) => [v.id, v.sortOrder])),
      },
    };
  }
  private keyOf(f: TripFact, k: Key) {
    return k === 'date' ? f.date : k === 'customer' ? f.customerId : k === 'site' ? f.siteId ?? '' : k === 'billingParty' ? f.billingPartyId ?? '' : k === 'item' ? f.itemId : f.vehicleClassId;
  }
  private group(facts: TripFact[], names: Record<Key, Map<string, string>>, order: Record<Key, Map<string, number | string>>, groupBy: Key[]) {
    const m = new Map<string, { keys: Record<string, string>; labels: Record<string, string>; tripCount: number; amount: number; priceMissingCount: number }>();
    for (const f of facts) {
      const ks = groupBy.map((k) => this.keyOf(f, k));
      const id = ks.join('|');
      if (!m.has(id)) m.set(id, { keys: Object.fromEntries(groupBy.map((k, i) => [k, ks[i]])), labels: Object.fromEntries(groupBy.map((k, i) => [k, k === 'date' ? ks[i] : ks[i] ? names[k].get(ks[i]) ?? ks[i] : k === 'site' ? '（現場なし）' : '（不明）'])), tripCount: 0, amount: 0, priceMissingCount: 0 });
      const g = m.get(id)!;
      g.tripCount++;
      if (f.unitPrice === null) g.priceMissingCount++; else g.amount += f.unitPrice;
    }
    const cmp = (a: string | number | undefined, b: string | number | undefined) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), 'ja'));
    const rows = [...m.values()].sort((a, b) => { for (const k of groupBy) { const c = k === 'date' ? cmp(a.keys[k], b.keys[k]) : cmp(order[k].get(a.keys[k]), order[k].get(b.keys[k])); if (c) return c; } return 0; });
    const total = rows.reduce((t, r) => ({ tripCount: t.tripCount + r.tripCount, amount: t.amount + r.amount, priceMissingCount: t.priceMissingCount + r.priceMissingCount }), { tripCount: 0, amount: 0, priceMissingCount: 0 });
    return { rows, total };
  }
  /** 集計の1行に入った便（FR-AGG-04）。日報・伝票・サイン・請求書へたどる。キーは集計の keys と同じ（現場なしは空） */
  async trips(query: Record<string, unknown>) {
    const q = parse(z.object({
      from: zDate, to: zDate, customerId: zUuid.optional(), billingPartyId: zUuid.optional(),
      date: zDate.optional(), customer: zUuid.optional(), site: z.union([zUuid, z.literal('')]).optional(), billingParty: z.union([zUuid, z.literal('')]).optional(), item: zUuid.optional(), vehicleClass: zUuid.optional(),
    }), query);
    const { facts, names } = await this.facts(q.from, q.to);
    const want: Partial<Record<Key, string>> = { date: q.date, customer: q.customer ?? q.customerId, site: q.site, billingParty: q.billingParty ?? q.billingPartyId, item: q.item, vehicleClass: q.vehicleClass };
    const hit = facts.filter((f) => KEYS.every((k) => want[k] === undefined || this.keyOf(f, k) === want[k])).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    const MAX = 2000;
    return {
      total: hit.length, truncated: hit.length > MAX,
      items: hit.slice(0, MAX).map((f) => ({
        id: f.id, date: f.date, time: f.time, customerName: names.customer.get(f.customerId) ?? '', siteName: f.siteId ? names.site.get(f.siteId) ?? null : null, vehicleNo: f.vehicleNo,
        itemName: names.item.get(f.itemId) ?? '', vehicleClassName: names.vehicleClass.get(f.vehicleClassId) ?? '', markSymbol: f.markSymbol, unitPrice: f.unitPrice,
        billingPartyName: f.billingPartyId ? names.billingParty.get(f.billingPartyId) ?? null : null,
        slipId: f.slipId, slipNo: f.slipNo, slipStatus: f.slipStatus, hasScan: f.hasScan, invoiceId: f.invoiceId, invoiceNo: f.invoiceNo,
      })),
    };
  }
  private query(q: Record<string, unknown>) {
    return parse(z.object({
      from: zDate, to: zDate, groupBy: zCsvQ(z.enum(KEYS)).pipe(z.array(z.enum(KEYS)).min(1).max(3)).optional(), customerId: zUuid.optional(), billingPartyId: zUuid.optional(), format: z.enum(['csv', 'xlsx']).optional(),
    }), q);
  }
  async aggregate(query: Record<string, unknown>) {
    const q = this.query(query);
    if (!q.groupBy) throw new AppError('VALIDATION_ERROR', 'groupBy が必要です');
    const { facts, names, order } = await this.facts(q.from, q.to);
    const r = this.group(facts.filter((f) => (!q.customerId || f.customerId === q.customerId) && (!q.billingPartyId || f.billingPartyId === q.billingPartyId)), names, order, q.groupBy);
    if (r.rows.length > 1000) throw new AppError('VALIDATION_ERROR', '集計の行が多すぎます（1,000行まで）。期間を短くするか、まとめ方を変えてください');
    return r;
  }

  /* ---------------------------------------------------------------- 出力（RPT-06） */
  async export(query: Record<string, unknown>) {
    const q = this.query(query);
    if (!q.format) throw new AppError('VALIDATION_ERROR', 'format が必要です');
    const groupBy = q.groupBy ?? ['customer', 'item', 'vehicleClass'];
    const { facts, names, order } = await this.facts(q.from, q.to);
    const sel = facts.filter((f) => (!q.customerId || f.customerId === q.customerId) && (!q.billingPartyId || f.billingPartyId === q.billingPartyId));
    const g = this.group(sel, names, order, groupBy);
    const head = [...groupBy.map((k) => KEY_JA[k]), '台数', '金額（税抜）', '単価なしの台数'];
    const body = g.rows.map((r) => [...groupBy.map((k) => r.labels[k]), r.tripCount, r.amount, r.priceMissingCount]);
    const totalRow = [...groupBy.map((_, i) => (i === 0 ? '合計' : '')), g.total.tripCount, g.total.amount, g.total.priceMissingCount];
    const base = `集計_${q.from.replace(/-/g, '')}-${q.to.replace(/-/g, '')}`;
    let buf: Buffer, type: string;
    if (q.format === 'csv') {
      const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      buf = Buffer.from('﻿' + [head, ...body, totalRow].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n', 'utf8');
      type = 'text/csv';
    } else {
      const wb = new ExcelJS.Workbook(); wb.creator = 'SoilFlow';
      const s1 = wb.addWorksheet('集計');
      s1.addRow(head).font = { bold: true };
      body.forEach((r) => s1.addRow(r));
      s1.addRow(totalRow).font = { bold: true };
      s1.columns.forEach((c, i) => { c.width = i < groupBy.length ? 24 : 14; if (i >= groupBy.length) c.numFmt = '#,##0'; });
      const s2 = wb.addWorksheet('明細（便ごと）');
      s2.addRow(['日付', '時刻', '客先', '現場', '車番', '品目', '車格', '印', '伝票番号', '請求書番号', '単価']).font = { bold: true };
      for (const f of [...sel].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))) {
        s2.addRow([f.date, f.time, names.customer.get(f.customerId), f.siteId ? names.site.get(f.siteId) : '', f.vehicleNo, names.item.get(f.itemId), names.vehicleClass.get(f.vehicleClassId), f.markSymbol ?? '', f.slipNo ?? '', f.invoiceNo ?? '', f.unitPrice ?? '']);
      }
      s2.columns.forEach((c) => { c.width = 16; });
      buf = Buffer.from(await wb.xlsx.writeBuffer());
      type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    const key = `exports/${now().getTime()}-${Math.random().toString(36).slice(2)}.${q.format}`;
    await this.pdf.put(key, buf, type);
    return this.pdf.signedUrl(key, `${base}.${q.format}`, type);
  }

  /* ---------------------------------------------------------------- 本社の状況（FR-AGG-01） */
  async dashboard() {
    const date = todayJst();
    const [today, awaiting, unslipped, invoices, conn, regs, failedJobs] = await Promise.all([
      this.prisma.trip.count({ where: { tripDate: new Date(`${date}T00:00:00Z`), status: 'ACTIVE' } }),
      this.prisma.slip.count({ where: { status: 'AWAITING_SIGNATURE' } }),
      this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM trips t LEFT JOIN slips s ON s.id = t.slip_id WHERE t.trip_date = ${date}::date AND t.status = 'ACTIVE' AND (t.slip_id IS NULL OR s.status = 'CANCELLED')`,
      this.prisma.invoice.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.freeeConnection.findUniqueOrThrow({ where: { id: 1 } }),
      this.prisma.freeeRegistration.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.job.count({ where: { status: 'FAILED', finishedAt: { gte: new Date(now().getTime() - 7 * 86400000) } } }),
    ]);
    const inv = Object.fromEntries(invoices.map((g) => [g.status, g._count._all]));
    const fr = Object.fromEntries(regs.map((g) => [g.status, g._count._all]));
    const alerts: { code: string; message: string; link: string }[] = [];
    if (inv.SEND_ERROR) alerts.push({ code: 'SEND_ERROR', message: `メールの送信エラーの請求書が ${inv.SEND_ERROR} 件あります`, link: '/office/invoices?status=SEND_ERROR' });
    if (inv.NEEDS_RECHECK) alerts.push({ code: 'NEEDS_RECHECK', message: `含まれる便が変わった請求書が ${inv.NEEDS_RECHECK} 件あります（作り直してください）`, link: '/office/invoices?status=NEEDS_RECHECK' });
    if (conn.status === 'REAUTH_REQUIRED') alerts.push({ code: 'FREEE_REAUTH_REQUIRED', message: 'freee との再連携が必要です', link: '/office/freee/settings' });
    if (conn.status === 'COMPANY_REQUIRED') alerts.push({ code: 'FREEE_COMPANY_REQUIRED', message: 'freee の事業所を選んでください', link: '/office/freee/settings' });
    if (fr.NEEDS_ACTION) alerts.push({ code: 'FREEE_NEEDS_ACTION', message: `freee 登録の要対応が ${fr.NEEDS_ACTION} 件あります`, link: '/office/freee/registrations?status=NEEDS_ACTION' });
    if (fr.ERROR) alerts.push({ code: 'FREEE_ERROR', message: `freee 登録のエラーが ${fr.ERROR} 件あります`, link: '/office/freee/registrations?status=ERROR' });
    if (failedJobs) alerts.push({ code: 'JOB_FAILED', message: `失敗した処理が ${failedJobs} 件あります（保守担当に連絡してください）`, link: '/office/audit-logs' });
    return {
      today: { date, tripCount: today, awaitingSignature: awaiting, unslippedTrips: Number(unslipped[0].n) },
      invoices: inv,
      freee: { connection: { status: conn.status, companyName: conn.companyName, registrationMode: conn.registrationMode, lastError: conn.lastError, version: conn.version }, counts: fr },
      alerts,
    };
  }
}

@Controller()
export class AggregatesController {
  constructor(private readonly s: AggregatesService) {}
  @Get('dashboard') @Roles('OFFICE', 'ADMIN') dashboard() { return this.s.dashboard(); }
  @Get('aggregates') @Roles('OFFICE', 'ADMIN') aggregate(@Query() q: Record<string, unknown>) { return this.s.aggregate(q); }
  @Get('aggregates/trips') @Roles('OFFICE', 'ADMIN') trips(@Query() q: Record<string, unknown>) { return this.s.trips(q); }
  @Get('aggregates/export') @Roles('OFFICE', 'ADMIN') export(@Query() q: Record<string, unknown>) { return this.s.export(q); }
}

@Module({ providers: [AggregatesService], controllers: [AggregatesController] })
export class AggregatesModule {}

export { hhmm, ymd };
