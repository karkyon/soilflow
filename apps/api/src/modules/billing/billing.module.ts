/* 締め・請求書（FR-BIL、SCR-34〜36、11 計算仕様書 4章、08 7.1） */
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { BInvoice, BProblem, billingPeriod, buildInvoices, invoiceNo } from '@soilflow/billing';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentActor, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { isoJst, now, toDate, ymd } from '../../common/dates';
import { big, takeInvoiceSeq, touchTrips, yen } from '../../common/domain';
import { AppError, conflict, invalidState, notFound } from '../../common/errors';
import { Prisma, PrismaService, Tx } from '../../common/prisma.service';
import { parse, zBoolQ, zCsvQ, zDate, zIntQ, zMonth, zReason, zUuid, zVersion } from '../../common/validation';
import { FreeeModule, FreeeService } from '../freee/freee.module';
import { JobsService } from '../jobs/jobs.module';
import { invoiceFileName, PdfService } from '../pdf/pdf.module';
import { SettingsService } from '../settings/settings.module';
import { closingDayOf, LoadedContext, loadContext, monthRange, tripLines } from './billing-context';

const EDITABLE = ['DRAFT', 'NEEDS_RECHECK', 'CONFIRMED'];
const STATUS_JA: Record<string, string> = { DRAFT: '作成済', NEEDS_RECHECK: '要再確認', CONFIRMED: '確認済', SENDING: '送信中', SENT: '送信済', SEND_ERROR: '送信エラー', VOIDED: '取消' };
const INVOICE_STATUSES = ['DRAFT', 'NEEDS_RECHECK', 'CONFIRMED', 'SENDING', 'SENT', 'SEND_ERROR', 'VOIDED'] as const;
/** PDF をその場で作る上限（Firebase Hosting の60秒の制限。04 1.2） */
const INLINE_PDF_LIMIT = 50;

export interface ProblemDto { kind: string; billingPartyId: string | null; tripIds: string[]; message: string }

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly pdf: PdfService, private readonly jobs: JobsService, private readonly freee: FreeeService,
  ) {}

  /* ---------------------------------------------------------------- 出力 */
  async summaries(db: Tx | PrismaService, ids: string[]) {
    if (!ids.length) return [];
    const inv = await db.invoice.findMany({ where: { id: { in: ids } }, orderBy: [{ periodTo: 'desc' }, { invoiceNo: 'asc' }] });
    const agg = await db.$queryRaw<{ invoice_id: string; sites: bigint; trips: bigint }[]>`
      SELECT invoice_id, count(DISTINCT COALESCE(site_id::text, '-')) AS sites, sum(trip_count) AS trips FROM invoice_lines WHERE invoice_id = ANY(${ids}::uuid[]) GROUP BY invoice_id`;
    const regs = await db.freeeRegistration.findMany({ where: { invoiceId: { in: ids } }, select: { invoiceId: true, status: true } });
    return inv.map((i) => {
      const a = agg.find((x) => x.invoice_id === i.id);
      return {
        id: i.id, invoiceNo: i.invoiceNo, billingPartyId: i.billingPartyId, billingPartyName: i.billingPartyName,
        periodFrom: ymd(i.periodFrom), periodTo: ymd(i.periodTo), issueDate: ymd(i.issueDate), dueDate: ymd(i.dueDate),
        siteCount: Number(a?.sites ?? 0), tripCount: Number(a?.trips ?? 0), subtotal: big(i.subtotal), taxAmount: big(i.taxAmount), total: big(i.total),
        status: i.status, freeeStatus: regs.find((r) => r.invoiceId === i.id)?.status ?? null, hasPdf: !!i.pdfObjectKey,
        sentAt: isoJst(i.sentAt), version: i.version,
      };
    });
  }
  get(id: string) { return this.detail(this.prisma, id); }
  async detail(db: Tx | PrismaService, id: string) {
    const [s] = await this.summaries(db, [parse(zUuid, id)]);
    if (!s) throw notFound('請求書');
    const i = await db.invoice.findUniqueOrThrow({ where: { id } });
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { lineNo: 'asc' } });
    const trips = await db.$queryRaw<{ line_no: number; trip_id: string; slip_id: string | null }[]>`
      SELECT it.line_no, it.trip_id, t.slip_id FROM invoice_trips it JOIN trips t ON t.id = it.trip_id WHERE it.invoice_id = ${id}::uuid ORDER BY t.trip_date, t.trip_time`;
    const next = await db.invoice.findFirst({ where: { replacesInvoiceId: id }, select: { id: true } });
    return {
      ...s, taxRate: i.taxRate, taxRounding: i.taxRounding, voidReason: i.voidReason, voidedAt: isoJst(i.voidedAt),
      replacesInvoiceId: i.replacesInvoiceId, replacedByInvoiceId: next?.id ?? null, confirmedAt: isoJst(i.confirmedAt),
      billingPartyHonorific: i.billingPartyHonorific, billingPartyPostal: i.billingPartyPostal, billingPartyAddress: i.billingPartyAddress,
      lines: lines.map((l) => {
        const ts = trips.filter((t) => t.line_no === l.lineNo);
        return {
          lineNo: l.lineNo, siteId: l.siteId, siteName: l.siteName, itemId: l.itemId, itemName: l.itemName, vehicleClassName: l.vehicleClassName,
          unitPrice: l.unitPrice, tripCount: l.tripCount, amount: big(l.amount), tripIds: ts.map((t) => t.trip_id), slipIds: [...new Set(ts.map((t) => t.slip_id).filter(Boolean))],
        };
      }),
    };
  }

  /* ---------------------------------------------------------------- 問題点（BillingProblem） */
  private async problemsFor(db: Tx | PrismaService, ctx: LoadedContext, raw: BProblem[], month: string, targetBpIds: Set<string>, existing: Map<string, { id: string; no: string; status: string }>) {
    const bpName = new Map(ctx.billingParties.map((b) => [b.id, b.name]));
    const out: ProblemDto[] = [];
    const group = (kind: string) => {
      const m = new Map<string, string[]>();
      for (const p of raw.filter((x) => x.kind === kind)) { const k = p.billingPartyId ?? ''; m.set(k, [...(m.get(k) ?? []), ...(p.tripId ? [p.tripId] : [])]); }
      return m;
    };
    for (const [bp, tripIds] of group('PRICE_MISSING')) {
      out.push({ kind: 'PRICE_MISSING', billingPartyId: bp, tripIds, message: `${bpName.get(bp)}：単価表に金額がない便が ${tripIds.length} 台あるため、請求書を作りません（単価表に金額を入れてから締め直してください）` });
    }
    for (const [bp, tripIds] of group('ALREADY_INVOICED')) {
      if (existing.has(bp)) continue;
      out.push({ kind: 'ALREADY_INVOICED', billingPartyId: bp, tripIds, message: `${bpName.get(bp)}：別の請求書に含まれている便が ${tripIds.length} 台あるため、飛ばしました` });
    }
    for (const [bp, inv] of existing) {
      const left = ctx.trips.filter((t) => !t.lockedInvoiceId && this.bpOf(ctx, t) === bp && this.inPeriod(ctx, bp, month, t.date)).map((t) => t.id);
      out.push({
        kind: 'ALREADY_INVOICED', billingPartyId: bp, tripIds: left,
        message: left.length
          ? `${bpName.get(bp)}：請求書 ${inv.no}（${STATUS_JA[inv.status]}）のあとに増えた便が ${left.length} 台あります（${EDITABLE.includes(inv.status) ? '作り直してください' : '取消して再発行してください'}）`
          : `${bpName.get(bp)}：請求書 ${inv.no}（${STATUS_JA[inv.status]}）があるため、作りません`,
      });
    }
    const { from, to } = monthRange(month);
    const st = await this.settings.get(db);
    const periodTrips = ctx.trips.filter((t) => { const bp = this.bpOf(ctx, t); return bp && targetBpIds.has(bp) && this.inPeriod(ctx, bp, month, t.date); });
    if (st.slipWarningEnabled) {
      const sl = new Map(ctx.slips.map((s) => [s.id, s.status]));
      const m = new Map<string, string[]>();
      for (const t of periodTrips) if (!t.slipId || sl.get(t.slipId) === 'CANCELLED') { const bp = this.bpOf(ctx, t)!; m.set(bp, [...(m.get(bp) ?? []), t.id]); }
      for (const [bp, ids] of m) out.push({ kind: 'UNSLIPPED_TRIPS', billingPartyId: bp, tripIds: ids, message: `${bpName.get(bp)}：伝票を発行していない便が ${ids.length} 台あります` });
    }
    const awaiting = await db.$queryRaw<{ slip_no: string; bp: string; ids: string[] }[]>`
      SELECT s.slip_no, s.billing_party_id AS bp, array_agg(t.id) AS ids FROM slips s JOIN trips t ON t.slip_id = s.id
      WHERE s.status = 'AWAITING_SIGNATURE' AND s.slip_date BETWEEN ${from}::date AND ${to}::date GROUP BY s.slip_no, s.billing_party_id`;
    for (const a of awaiting) if (targetBpIds.has(a.bp)) out.push({ kind: 'AWAITING_SIGNATURE', billingPartyId: a.bp, tripIds: a.ids, message: `伝票 ${a.slip_no} がサイン待ちのままです` });
    const inactive = new Map<string, string[]>();
    for (const t of ctx.trips) {
      const bp = this.bpOf(ctx, t); const b = ctx.billingParties.find((x) => x.id === bp);
      if (b && b.active === false && !t.lockedInvoiceId && this.inPeriod(ctx, b.id, month, t.date)) inactive.set(b.id, [...(inactive.get(b.id) ?? []), t.id]);
    }
    for (const [bp, ids] of inactive) out.push({ kind: 'INACTIVE_BILLING_PARTY', billingPartyId: bp, tripIds: ids, message: `${bpName.get(bp)}：無効にした請求先に便が ${ids.length} 台残っています` });
    const bps = await db.billingParty.findMany({ where: { id: { in: [...targetBpIds] } } });
    const conn = await db.freeeConnection.findUnique({ where: { id: 1 } });
    const withTrips = new Set(periodTrips.map((t) => this.bpOf(ctx, t)));
    for (const b of bps.filter((x) => withTrips.has(x.id))) {
      if (!b.mailTo.length) out.push({ kind: 'MAIL_TO_MISSING', billingPartyId: b.id, tripIds: [], message: `${b.name}：請求書の送付先メールが登録されていません` });
      if (conn && conn.status !== 'DISCONNECTED' && ['UNMAPPED', 'CANDIDATE'].includes(b.freeeMappingStatus)) out.push({ kind: 'FREEE_PARTNER_UNMAPPED', billingPartyId: b.id, tripIds: [], message: `${b.name}：freee の取引先が対応付けられていません` });
    }
    return out;
  }
  private bpOf(ctx: LoadedContext, t: LoadedContext['trips'][number]) {
    const row = ctx.rows.find((r) => r.id === t.rowId);
    if (!row) return null;
    if (t.slipId) { const s = ctx.slips.find((x) => x.id === t.slipId); if (s && s.status !== 'CANCELLED') return s.billingPartyId; }
    const site = row.siteId ? ctx.sites.find((s) => s.id === row.siteId) : null;
    return site?.defaultBillingPartyId ?? ctx.customers.find((c) => c.id === row.customerId)?.defaultBillingPartyId ?? null;
  }
  private inPeriod(ctx: LoadedContext, bpId: string, month: string, date: string) {
    const b = ctx.billingParties.find((x) => x.id === bpId);
    if (!b) return false;
    const p = billingPeriod(month, b.closingDay);
    return date >= p.from && date <= p.to;
  }
  /** 請求先ごとの、その月の請求期間の有効な請求書 */
  private async existingFor(db: Tx | PrismaService, ctx: LoadedContext, month: string) {
    const inv = await db.invoice.findMany({ where: { status: { not: 'VOIDED' }, periodTo: { gte: toDate(monthRange(month).from) } }, select: { id: true, invoiceNo: true, status: true, billingPartyId: true, periodFrom: true, periodTo: true } });
    const m = new Map<string, { id: string; no: string; status: string }>();
    for (const b of ctx.billingParties) {
      const p = billingPeriod(month, b.closingDay);
      const hit = inv.find((i) => i.billingPartyId === b.id && ymd(i.periodFrom) === p.from && ymd(i.periodTo) === p.to);
      if (hit) m.set(b.id, { id: hit.id, no: hit.invoiceNo, status: hit.status });
    }
    return m;
  }

  /* ---------------------------------------------------------------- 締めの前の確認（FR-BIL-04） */
  async precheck(query: Record<string, unknown>) {
    const { month } = parse(z.object({ month: zMonth }), query);
    const { from, to } = monthRange(month);
    const ctx = await loadContext(this.prisma, from, to);
    const st = await this.settings.get();
    const existing = await this.existingFor(this.prisma, ctx, month);
    const active = ctx.billingParties.filter((b) => b.active !== false).map((b) => b.id);
    const target = active.filter((id) => !existing.has(id));
    const { invoices, problems } = buildInvoices(month, { ...ctx, taxRate: st.taxRate, rounding: st.taxRounding, billingPartyIds: target });
    const out = await this.problemsFor(this.prisma, ctx, problems, month, new Set(active), existing);
    const bpName = new Map(ctx.billingParties.map((b) => [b.id, b.name]));
    const list = invoices.map((i) => ({ billingPartyId: i.billingPartyId, name: bpName.get(i.billingPartyId)!, periodFrom: i.periodFrom, periodTo: i.periodTo, tripCount: i.tripIds.length, subtotal: i.subtotal, existingInvoiceId: null as string | null }));
    for (const [bp, inv] of existing) {
      const i = await this.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      const n = await this.prisma.invoiceTrip.count({ where: { invoiceId: inv.id } });
      list.push({ billingPartyId: bp, name: bpName.get(bp)!, periodFrom: ymd(i.periodFrom), periodTo: ymd(i.periodTo), tripCount: n, subtotal: big(i.subtotal), existingInvoiceId: inv.id });
    }
    const kana = new Map(ctx.billingParties.map((b) => [b.id, b.kana ?? b.name]));
    list.sort((a, b) => kana.get(a.billingPartyId)!.localeCompare(kana.get(b.billingPartyId)!, 'ja'));
    return { month, billingParties: list, problems: out };
  }

  /* ---------------------------------------------------------------- 締め（FR-BIL-03、08 7.1） */
  async run(actor: Actor, body: unknown, res: Response) {
    const b = parse(z.object({ month: zMonth, billingPartyIds: z.array(zUuid).max(1000).optional() }).strict(), body);
    const { from, to } = monthRange(b.month);
    const result = await this.prisma.tx(async (tx) => {
      // 対象の請求先の行をロックする（同時に締めても二重に作らない）
      await tx.$queryRaw`SELECT id FROM billing_parties WHERE active AND (${b.billingPartyIds ?? null}::uuid[] IS NULL OR id = ANY(${b.billingPartyIds ?? null}::uuid[])) ORDER BY id FOR UPDATE`;
      const ctx = await loadContext(tx, from, to);
      const st = await this.settings.get(tx);
      const existing = await this.existingFor(tx, ctx, b.month);
      const active = ctx.billingParties.filter((x) => x.active !== false && (!b.billingPartyIds || b.billingPartyIds.includes(x.id))).map((x) => x.id);
      const target = active.filter((id) => !existing.has(id));
      const built = buildInvoices(b.month, { ...ctx, taxRate: st.taxRate, rounding: st.taxRounding, billingPartyIds: target });
      const problems = await this.problemsFor(tx, ctx, built.problems, b.month, new Set(active), existing);
      const run = await tx.billingRun.create({ data: { targetMonth: b.month, executedBy: actor.id, result: {} } });
      const ids: string[] = [];
      if (built.invoices.length) {
        const seq = await takeInvoiceSeq(tx, built.invoices[0].periodTo, built.invoices.length);
        for (const [k, inv] of built.invoices.entries()) ids.push(await this.persist(tx, actor, { ...inv, invoiceNo: invoiceNo(inv.periodTo, seq + k) }, ctx, { runId: run.id, taxRounding: st.taxRounding }));
      }
      await tx.billingRun.update({ where: { id: run.id }, data: { result: { status: 'DONE', createdInvoiceIds: ids, problems } as unknown as Prisma.InputJsonValue } });
      const total = built.invoices.reduce((a, i) => a + i.total, 0);
      await this.audit.write(tx, actor, {
        action: 'BILLING_RUN', targetType: 'billing_run', targetId: run.id,
        summary: `${b.month} の締め：請求書 ${ids.length} 件を作成（合計 ${yen(total)} 円${problems.length ? `、問題点 ${problems.length} 件` : ''}）`,
        after: { createdInvoiceIds: ids, invoiceNos: built.invoices.map((i) => i.invoiceNo), problems: problems.map((p) => p.kind) },
      });
      return { id: run.id, ids, problems };
    }, { timeout: 120000 });
    if (result.ids.length <= INLINE_PDF_LIMIT) {
      for (const id of result.ids) await this.pdf.renderInvoiceOrQueue(id);
      res.status(201);
    } else {
      for (const id of result.ids) await this.jobs.enqueue(this.prisma, 'PDF_INVOICE', { invoiceId: id }, { dedupeKey: `PDF_INVOICE:${id}` });
      res.status(202);
    }
    return this.getRun(result.id);
  }

  /** 請求書・明細・含めた便を書き、便に請求書を付ける（08 7.1 手順3） */
  private async persist(tx: Tx, actor: Actor, inv: BInvoice, ctx: LoadedContext, o: { runId?: string; replacesId?: string; taxRounding: string }) {
    const bp = await tx.billingParty.findUniqueOrThrow({ where: { id: inv.billingPartyId } });
    const created = await tx.invoice.create({
      data: {
        invoiceNo: inv.invoiceNo, billingPartyId: bp.id, billingRunId: o.runId ?? null, periodFrom: toDate(inv.periodFrom), periodTo: toDate(inv.periodTo),
        issueDate: toDate(inv.issueDate), dueDate: toDate(inv.dueDate), billingPartyName: bp.name, billingPartyHonorific: bp.honorific,
        billingPartyPostal: bp.postalCode, billingPartyAddress: bp.address, subtotal: inv.subtotal, taxRate: inv.taxRate, taxRounding: o.taxRounding,
        taxAmount: inv.taxAmount, total: inv.total, replacesInvoiceId: o.replacesId ?? null, createdBy: actor.id,
      },
    });
    await this.writeLines(tx, created.id, inv, ctx);
    return created.id;
  }
  private async writeLines(tx: Tx, invoiceId: string, inv: BInvoice, ctx: LoadedContext) {
    const [sites, items, vcs] = await Promise.all([tx.site.findMany(), tx.item.findMany(), tx.vehicleClass.findMany()]);
    await tx.invoiceLine.createMany({
      data: inv.lines.map((l) => ({
        invoiceId, lineNo: l.lineNo, siteId: l.siteId, siteName: sites.find((s) => s.id === l.siteId)?.name ?? null,
        itemId: l.itemId, itemName: items.find((i) => i.id === l.itemId)!.priceItemName, vehicleClassId: l.vehicleClassId,
        vehicleClassName: vcs.find((v) => v.id === l.vehicleClassId)!.name, unitPrice: l.unitPrice, tripCount: l.tripCount, amount: l.amount,
      })),
    });
    await tx.invoiceTrip.createMany({ data: tripLines(inv, ctx).map((t) => ({ invoiceId, ...t })) });
    await tx.$executeRaw`UPDATE trips SET invoice_id = ${invoiceId}::uuid WHERE id = ANY(${inv.tripIds}::uuid[])`;
  }

  async getRun(id: string) {
    const r = await this.prisma.billingRun.findUnique({ where: { id: parse(zUuid, id) } });
    if (!r) throw notFound('締めの結果');
    const res = r.result as { status?: string; createdInvoiceIds?: string[]; problems?: ProblemDto[] };
    const ids = res.createdInvoiceIds ?? [];
    const pending = ids.length ? await this.prisma.invoice.count({ where: { id: { in: ids }, pdfObjectKey: null, status: { in: EDITABLE } } }) : 0;
    const failed = ids.length ? await this.prisma.job.count({ where: { kind: 'PDF_INVOICE', status: 'FAILED', dedupeKey: { in: ids.map((x) => `PDF_INVOICE:${x}`) } } }) : 0;
    return { id: r.id, month: r.targetMonth, status: failed ? 'FAILED' : pending ? 'RUNNING' : 'DONE', createdInvoiceIds: ids, pdfPending: pending, problems: res.problems ?? [], executedAt: isoJst(r.executedAt) };
  }

  /* ---------------------------------------------------------------- 一覧・検索（02 6.3） */
  async list(query: Record<string, unknown>) {
    const q = parse(z.object({
      month: zMonth.optional(), issueFrom: zDate.optional(), issueTo: zDate.optional(), amountMin: zIntQ.optional(), amountMax: zIntQ.optional(),
      billingPartyId: zUuid.optional(), status: zCsvQ(z.enum(INVOICE_STATUSES)).optional(), includeVoided: zBoolQ.optional(),
    }), query);
    const where: Record<string, unknown> = {};
    if (q.month) { const { to } = monthRange(q.month); where.periodTo = { gte: toDate(`${q.month}-01`), lte: toDate(to) }; }
    if (q.issueFrom || q.issueTo) where.issueDate = { ...(q.issueFrom ? { gte: toDate(q.issueFrom) } : {}), ...(q.issueTo ? { lte: toDate(q.issueTo) } : {}) };
    if (q.amountMin !== undefined || q.amountMax !== undefined) where.total = { ...(q.amountMin !== undefined ? { gte: q.amountMin } : {}), ...(q.amountMax !== undefined ? { lte: q.amountMax } : {}) };
    if (q.billingPartyId) where.billingPartyId = q.billingPartyId;
    if (q.status?.length) where.status = { in: q.status };
    else if (!q.includeVoided) where.status = { not: 'VOIDED' };
    const ids = await this.prisma.invoice.findMany({ where, select: { id: true }, orderBy: [{ periodTo: 'desc' }, { invoiceNo: 'asc' }], take: 1000 });
    return { items: await this.summaries(this.prisma, ids.map((x) => x.id)) };
  }

  private async lock(tx: Tx, id: string) {
    parse(zUuid, id);
    const r = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
    if (!r.length) throw notFound('請求書');
    return tx.invoice.findUniqueOrThrow({ where: { id } });
  }

  /* ---------------------------------------------------------------- 請求日・入金期日（FR-BIL-08） */
  async updateDates(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), issueDate: zDate.optional(), dueDate: zDate.optional() }).strict(), body);
    await this.prisma.tx(async (tx) => {
      const i = await this.lock(tx, id);
      if (!EDITABLE.includes(i.status)) throw new AppError('INVOICE_FROZEN', `${STATUS_JA[i.status]}の請求書は日付を変えられません`);
      const issue = b.issueDate ?? ymd(i.issueDate), due = b.dueDate ?? ymd(i.dueDate);
      if (due < issue) throw new AppError('VALIDATION_ERROR', '入金期日は請求日より後にしてください');
      const r = await tx.invoice.updateMany({ where: { id, version: b.version }, data: { issueDate: toDate(issue), dueDate: toDate(due), pdfObjectKey: null, pdfSha256: null } });
      if (!r.count) throw conflict();
      await this.audit.write(tx, actor, { action: 'INVOICE_DATES', targetType: 'invoice', targetId: id, summary: `請求書 ${i.invoiceNo} の日付を変更（請求日 ${issue}・入金期日 ${due}）`, before: { issueDate: ymd(i.issueDate), dueDate: ymd(i.dueDate) }, after: { issueDate: issue, dueDate: due } });
    });
    await this.pdf.renderInvoiceOrQueue(id);
    return this.detail(this.prisma, id);
  }

  /** 同じ請求先・同じ請求期間で計算し直す（作り直し・再発行。11 4.8） */
  private async recompute(tx: Tx, i: { id: string; billingPartyId: string; periodFrom: Date; periodTo: Date }, excludeInvoiceId?: string) {
    const from = ymd(i.periodFrom), to = ymd(i.periodTo);
    const ctx = await loadContext(tx, from, to, { excludeInvoiceId });
    const st = await this.settings.get(tx);
    const bp = ctx.billingParties.find((b) => b.id === i.billingPartyId)!;
    const cd = closingDayOf(to);
    const period = billingPeriod(to.slice(0, 7), cd);
    if (period.from !== from) throw invalidState('請求期間を作り直せません（締め日の設定と請求期間が合いません）');
    ctx.billingParties = ctx.billingParties.map((b) => (b.id === bp.id ? { ...b, closingDay: cd, active: true } : b));
    const built = buildInvoices(to.slice(0, 7), { ...ctx, taxRate: st.taxRate, rounding: st.taxRounding, billingPartyIds: [bp.id] });
    const missing = built.problems.filter((p) => p.kind === 'PRICE_MISSING');
    if (missing.length) throw invalidState(`単価表に金額がない便が ${missing.length} 台あります。単価表に金額を入れてください`, { tripIds: missing.map((p) => p.tripId) });
    const inv = built.invoices[0];
    if (!inv) throw invalidState('この請求期間に請求する便がありません。請求書を取り消してください');
    return { inv, ctx, st };
  }

  /* ---------------------------------------------------------------- 作り直す（FR-BIL-11） */
  async rebuild(actor: Actor, id: string, body: unknown) {
    const { version } = parse(zVersion.strict(), body);
    await this.prisma.tx(async (tx) => {
      const i = await this.lock(tx, id);
      if (!EDITABLE.includes(i.status)) throw invalidState(`${STATUS_JA[i.status]}の請求書は作り直せません（取消して再発行してください）`);
      if (i.version !== version) throw conflict();
      await tx.$queryRaw`SELECT id FROM billing_parties WHERE id = ${i.billingPartyId}::uuid FOR UPDATE`;
      await tx.$executeRaw`UPDATE trips SET invoice_id = NULL WHERE invoice_id = ${id}::uuid`;
      await tx.invoiceTrip.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      const { inv, ctx, st } = await this.recompute(tx, i);
      const bp = await tx.billingParty.findUniqueOrThrow({ where: { id: i.billingPartyId } });
      await tx.invoice.update({
        where: { id },
        data: {
          subtotal: inv.subtotal, taxRate: inv.taxRate, taxRounding: st.taxRounding, taxAmount: inv.taxAmount, total: inv.total, status: 'DRAFT',
          confirmedAt: null, confirmedBy: null, pdfObjectKey: null, pdfSha256: null,
          billingPartyName: bp.name, billingPartyHonorific: bp.honorific, billingPartyPostal: bp.postalCode, billingPartyAddress: bp.address,
        },
      });
      await this.writeLines(tx, id, inv, ctx);
      await this.audit.write(tx, actor, {
        action: 'INVOICE_REBUILD', targetType: 'invoice', targetId: id, summary: `請求書 ${i.invoiceNo} を作り直した（${yen(big(i.total))} 円 → ${yen(inv.total)} 円）`,
        before: { subtotal: big(i.subtotal), taxAmount: big(i.taxAmount), total: big(i.total), status: i.status }, after: { subtotal: inv.subtotal, taxAmount: inv.taxAmount, total: inv.total, tripCount: inv.tripIds.length },
      });
    });
    await this.pdf.renderInvoiceOrQueue(id);
    return this.detail(this.prisma, id);
  }

  /* ---------------------------------------------------------------- 確認済（FR-BIL-10） */
  async confirm(actor: Actor, id: string, body: unknown, on: boolean) {
    const { version } = parse(zVersion.strict(), body);
    await this.prisma.tx(async (tx) => {
      const i = await this.lock(tx, id);
      if (on && i.status !== 'DRAFT') throw invalidState(i.status === 'NEEDS_RECHECK' ? '含まれる便が変わりました。作り直してから確認してください' : `${STATUS_JA[i.status]}の請求書は確認済にできません`);
      if (!on && i.status !== 'CONFIRMED') throw invalidState('確認済の請求書だけ確認を取り消せます');
      const r = await tx.invoice.updateMany({ where: { id, version }, data: on ? { status: 'CONFIRMED', confirmedAt: now(), confirmedBy: actor.id } : { status: 'DRAFT', confirmedAt: null, confirmedBy: null } });
      if (!r.count) throw conflict();
      await this.audit.write(tx, actor, { action: on ? 'INVOICE_CONFIRM' : 'INVOICE_UNCONFIRM', targetType: 'invoice', targetId: id, summary: `請求書 ${i.invoiceNo} を${on ? '確認済にした' : '確認の取り消し'}（${yen(big(i.total))} 円）` });
    });
    return this.detail(this.prisma, id);
  }

  /* ---------------------------------------------------------------- 取消・再発行（FR-BIL-13、FR-FRE-18・19） */
  private async voidIn(tx: Tx, actor: Actor, id: string, version: number, reason: string, reissue: boolean) {
    const i = await this.lock(tx, id);
    if (i.status === 'VOIDED') throw invalidState('すでに取り消した請求書です');
    if (i.status === 'SENDING') throw invalidState('メールの送信中です。送信が終わってから取り消してください');
    if (i.version !== version) throw conflict();
    await touchTrips(tx, { invoiceId: id });
    await tx.$executeRaw`UPDATE trips SET invoice_id = NULL WHERE invoice_id = ${id}::uuid`;
    await tx.invoice.update({ where: { id }, data: { status: 'VOIDED', voidReason: reason, voidedAt: now(), voidedBy: actor.id } });
    const jobId = await this.freee.onInvoiceVoided(tx, actor, id, reissue);
    await this.audit.write(tx, actor, { action: 'INVOICE_VOID', targetType: 'invoice', targetId: id, summary: `請求書 ${i.invoiceNo} を取消${reissue ? '（再発行のため）' : ''}（${STATUS_JA[i.status]}、${yen(big(i.total))} 円）`, reason, before: { status: i.status } });
    return { i, jobId };
  }
  async void(actor: Actor, id: string, body: unknown) {
    const b = parse(zReason.strict(), body);
    const { jobId } = await this.prisma.tx((tx) => this.voidIn(tx, actor, id, b.version, b.reason, false));
    await this.jobs.runNow(jobId).catch(() => undefined);
    return this.detail(this.prisma, id);
  }
  async reissue(actor: Actor, id: string, body: unknown) {
    const b = parse(zReason.strict(), body);
    const { newId, jobId } = await this.prisma.tx(async (tx) => {
      const { i, jobId } = await this.voidIn(tx, actor, id, b.version, b.reason, true);
      await tx.$queryRaw`SELECT id FROM billing_parties WHERE id = ${i.billingPartyId}::uuid FOR UPDATE`;
      const { inv, ctx, st } = await this.recompute(tx, i);
      const seq = await takeInvoiceSeq(tx, inv.periodTo, 1);
      const newId = await this.persist(tx, actor, { ...inv, invoiceNo: invoiceNo(inv.periodTo, seq), issueDate: ymd(i.issueDate), dueDate: ymd(i.dueDate) }, ctx, { replacesId: id, taxRounding: st.taxRounding });
      const n = await tx.invoice.findUniqueOrThrow({ where: { id: newId } });
      await this.audit.write(tx, actor, { action: 'INVOICE_REISSUE', targetType: 'invoice', targetId: newId, summary: `請求書 ${i.invoiceNo} を再発行して ${n.invoiceNo} を作成（${yen(inv.total)} 円）`, reason: b.reason, after: { replacesInvoiceId: id, total: inv.total } });
      return { newId, jobId };
    });
    await this.jobs.runNow(jobId).catch(() => undefined);
    await this.pdf.renderInvoiceOrQueue(newId);
    return this.detail(this.prisma, newId);
  }

  async pdfUrl(id: string) {
    let i = await this.prisma.invoice.findUnique({ where: { id: parse(zUuid, id) } });
    if (!i) throw notFound('請求書');
    if (!i.pdfObjectKey && EDITABLE.includes(i.status)) { await this.pdf.renderInvoice(id); i = await this.prisma.invoice.findUniqueOrThrow({ where: { id } }); }
    if (!i.pdfObjectKey) throw new AppError('NOT_FOUND', 'PDF を作成中です。少し待ってから開いてください');
    return this.pdf.signedUrl(i.pdfObjectKey, invoiceFileName(i.billingPartyName, ymd(i.periodTo)));
  }
}

const O = ['OFFICE', 'ADMIN'] as const;
@Controller()
export class BillingController {
  constructor(private readonly s: BillingService) {}
  @Get('billing/precheck') @Roles(...O) precheck(@Query() q: Record<string, unknown>) { return this.s.precheck(q); }
  @Post('billing/runs') @Roles(...O) run(@CurrentActor() a: Actor, @Body() b: unknown, @Res({ passthrough: true }) res: Response) { return this.s.run(a, b, res); }
  @Get('billing/runs/:id') @Roles(...O) getRun(@Param('id') id: string) { return this.s.getRun(id); }
  @Get('invoices') @Roles(...O) list(@Query() q: Record<string, unknown>) { return this.s.list(q); }
  @Get('invoices/:id') @Roles(...O) get(@Param('id') id: string) { return this.s.get(id); }
  @Patch('invoices/:id') @Roles(...O) dates(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.updateDates(a, id, b); }
  @Post('invoices/:id/rebuild') @Roles(...O) @HttpCode(200) rebuild(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.rebuild(a, id, b); }
  @Post('invoices/:id/confirm') @Roles(...O) @HttpCode(200) confirm(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.confirm(a, id, b, true); }
  @Post('invoices/:id/unconfirm') @Roles(...O) @HttpCode(200) unconfirm(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.confirm(a, id, b, false); }
  @Post('invoices/:id/void') @Roles(...O) @HttpCode(200) void(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.void(a, id, b); }
  @Post('invoices/:id/reissue') @Roles(...O) @HttpCode(201) reissue(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.reissue(a, id, b); }
  @Get('invoices/:id/pdf') @Roles(...O) pdf(@Param('id') id: string) { return this.s.pdfUrl(id); }
}

@Module({ imports: [FreeeModule], providers: [BillingService], controllers: [BillingController], exports: [BillingService] })
export class BillingModule {}
