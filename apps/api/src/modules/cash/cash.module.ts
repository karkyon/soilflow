/*
 * 現金のお客さま（FR-BIL-15、設計案【回答待ち Q-29】、RPT-07 領収書）。
 * 請求先の支払い方法が「現金」の伝票（サイン済・紙で印刷・紙サイン登録済）から、その場で領収書を出して代金を受け取る。
 * 領収書を出した伝票の便は、月の締めで請求書に入れない（packages/billing の CASH_SETTLED）。金額の計算は packages/billing だけで行う。
 * 受付も金額を見る（現金を受け取るため。FR-RCV-20 の例外は領収書だけ）。
 */
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { buildCashReceipt, cashReceiptNo, needsRevenueStamp } from '@soilflow/billing';
import { cashReceiptPdf } from '@soilflow/pdf';
import { z } from 'zod';
import { Actor, CurrentActor, isOffice, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { isoJst, now, todayJst, ymd } from '../../common/dates';
import { AppError, conflict, invalidState, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse, zDate, zUuid } from '../../common/validation';
import { loadContext } from '../billing/billing-context';
import { PdfService, sha256 } from '../pdf/pdf.module';
import { SettingsService } from '../settings/settings.module';

const RECEIVABLE = ['SIGNED', 'PAPER_PRINTED', 'PAPER_SIGNED'];
const PDF = 'application/pdf';

@Injectable()
export class CashService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pdf: PdfService, private readonly settings: SettingsService) {}

  /** 伝票から領収書の中身を作る（保存しない） */
  private async compute(db: Tx | PrismaService, slipId: string) {
    const st = await this.settings.get(db);
    if (!st.cashPaymentEnabled) throw invalidState('現金のお客さまの領収書は使わない設定です（システム設定で変えられます）');
    const slip = await db.slip.findUnique({ where: { id: parse(zUuid, slipId) } });
    if (!slip) throw notFound('伝票');
    const bp = await db.billingParty.findUniqueOrThrow({ where: { id: slip.billingPartyId } });
    if (bp.paymentMethod !== 'CASH') throw invalidState(`伝票の請求先「${bp.name}」は現金のお客さまではありません（請求先マスタの支払い方法）`);
    if (!RECEIVABLE.includes(slip.status)) throw invalidState('領収書は、サイン済・紙で印刷した伝票から出せます（便が固定されてから）');
    const trips = await db.$queryRaw<{ id: string; trip_date: Date; effective_item_id: string; vehicle_class_id: string; inv: string | null }[]>`
      SELECT t.id, t.trip_date, t.effective_item_id, r.vehicle_class_id, i.status AS inv
      FROM trips t JOIN report_rows r ON r.id = t.report_row_id LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE t.slip_id = ${slip.id}::uuid AND t.status = 'ACTIVE' ORDER BY t.trip_time, t.id`;
    if (!trips.length) throw new AppError('NO_TRIPS_FOR_SLIP', '伝票に便がありません');
    if (trips.some((t) => t.inv && t.inv !== 'VOIDED')) throw invalidState('この伝票の便はすでに請求書に入っています。現金で受け取るなら、先に請求書を作り直すか取り消してください');
    const date = ymd(slip.slipDate);
    const ctx = await loadContext(db, date, date);
    const r = buildCashReceipt(trips.map((t) => ({ id: t.id, date: ymd(t.trip_date), itemId: t.effective_item_id, vehicleClassId: t.vehicle_class_id })), ctx.priceTables, st.taxRate, st.taxRounding);
    if (r.error) throw new AppError('VALIDATION_ERROR', `単価表に金額がない便が ${r.tripIds.length} 台あります。本社で単価表を直してください`);
    const [items, vcs] = await Promise.all([db.item.findMany(), db.vehicleClass.findMany()]);
    const lines = r.lines.map((l) => ({ itemName: items.find((i) => i.id === l.itemId)?.priceItemName ?? '', vehicleClassName: vcs.find((v) => v.id === l.vehicleClassId)?.name ?? '', tripCount: l.tripCount, unitPrice: l.unitPrice, amount: l.amount }));
    return { slip, bp, st, date, lines, subtotal: r.subtotal, taxRate: r.taxRate, taxAmount: r.taxAmount, total: r.total, revenueStamp: needsRevenueStamp(r.subtotal), tripCount: trips.length };
  }

  async preview(slipId: string) {
    const c = await this.compute(this.prisma, slipId);
    return { slipId: c.slip.id, slipNo: c.slip.slipNo, receiptDate: todayJst(), addresseeName: c.slip.addresseeName, billingPartyName: c.bp.name, lines: c.lines, subtotal: c.subtotal, taxRate: c.taxRate, taxAmount: c.taxAmount, total: c.total, revenueStamp: c.revenueStamp, tripCount: c.tripCount };
  }

  /** 領収書を出す（代金を受け取った） */
  async issue(actor: Actor, slipId: string, body: unknown) {
    const b = parse(z.object({ addresseeName: z.string().trim().min(1).max(100).optional() }).strict(), body);
    const id = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM slips WHERE id = ${parse(zUuid, slipId)}::uuid FOR UPDATE`;
      if (await tx.cashReceipt.count({ where: { slipId, status: 'ACTIVE' } })) throw invalidState('この伝票にはもう領収書を出しています（出し直すときは本社で取り消してから）');
      const c = await this.compute(tx, slipId);
      const day = todayJst();
      const ym = day.slice(2, 4) + day.slice(5, 7);
      const seq = (await tx.$queryRaw<{ last_no: number }[]>`
        INSERT INTO cash_receipt_counters (ym, last_no) VALUES (${ym}, 1) ON CONFLICT (ym) DO UPDATE SET last_no = cash_receipt_counters.last_no + 1 RETURNING last_no`)[0].last_no;
      const rc = await tx.cashReceipt.create({
        data: {
          receiptNo: cashReceiptNo(day, seq), slipId: c.slip.id, billingPartyId: c.bp.id, receiptDate: new Date(`${day}T00:00:00Z`), addresseeName: b.addresseeName ?? c.slip.addresseeName,
          lines: c.lines, subtotal: BigInt(c.subtotal), taxRate: c.taxRate, taxRounding: c.st.taxRounding, taxAmount: BigInt(c.taxAmount), total: BigInt(c.total), receivedBy: actor.id,
        },
      });
      await this.audit.write(tx, actor, {
        action: 'CASH_RECEIPT_ISSUE', targetType: 'cash_receipt', targetId: rc.id,
        summary: `伝票 ${c.slip.slipNo} の代金 ${c.total.toLocaleString('ja-JP')} 円を現金で受け取り、領収書 ${rc.receiptNo} を出した`, after: { total: c.total, tripCount: c.tripCount },
      });
      return rc.id;
    });
    await this.render(id).catch(() => undefined); // PDF は開くときにも作り直せる
    return this.one(id);
  }

  private async render(id: string) {
    const r = await this.prisma.cashReceipt.findUniqueOrThrow({ where: { id } });
    const [slip, st, user] = await Promise.all([this.prisma.slip.findUniqueOrThrow({ where: { id: r.slipId } }), this.settings.get(), this.prisma.user.findUnique({ where: { id: r.receivedBy } })]);
    const buf = await cashReceiptPdf({
      receiptNo: r.receiptNo, receiptDate: ymd(r.receiptDate), addresseeName: r.addresseeName, slipNo: slip.slipNo, siteName: slip.siteName,
      lines: r.lines as never, subtotal: Number(r.subtotal), taxRate: r.taxRate, taxAmount: Number(r.taxAmount), total: Number(r.total),
      revenueStamp: needsRevenueStamp(Number(r.subtotal)), receivedByName: user?.name ?? '',
      issuer: { companyName: st.companyName, officeName: st.officeName, postalCode: st.postalCode, address: st.address, tel: st.tel, registrationNo: st.invoiceRegistrationNo },
    });
    const key = `cash-receipts/${id}/${r.receiptNo}.pdf`;
    await this.pdf.put(key, buf, PDF);
    await this.prisma.$executeRaw`UPDATE cash_receipts SET pdf_object_key = ${key}, pdf_sha256 = ${sha256(buf)} WHERE id = ${id}::uuid AND pdf_object_key IS NULL`;
    return key;
  }

  async pdfUrl(id: string) {
    const r = await this.prisma.cashReceipt.findUnique({ where: { id: parse(zUuid, id) } });
    if (!r) throw notFound('領収書');
    const key = r.pdfObjectKey && (await this.pdf.exists(r.pdfObjectKey)) ? r.pdfObjectKey : await this.render(r.id);
    return this.pdf.signedUrl(key, `領収書_${r.receiptNo}.pdf`, PDF);
  }

  async void(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), reason: z.string().trim().min(1, '理由を入れてください').max(200) }).strict(), body);
    await this.prisma.tx(async (tx) => {
      const r = await tx.cashReceipt.findUnique({ where: { id: parse(zUuid, id) } });
      if (!r) throw notFound('領収書');
      if (r.status === 'VOIDED') throw invalidState('すでに取り消した領収書です');
      const u = await tx.cashReceipt.updateMany({ where: { id: r.id, version: b.version }, data: { status: 'VOIDED', voidReason: b.reason, voidedAt: now(), voidedBy: actor.id } });
      if (!u.count) throw conflict();
      await this.audit.write(tx, actor, {
        action: 'CASH_RECEIPT_VOID', targetType: 'cash_receipt', targetId: r.id, reason: b.reason,
        summary: `領収書 ${r.receiptNo}（${Number(r.total).toLocaleString('ja-JP')} 円）を取り消した。伝票の便は請求の対象に戻る`,
      });
    });
    return this.one(id);
  }

  /** 一覧と日ごとの合計（現金の照合）。受付は今日の分だけ */
  async list(actor: Actor, query: Record<string, unknown>) {
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional(), status: z.enum(['ACTIVE', 'VOIDED']).optional() }), query);
    const today = todayJst();
    const from = isOffice(actor) ? q.from ?? today : today, to = isOffice(actor) ? q.to ?? today : today;
    if (from > to) throw new AppError('VALIDATION_ERROR', '期間の始まりと終わりが逆です');
    const rs = await this.prisma.cashReceipt.findMany({
      where: { receiptDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }, ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ receiptDate: 'desc' }, { receiptNo: 'desc' }],
    });
    const items = await this.dtos(rs);
    const byDate = new Map<string, { date: string; count: number; total: number }>();
    for (const r of items.filter((x) => x.status === 'ACTIVE')) { const d = byDate.get(r.receiptDate) ?? { date: r.receiptDate, count: 0, total: 0 }; d.count++; d.total += r.total; byDate.set(r.receiptDate, d); }
    const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
    return { from, to, items, byDate: days, total: { count: days.reduce((a, d) => a + d.count, 0), total: days.reduce((a, d) => a + d.total, 0) } };
  }

  private async one(id: string) {
    const r = await this.prisma.cashReceipt.findUniqueOrThrow({ where: { id } });
    return (await this.dtos([r]))[0];
  }
  private async dtos(rs: Awaited<ReturnType<PrismaService['cashReceipt']['findMany']>>) {
    const slips = await this.prisma.slip.findMany({ where: { id: { in: rs.map((r) => r.slipId) } }, select: { id: true, slipNo: true, siteName: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rs.flatMap((r) => [r.receivedBy, ...(r.voidedBy ? [r.voidedBy] : [])]) } }, select: { id: true, name: true } });
    const bps = await this.prisma.billingParty.findMany({ where: { id: { in: rs.map((r) => r.billingPartyId) } }, select: { id: true, name: true } });
    return rs.map((r) => ({
      id: r.id, receiptNo: r.receiptNo, receiptDate: ymd(r.receiptDate), slipId: r.slipId, slipNo: slips.find((s) => s.id === r.slipId)?.slipNo ?? '', siteName: slips.find((s) => s.id === r.slipId)?.siteName ?? null,
      billingPartyName: bps.find((b) => b.id === r.billingPartyId)?.name ?? '', addresseeName: r.addresseeName, lines: r.lines as unknown[],
      subtotal: Number(r.subtotal), taxRate: r.taxRate, taxAmount: Number(r.taxAmount), total: Number(r.total), revenueStamp: needsRevenueStamp(Number(r.subtotal)),
      receivedByName: users.find((u) => u.id === r.receivedBy)?.name ?? '', receivedAt: isoJst(r.receivedAt), status: r.status,
      voidReason: r.voidReason, voidedAt: isoJst(r.voidedAt), voidedByName: r.voidedBy ? users.find((u) => u.id === r.voidedBy)?.name ?? null : null, version: r.version,
    }));
  }
}

@Controller()
export class CashController {
  constructor(private readonly s: CashService) {}
  @Get('slips/:id/cash-preview') @Roles('RECEPTION', 'OFFICE', 'ADMIN') preview(@Param('id') id: string) { return this.s.preview(id); }
  @Post('slips/:id/cash-receipt') @Roles('RECEPTION', 'OFFICE', 'ADMIN') issue(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.issue(a, id, b); }
  @Get('cash-receipts') @Roles('RECEPTION', 'OFFICE', 'ADMIN') list(@CurrentActor() a: Actor, @Query() q: Record<string, unknown>) { return this.s.list(a, q); }
  @Get('cash-receipts/:id/pdf') @Roles('RECEPTION', 'OFFICE', 'ADMIN') pdf(@Param('id') id: string) { return this.s.pdfUrl(id); }
  @Post('cash-receipts/:id/void') @Roles('OFFICE', 'ADMIN') @HttpCode(200) void(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.void(a, id, b); }
}

@Module({ providers: [CashService], controllers: [CashController] })
export class CashModule {}
