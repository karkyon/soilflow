/* 帳票の作成と保存（10 帳票設計書、04 3.5）。描画は packages/pdf、保存は Cloud Storage、ハッシュは DB */
import { Global, Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { dailyReportPdf, invoicePdf, slipPdf, SlipPdfInput } from '@soilflow/pdf';
import { createHash } from 'node:crypto';
import { STORAGE, StorageAdapter } from '../../adapters/storage';
import { tripCounts } from '@soilflow/billing';
import { hhmm, jst, now, ymd } from '../../common/dates';
import { big } from '../../common/domain';
import { AppError } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { JobsService } from '../jobs/jobs.module';
import { SettingsService } from '../settings/settings.module';

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** ファイル名に使えない文字を全角に（09 5章） */
export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/\s+/g, '');
export const slipFileName = (slipNo: string) => `伝票_${slipNo}.pdf`;
export const invoiceFileName = (billingPartyName: string, periodTo: string) => `請求書_${safeFileName(billingPartyName)}_${periodTo.slice(0, 4)}${periodTo.slice(5, 7)}.pdf`;
const PDF = 'application/pdf';

@Injectable()
export class PdfService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly jobs: JobsService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {}

  onModuleInit() {
    this.jobs.register('PDF_SLIP', async (p) => { await this.renderSlip(String(p.slipId)); });
    this.jobs.register('PDF_INVOICE', async (p) => { await this.renderInvoice(String(p.invoiceId)); });
  }

  /* ---------------------------------------------------------------- RPT-01 受入日報 */
  async dailyReport(date: string, printedBy: string) {
    const st = await this.settings.get();
    const rep = await this.prisma.dailyReport.findUnique({ where: { reportDate: new Date(`${date}T00:00:00Z`) } });
    const rows = rep ? await this.prisma.$queryRaw<{ id: string; customer_id: string; customer_name: string; site_name: string | null; vehicle_no: string; item_label: string; vc_name: string }[]>`
      SELECT r.id, r.customer_id, c.name AS customer_name, s.name AS site_name, v.vehicle_no, i.report_label AS item_label, vc.name AS vc_name
      FROM report_rows r JOIN customers c ON c.id = r.customer_id LEFT JOIN sites s ON s.id = r.site_id
      JOIN vehicles v ON v.id = r.vehicle_id JOIN items i ON i.id = r.item_id JOIN vehicle_classes vc ON vc.id = r.vehicle_class_id
      WHERE r.daily_report_id = ${rep.id}::uuid AND r.deleted_at IS NULL
      ORDER BY c.sort_order, c.kana, r.sort_order, r.created_at` : [];
    const trips = rep ? await this.prisma.$queryRaw<{ report_row_id: string; trip_time: Date; symbol: string | null; status: string }[]>`
      SELECT t.report_row_id, t.trip_time, m.symbol, t.status FROM trips t LEFT JOIN marks m ON m.id = t.mark_id
      WHERE t.daily_report_id = ${rep.id}::uuid AND t.status = 'ACTIVE' ORDER BY t.trip_time, t.created_at` : [];
    const counts = tripCounts(rows.map((r) => ({ id: r.id, customerId: r.customer_id })), trips.map((t) => ({ rowId: t.report_row_id, status: t.status })));
    const buf = await dailyReportPdf({
      date, companyName: st.companyName, officeName: st.officeName, firstHour: st.reportFirstHour, lastHour: st.reportLastHour,
      printedAt: jst().iso.slice(0, 16).replace('T', ' '), printedBy,
      rows: rows.map((r) => ({
        customerName: r.customer_name, siteName: r.site_name, vehicleNo: r.vehicle_no, itemLabel: `${r.item_label}${r.vc_name}`, customerId: r.customer_id,
        trips: trips.filter((t) => t.report_row_id === r.id).map((t) => ({ time: hhmm(t.trip_time), markSymbol: t.symbol })),
      })),
      countByCustomer: counts.byCustomer, total: counts.total,
    });
    const key = `reports/${date}/${now().getTime()}.pdf`;
    await this.storage.put(key, buf, PDF);
    return this.storage.signedUrl(key, `受入日報_${date.replace(/-/g, '')}.pdf`, PDF);
  }

  /* ---------------------------------------------------------------- RPT-02/03/04 伝票 */
  async slipInput(id: string, db: Tx | PrismaService = this.prisma): Promise<SlipPdfInput & { status: string }> {
    const s = await db.slip.findUnique({ where: { id } });
    if (!s) throw new AppError('NOT_FOUND', '伝票が見つかりません');
    const st = await this.settings.get(db);
    const lines = await db.slipLine.findMany({ where: { slipId: id }, orderBy: { lineNo: 'asc' } });
    const bp = await db.billingParty.findUnique({ where: { id: s.billingPartyId } });
    const sig = s.signatureObjectKey ? await this.storage.get(s.signatureObjectKey) : null;
    return {
      status: s.status, slipNo: s.slipNo, slipDate: ymd(s.slipDate), addresseeName: s.addresseeName, siteName: s.siteName,
      billingPartyName: bp && bp.name !== s.addresseeName ? bp.name : null,
      lines: lines.map((l) => ({ itemLabel: l.itemLabel, tripCount: l.tripCount, vehicleNos: l.vehicleNos })),
      signaturePng: sig, signedAt: s.signedAt ? jst(s.signedAt).iso.slice(0, 16).replace('T', ' ').replace(/-/g, '/') : null,
      companyName: st.companyName, officeName: st.officeName, tel: st.tel,
    };
  }
  /** サイン済の伝票：フジモト様控え（RPT-03、ハッシュを記録）とお客さま控え（RPT-02） */
  async renderSlip(id: string) {
    const x = await this.slipInput(id);
    if (x.status !== 'SIGNED') return;
    const office = await slipPdf(x, ['office']);
    const customer = await slipPdf(x, ['customer']);
    const key = `slips/${id}/office.pdf`;
    await this.storage.put(key, office, PDF);
    await this.storage.put(`slips/${id}/customer.pdf`, customer, PDF);
    await this.prisma.$executeRaw`UPDATE slips SET pdf_object_key = ${key}, pdf_sha256 = ${sha256(office)} WHERE id = ${id}::uuid`;
  }
  /** 紙伝票（RPT-04）：サイン欄が空の2枚（お客さま控え・フジモト様控え） */
  async renderPaperSlip(id: string, db: Tx | PrismaService = this.prisma) {
    const x = await this.slipInput(id, db);
    const buf = await slipPdf({ ...x, signaturePng: null, signedAt: null }, ['paper-customer', 'paper-office']);
    const key = `slips/${id}/paper.pdf`;
    await this.storage.put(key, buf, PDF);
    return { key, fileName: `紙伝票_${x.slipNo}.pdf` };
  }
  signedUrl(key: string, fileName: string, type = PDF) { return this.storage.signedUrl(key, fileName, type); }
  exists(key: string) { return this.storage.exists(key); }
  put(key: string, data: Buffer, type: string) { return this.storage.put(key, data, type); }
  get(key: string) { return this.storage.get(key); }

  /* ---------------------------------------------------------------- RPT-05 請求書 */
  /** 請求書の PDF を作って保存する。送信済（SENDING 以降）・取消のものは作り直さない（02 6.3） */
  async renderInvoice(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv || !['DRAFT', 'NEEDS_RECHECK', 'CONFIRMED'].includes(inv.status)) return;
    const st = await this.settings.get();
    const lines = await this.prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { lineNo: 'asc' } });
    const orig = inv.replacesInvoiceId ? await this.prisma.invoice.findUnique({ where: { id: inv.replacesInvoiceId } }) : null;
    const buf = await invoicePdf({
      invoiceNo: inv.invoiceNo, issueDate: ymd(inv.issueDate), dueDate: ymd(inv.dueDate), periodFrom: ymd(inv.periodFrom), periodTo: ymd(inv.periodTo),
      billingPartyName: inv.billingPartyName, honorific: inv.billingPartyHonorific, postalCode: inv.billingPartyPostal, address: inv.billingPartyAddress,
      replacesInvoiceNo: orig?.invoiceNo ?? null,
      lines: lines.map((l) => ({ siteId: l.siteId, siteName: l.siteName, itemName: l.itemName, vehicleClassName: l.vehicleClassName, tripCount: l.tripCount, unitPrice: l.unitPrice, amount: big(l.amount) })),
      subtotal: big(inv.subtotal), taxRate: inv.taxRate, taxAmount: big(inv.taxAmount), total: big(inv.total),
      issuer: { companyName: st.companyName, officeName: st.officeName, postalCode: st.postalCode, address: st.address, tel: st.tel, fax: st.fax, registrationNo: st.invoiceRegistrationNo, bankAccountText: st.bankAccountText, note: st.invoiceNote },
    });
    const key = `invoices/${id}/${inv.invoiceNo}-v${inv.version}-${now().getTime()}.pdf`;
    await this.storage.put(key, buf, PDF);
    // 作っている間に状態・内容が変わっていたら書かない（次の作成に任せる）
    await this.prisma.$executeRaw`UPDATE invoices SET pdf_object_key = ${key}, pdf_sha256 = ${sha256(buf)}
      WHERE id = ${id}::uuid AND status IN ('DRAFT','NEEDS_RECHECK','CONFIRMED') AND version = ${inv.version}`;
  }

  /** その場で作り、失敗したらジョブで再試行する */
  async renderInvoiceOrQueue(id: string) {
    try { await this.renderInvoice(id); }
    catch { await this.jobs.enqueue(this.prisma, 'PDF_INVOICE', { invoiceId: id }, { dedupeKey: `PDF_INVOICE:${id}`, runAfter: new Date(now().getTime() + 60000) }); }
  }
  async renderSlipOrQueue(id: string) {
    try { await this.renderSlip(id); }
    catch { await this.jobs.enqueue(this.prisma, 'PDF_SLIP', { slipId: id }, { dedupeKey: `PDF_SLIP:${id}`, runAfter: new Date(now().getTime() + 60000) }); }
  }
}

@Global()
@Module({ providers: [PdfService], exports: [PdfService] })
export class PdfModule {}
