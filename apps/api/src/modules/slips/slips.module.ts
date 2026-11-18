/* 伝票（FR-SLP、SCR-14・15・32）とサイン端末（FR-SGN、SCR-20〜22） */
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { Actor, CurrentActor, isOffice, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { isoJst, now, todayJst, toDate, ymd } from '../../common/dates';
import { INVOICE_LOCKING, markInvoicesRecheck, nextSlipNo, touchTrips } from '../../common/domain';
import { AppError, conflict, invalidState, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse, zDate, zUuid } from '../../common/validation';
import { PdfService, sha256, slipFileName } from '../pdf/pdf.module';
import { dbNow, decodeCursor, encodeCursor } from '../reports/reports.module';

const STATUS_JA: Record<string, string> = { DRAFT: '発行済', AWAITING_SIGNATURE: 'サイン待ち', SIGNED: 'サイン済', PAPER_PRINTED: '紙伝票', PAPER_SIGNED: '紙伝票（スキャン済）', CANCELLED: '取消' };
const natural = (a: string, b: string) => a.localeCompare(b, 'ja', { numeric: true });

@Injectable()
export class SlipsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pdf: PdfService) {}

  /* ---------------------------------------------------------------- 出力 */
  async dto(db: Tx | PrismaService, ids: string[]) {
    if (!ids.length) return [];
    const slips = await db.slip.findMany({ where: { id: { in: ids } }, orderBy: [{ slipDate: 'desc' }, { slipNo: 'desc' }] });
    const lines = await db.slipLine.findMany({ where: { slipId: { in: ids } }, orderBy: [{ slipId: 'asc' }, { lineNo: 'asc' }] });
    const trips = await db.$queryRaw<{ id: string; slip_id: string; inv: string | null }[]>`
      SELECT t.id, t.slip_id, i.status AS inv FROM trips t LEFT JOIN invoices i ON i.id = t.invoice_id WHERE t.slip_id = ANY(${ids}::uuid[]) AND t.status = 'ACTIVE' ORDER BY t.trip_time, t.id`;
    const bps = await db.billingParty.findMany({ where: { id: { in: slips.map((s) => s.billingPartyId) } }, select: { id: true, name: true } });
    return slips.map((s) => ({
      id: s.id, slipNo: s.slipNo, slipDate: ymd(s.slipDate), status: s.status, customerId: s.customerId, addresseeName: s.addresseeName,
      siteId: s.siteId, siteName: s.siteName, billingPartyId: s.billingPartyId, billingPartyName: bps.find((b) => b.id === s.billingPartyId)?.name ?? '',
      billingPartyChanged: s.billingPartyId !== s.defaultBillingPartyId, billingChangeReason: s.billingChangeReason,
      lines: lines.filter((l) => l.slipId === s.id).map((l) => ({ lineNo: l.lineNo, itemLabel: l.itemLabel, tripCount: l.tripCount, vehicleNos: l.vehicleNos })),
      tripIds: trips.filter((t) => t.slip_id === s.id).map((t) => t.id),
      terminalUserId: s.terminalUserId, sentToTerminalAt: isoJst(s.sentToTerminalAt), signerName: s.signerName,
      signedAt: isoJst(s.signedAt), hasPaperScan: !!s.paperScanObjectKey,
      lockedByInvoice: trips.some((t) => t.slip_id === s.id && t.inv !== null && INVOICE_LOCKING.includes(t.inv)),
      cancelReason: s.cancelReason, version: s.version,
    }));
  }
  async one(db: Tx | PrismaService, id: string) {
    const [d] = await this.dto(db, [id]);
    if (!d) throw notFound('伝票');
    return d;
  }
  get(id: string) { return this.one(this.prisma, parse(zUuid, id)); }
  terminalDto(s: Awaited<ReturnType<SlipsService['one']>>) {
    // 金額・請求先を含めない（FR-SGN-02）
    return { id: s.id, slipNo: s.slipNo, slipDate: s.slipDate, addresseeName: s.addresseeName, siteName: s.siteName, lines: s.lines, status: s.status };
  }

  /* ---------------------------------------------------------------- 一覧（FR-SLP-12） */
  async list(actor: Actor, query: Record<string, unknown>) {
    const q = parse(z.object({
      date: zDate.optional(), from: zDate.optional(), to: zDate.optional(), customerId: zUuid.optional(), since: z.string().optional(),
      status: z.enum(['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED', 'PAPER_PRINTED', 'PAPER_SIGNED', 'CANCELLED']).optional(),
    }), query);
    // 受付は当日だけ
    const date = !isOffice(actor) ? todayJst() : q.date;
    const from = date ?? q.from ?? todayJst(), to = date ?? q.to ?? from;
    const since = q.since ? decodeCursor(q.since) : null;
    const cursor = encodeCursor(await dbNow(this.prisma));
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM slips WHERE slip_date BETWEEN ${from}::date AND ${to}::date
        AND (${q.status ?? null}::text IS NULL OR status = ${q.status ?? null})
        AND (${q.customerId ?? null}::uuid IS NULL OR customer_id = ${q.customerId ?? null}::uuid)
        AND (${since}::timestamptz IS NULL OR updated_at > ${since}::timestamptz)
      ORDER BY slip_date DESC, slip_no DESC LIMIT 1000`;
    const unslipped = await this.prisma.$queryRaw<{ customer_id: string; customer_name: string; site_id: string | null; site_name: string | null; n: bigint }[]>`
      SELECT r.customer_id, c.name AS customer_name, r.site_id, st.name AS site_name, count(*) AS n
      FROM trips t JOIN report_rows r ON r.id = t.report_row_id JOIN customers c ON c.id = r.customer_id LEFT JOIN sites st ON st.id = r.site_id
      LEFT JOIN slips s ON s.id = t.slip_id
      WHERE t.status = 'ACTIVE' AND t.trip_date BETWEEN ${from}::date AND ${to}::date AND (t.slip_id IS NULL OR s.status = 'CANCELLED')
        AND (${q.customerId ?? null}::uuid IS NULL OR r.customer_id = ${q.customerId ?? null}::uuid)
      GROUP BY r.customer_id, c.name, c.sort_order, c.kana, r.site_id, st.name, st.kana ORDER BY c.sort_order, c.kana, st.kana NULLS FIRST`;
    return {
      items: await this.dto(this.prisma, rows.map((r) => r.id)), cursor,
      unslipped: unslipped.map((u) => ({ customerId: u.customer_id, customerName: u.customer_name, siteId: u.site_id, siteName: u.site_name, tripCount: Number(u.n) })),
    };
  }

  /* ---------------------------------------------------------------- 発行（FR-SLP-01〜04） */
  async create(actor: Actor, body: unknown) {
    const b = parse(z.object({
      date: zDate, customerId: zUuid, siteId: zUuid.nullable().optional(), tripIds: z.array(zUuid).max(500).optional(),
      billingPartyId: zUuid.optional(), billingChangeReason: z.string().trim().max(200).optional(),
    }).strict(), body);
    const id = await this.prisma.tx(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: b.customerId } });
      if (!customer) throw notFound('客先');
      const site = b.siteId ? await tx.site.findUnique({ where: { id: b.siteId } }) : null;
      if (b.siteId && (!site || site.customerId !== b.customerId)) throw new AppError('VALIDATION_ERROR', 'この客先の現場ではありません');
      // 伝票にできる便：その日・その客先・現場の有効な便で、伝票（取消以外）に入っておらず、送信済の請求書に含まれていないもの
      const cand = await tx.$queryRaw<{ id: string; locked_inv: boolean }[]>`
        SELECT t.id, (i.status IS NOT NULL AND i.status IN ('SENDING','SENT','SEND_ERROR')) AS locked_inv
        FROM trips t JOIN report_rows r ON r.id = t.report_row_id LEFT JOIN slips s ON s.id = t.slip_id LEFT JOIN invoices i ON i.id = t.invoice_id
        WHERE t.trip_date = ${b.date}::date AND t.status = 'ACTIVE' AND r.customer_id = ${b.customerId}::uuid
          AND r.site_id IS NOT DISTINCT FROM ${b.siteId ?? null}::uuid AND (t.slip_id IS NULL OR s.status = 'CANCELLED')
        FOR UPDATE OF t`;
      let tripIds: string[];
      if (b.tripIds?.length) {
        const ok = new Map(cand.map((c) => [c.id, c]));
        const bad = b.tripIds.filter((x) => !ok.has(x));
        if (bad.length) throw new AppError('VALIDATION_ERROR', '伝票にできない便が含まれています（別の伝票に入っている・別の客先や現場・取消など）', { tripIds: bad });
        if (b.tripIds.some((x) => ok.get(x)!.locked_inv)) throw new AppError('TRIP_LOCKED_BY_INVOICE');
        tripIds = [...new Set(b.tripIds)];
      } else tripIds = cand.filter((c) => !c.locked_inv).map((c) => c.id);
      if (!tripIds.length) throw new AppError('NO_TRIPS_FOR_SLIP', '伝票にする便がありません');

      const defaultBp = site?.defaultBillingPartyId ?? customer.defaultBillingPartyId;
      const bpId = b.billingPartyId ?? defaultBp;
      const bp = await tx.billingParty.findUnique({ where: { id: bpId } });
      if (!bp?.active) throw new AppError('VALIDATION_ERROR', '請求先が見つかりません');
      const slipNo = await nextSlipNo(tx, b.date);
      const s = await tx.slip.create({
        data: {
          slipNo, slipDate: toDate(b.date), customerId: b.customerId, siteId: b.siteId ?? null, addresseeName: customer.name, siteName: site?.name ?? null,
          billingPartyId: bpId, defaultBillingPartyId: defaultBp, billingChangeReason: bpId !== defaultBp ? b.billingChangeReason ?? null : null, createdBy: actor.id,
        },
      });
      await this.writeLines(tx, s.id, tripIds);
      await tx.$executeRaw`UPDATE trips SET slip_id = ${s.id}::uuid WHERE id = ANY(${tripIds}::uuid[])`;
      if (bpId !== defaultBp) await markInvoicesRecheck(tx, tripIds);
      await this.audit.write(tx, actor, {
        action: 'SLIP_CREATE', targetType: 'slip', targetId: s.id,
        summary: `伝票 ${slipNo} を発行（${customer.name}${site ? '・' + site.name : ''}、${tripIds.length} 台${bpId !== defaultBp ? `、請求先：${bp.name}` : ''}）`,
        after: { slipNo, tripIds, billingPartyId: bpId, defaultBillingPartyId: defaultBp }, reason: bpId !== defaultBp ? b.billingChangeReason ?? null : null,
      });
      return s.id;
    });
    return this.one(this.prisma, id);
  }

  /** 明細：便の品目×車格ごとに1行（10 3章） */
  private async writeLines(tx: Tx, slipId: string, tripIds: string[]) {
    const g = await tx.$queryRaw<{ item_id: string; vc_id: string; label: string; price_name: string; vc_name: string; n: bigint; nos: string[] }[]>`
      SELECT t.effective_item_id AS item_id, r.vehicle_class_id AS vc_id, i.report_label AS label, i.price_item_name AS price_name, vc.name AS vc_name,
             count(*) AS n, array_agg(DISTINCT v.vehicle_no) AS nos
      FROM trips t JOIN report_rows r ON r.id = t.report_row_id JOIN items i ON i.id = t.effective_item_id
      JOIN vehicle_classes vc ON vc.id = r.vehicle_class_id JOIN vehicles v ON v.id = r.vehicle_id
      WHERE t.id = ANY(${tripIds}::uuid[])
      GROUP BY t.effective_item_id, r.vehicle_class_id, i.report_label, i.price_item_name, i.sort_order, vc.name, vc.sort_order ORDER BY i.sort_order, vc.sort_order`;
    await tx.slipLine.deleteMany({ where: { slipId } });
    await tx.slipLine.createMany({
      data: g.map((x, k) => ({
        slipId, lineNo: k + 1, itemId: x.item_id, vehicleClassId: x.vc_id, tripCount: Number(x.n),
        itemLabel: `${x.label}${x.label === x.price_name ? '' : `（${x.price_name}）`}${x.vc_name}`, vehicleNos: [...x.nos].sort(natural).join('・'),
      })),
    });
  }

  private async load(tx: Tx, id: string) {
    parse(zUuid, id);
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM slips WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound('伝票');
    return tx.slip.findUniqueOrThrow({ where: { id } });
  }

  /* ---------------------------------------------------------------- 請求先の変更（FR-SLP-04） */
  async changeBillingParty(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), billingPartyId: zUuid, billingChangeReason: z.string().trim().max(200).optional() }).strict(), body);
    await this.prisma.tx(async (tx) => {
      const s = await this.load(tx, id);
      if (!['DRAFT', 'AWAITING_SIGNATURE'].includes(s.status)) throw invalidState(`${STATUS_JA[s.status]}の伝票は請求先を変えられません`);
      const bp = await tx.billingParty.findUnique({ where: { id: b.billingPartyId } });
      if (!bp?.active) throw new AppError('VALIDATION_ERROR', '請求先が見つかりません');
      const old = await tx.billingParty.findUnique({ where: { id: s.billingPartyId } });
      const r = await tx.slip.updateMany({ where: { id, version: b.version }, data: { billingPartyId: b.billingPartyId, billingChangeReason: b.billingPartyId !== s.defaultBillingPartyId ? b.billingChangeReason ?? null : null } });
      if (!r.count) throw conflict();
      const tripIds = (await tx.trip.findMany({ where: { slipId: id }, select: { id: true } })).map((t) => t.id);
      await markInvoicesRecheck(tx, tripIds);
      await this.audit.write(tx, actor, {
        action: 'SLIP_BILLING_CHANGE', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} の請求先を変更（${old?.name} → ${bp.name}）`,
        before: { billingPartyId: s.billingPartyId, name: old?.name }, after: { billingPartyId: bp.id, name: bp.name }, reason: b.billingChangeReason ?? null,
      });
    });
    return this.one(this.prisma, id);
  }

  /* ---------------------------------------------------------------- タブレットへ送る・取りやめ（FR-SLP-05、FR-SGN-05） */
  async sendToTerminal(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ terminalId: zUuid.optional() }).strict(), body ?? {});
    const terminalId = b.terminalId ?? actor.pairedTerminalId;
    if (!terminalId) throw new AppError('VALIDATION_ERROR', '送り先のサイン用タブレットが決まっていません（利用者の「対の端末」を設定してください）');
    await this.prisma.tx(async (tx) => {
      const s = await this.load(tx, id);
      if (s.status !== 'DRAFT') throw invalidState(`${STATUS_JA[s.status]}の伝票はタブレットへ送れません`);
      const t = await tx.user.findUnique({ where: { id: terminalId } });
      if (!t || t.role !== 'SIGN_TERMINAL' || !t.active) throw new AppError('VALIDATION_ERROR', 'サイン用タブレットが見つかりません');
      const busy = await tx.slip.findFirst({ where: { terminalUserId: terminalId, status: 'AWAITING_SIGNATURE' } });
      if (busy) throw new AppError('TERMINAL_BUSY', `タブレットに別の伝票（${busy.slipNo}）がサイン待ちです。先に取りやめるかサインを済ませてください`, { slipId: busy.id });
      await tx.slip.update({ where: { id }, data: { status: 'AWAITING_SIGNATURE', terminalUserId: terminalId, sentToTerminalAt: now() } });
      await touchTrips(tx, { slipId: id });
      await this.audit.write(tx, actor, { action: 'SLIP_SEND', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} をサイン用タブレット（${t.name}）へ送った` });
    }).catch((e) => { if (String((e as Error).message).includes('ux_slips_one_awaiting_per_terminal')) throw new AppError('TERMINAL_BUSY', 'タブレットに別の伝票がサイン待ちです'); throw e; });
    return this.one(this.prisma, id);
  }
  async withdraw(actor: Actor, id: string) {
    await this.prisma.tx(async (tx) => {
      const s = await this.load(tx, id);
      if (s.status !== 'AWAITING_SIGNATURE') throw invalidState(`${STATUS_JA[s.status]}の伝票は取りやめられません`);
      await tx.slip.update({ where: { id }, data: { status: 'DRAFT', terminalUserId: null, sentToTerminalAt: null } });
      await touchTrips(tx, { slipId: id });
      await this.audit.write(tx, actor, { action: 'SLIP_WITHDRAW', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} のタブレットへの送信を取りやめた` });
    });
    return this.one(this.prisma, id);
  }

  /* ---------------------------------------------------------------- 紙伝票（FR-SLP-11） */
  async printPaper(actor: Actor, id: string) {
    const file = await this.prisma.tx(async (tx) => {
      const s = await this.load(tx, id);
      if (!['DRAFT', 'AWAITING_SIGNATURE', 'PAPER_PRINTED'].includes(s.status)) throw invalidState(`${STATUS_JA[s.status]}の伝票は紙伝票にできません`);
      await tx.slip.update({ where: { id }, data: { status: 'PAPER_PRINTED', terminalUserId: null } });
      await touchTrips(tx, { slipId: id });
      const f = await this.pdf.renderPaperSlip(id, tx);
      await this.audit.write(tx, actor, { action: 'SLIP_PAPER_PRINT', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} を紙伝票で印刷${s.status === 'PAPER_PRINTED' ? '（印刷し直し）' : ''}` });
      return f;
    });
    return this.pdf.signedUrl(file.key, file.fileName);
  }
  async paperScan(actor: Actor, id: string, file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length) throw new AppError('VALIDATION_ERROR', 'PDF ファイルを選んでください');
    if (file.size > 20 * 1024 * 1024) throw new AppError('VALIDATION_ERROR', 'PDF は 20MB までです');
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError('VALIDATION_ERROR', 'PDF ファイルではありません');
    await this.prisma.tx(async (tx) => {
      const s = await this.load(tx, id);
      if (!['PAPER_PRINTED', 'PAPER_SIGNED'].includes(s.status)) throw invalidState('紙伝票で印刷した伝票だけスキャンを登録できます');
      const key = `slips/${id}/scan-${now().getTime()}.pdf`;
      await this.pdf.put(key, file.buffer, 'application/pdf');
      await tx.slip.update({ where: { id }, data: { status: 'PAPER_SIGNED', paperScanObjectKey: key, paperRegisteredAt: now(), paperRegisteredBy: actor.id, pdfSha256: sha256(file.buffer), pdfObjectKey: key } });
      await this.audit.write(tx, actor, { action: 'SLIP_PAPER_SCAN', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} の紙伝票のスキャンを登録${s.status === 'PAPER_SIGNED' ? '（登録し直し）' : ''}`, after: { sha256: sha256(file.buffer), size: file.size } });
    });
    return this.one(this.prisma, id);
  }

  /* ---------------------------------------------------------------- 取消（FR-SLP-10） */
  async cancel(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), reason: z.string().trim().min(1, '理由を入れてください').max(200) }).strict(), body);
    await this.prisma.tx(async (tx) => {
      const s = await this.load(tx, id);
      if (s.status === 'CANCELLED') throw invalidState('すでに取り消した伝票です');
      if (s.status === 'AWAITING_SIGNATURE') throw invalidState('サイン待ちの伝票は、先にタブレットへの送信を取りやめてください');
      const locked = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM trips t JOIN invoices i ON i.id = t.invoice_id WHERE t.slip_id = ${id}::uuid AND i.status IN ('SENDING','SENT','SEND_ERROR')`;
      if (Number(locked[0].n)) throw new AppError('SLIP_LOCKED_BY_INVOICE', '送信済の請求書に含まれる便がある伝票は取り消せません。先に請求書を取り消してください');
      const r = await tx.slip.updateMany({ where: { id, version: b.version }, data: { status: 'CANCELLED', cancelReason: b.reason, cancelledAt: now(), cancelledBy: actor.id, terminalUserId: null } });
      if (!r.count) throw conflict();
      const tripIds = (await tx.trip.findMany({ where: { slipId: id }, select: { id: true } })).map((t) => t.id);
      await touchTrips(tx, { slipId: id });
      await markInvoicesRecheck(tx, tripIds);
      await this.audit.write(tx, actor, { action: 'SLIP_CANCEL', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} を取消（${STATUS_JA[s.status]}）`, reason: b.reason, before: { status: s.status } });
    });
    return this.one(this.prisma, id);
  }

  /* ---------------------------------------------------------------- PDF
   * kind：signed＝お客さま控え（RPT-02、受付で印刷）、office＝フジモト様控え（RPT-03、保存した原本）、scan＝紙伝票のスキャン、paper＝紙伝票（RPT-04） */
  async pdfUrl(actor: Actor, id: string, kind = 'signed') {
    const s = await this.prisma.slip.findUnique({ where: { id: parse(zUuid, id) } });
    if (!s) throw notFound('伝票');
    if (kind === 'scan') {
      if (!s.paperScanObjectKey) throw new AppError('NOT_FOUND', 'スキャンが登録されていません');
      return this.pdf.signedUrl(s.paperScanObjectKey, `伝票_${s.slipNo}_スキャン.pdf`);
    }
    if (kind === 'paper') {
      const key = `slips/${id}/paper.pdf`;
      if (!(await this.pdf.exists(key))) throw new AppError('NOT_FOUND', '紙伝票を印刷していません');
      return this.pdf.signedUrl(key, `紙伝票_${s.slipNo}.pdf`);
    }
    if (!['signed', 'office'].includes(kind)) throw new AppError('VALIDATION_ERROR', 'kind は signed・office・scan・paper');
    if (s.status !== 'SIGNED') throw new AppError('NOT_FOUND', 'サイン済の伝票だけ PDF があります');
    if (!s.pdfObjectKey) { await this.pdf.renderSlip(id); }
    const key = kind === 'office' ? `slips/${id}/office.pdf` : `slips/${id}/customer.pdf`;
    if (!(await this.pdf.exists(key))) throw new AppError('NOT_FOUND', 'PDF を作成中です。少し待ってから開いてください');
    return this.pdf.signedUrl(key, kind === 'office' ? slipFileName(s.slipNo).replace('.pdf', '_控え.pdf') : slipFileName(s.slipNo));
  }

  /* ---------------------------------------------------------------- サイン端末 */
  async currentSlip(actor: Actor) {
    const s = await this.prisma.slip.findFirst({ where: { terminalUserId: actor.id, status: 'AWAITING_SIGNATURE' } });
    return { slip: s ? this.terminalDto(await this.one(this.prisma, s.id)) : null };
  }
  async sign(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ signaturePng: z.string().min(10).max(300000), strokeCount: z.number().int().min(1).max(10000), signerName: z.string().trim().max(40).optional() }).strict(), body);
    const png = Buffer.from(b.signaturePng.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (png.length > 200 * 1024) throw new AppError('VALIDATION_ERROR', 'サインの画像が大きすぎます（200KB まで）');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString('latin1') !== 'IHDR') throw new AppError('VALIDATION_ERROR', 'サインの画像が PNG ではありません');
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w < 1 || h < 1 || w > 1200 || h > 400) throw new AppError('VALIDATION_ERROR', 'サインの画像は 1200×400 までです');
    await this.prisma.tx(async (tx) => {
      parse(zUuid, id);
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM slips WHERE id = ${id}::uuid FOR UPDATE`;
      const s = rows.length ? await tx.slip.findUniqueOrThrow({ where: { id } }) : null;
      if (!s || s.status !== 'AWAITING_SIGNATURE' || s.terminalUserId !== actor.id) throw new AppError('SLIP_NOT_AWAITING', 'この伝票はサイン待ちではありません（取りやめ・確定済み）');
      const key = `slips/${id}/signature.png`;
      await this.pdf.put(key, png, 'image/png');
      await tx.slip.update({ where: { id }, data: { status: 'SIGNED', signatureObjectKey: key, signedAt: now(), signerName: b.signerName ?? null } });
      await touchTrips(tx, { slipId: id });
      await this.audit.write(tx, actor, { action: 'SLIP_SIGN', targetType: 'slip', targetId: id, summary: `伝票 ${s.slipNo} にサイン（${s.addresseeName}${b.signerName ? '・' + b.signerName : ''}）`, after: { strokeCount: b.strokeCount, width: w, height: h } });
    });
    await this.pdf.renderSlipOrQueue(id);
    return this.terminalDto(await this.one(this.prisma, id));
  }
}

const R = ['RECEPTION', 'OFFICE', 'ADMIN'] as const;
@Controller()
export class SlipsController {
  constructor(private readonly s: SlipsService) {}
  @Get('slips') @Roles(...R) list(@CurrentActor() a: Actor, @Query() q: Record<string, unknown>) { return this.s.list(a, q); }
  @Post('slips') @Roles(...R) create(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.create(a, b); }
  @Get('slips/:id') @Roles(...R) get(@Param('id') id: string) { return this.s.get(id); }
  @Patch('slips/:id') @Roles(...R) patch(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.changeBillingParty(a, id, b); }
  @Post('slips/:id/send-to-terminal') @Roles(...R) @HttpCode(200) send(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.sendToTerminal(a, id, b); }
  @Post('slips/:id/withdraw') @Roles(...R) @HttpCode(200) withdraw(@CurrentActor() a: Actor, @Param('id') id: string) { return this.s.withdraw(a, id); }
  @Post('slips/:id/print-paper') @Roles(...R) @HttpCode(200) paper(@CurrentActor() a: Actor, @Param('id') id: string) { return this.s.printPaper(a, id); }
  @Post('slips/:id/paper-scan') @Roles('OFFICE', 'ADMIN') @HttpCode(200) @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  scan(@CurrentActor() a: Actor, @Param('id') id: string, @UploadedFile() f?: Express.Multer.File) { return this.s.paperScan(a, id, f); }
  @Post('slips/:id/cancel') @Roles(...R) @HttpCode(200) cancel(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.cancel(a, id, b); }
  @Get('slips/:id/pdf') @Roles(...R) pdf(@CurrentActor() a: Actor, @Param('id') id: string, @Query('kind') kind?: string) { return this.s.pdfUrl(a, id, kind); }

  @Get('terminal/current-slip') @Roles('SIGN_TERMINAL') current(@CurrentActor() a: Actor) { return this.s.currentSlip(a); }
  @Post('terminal/slips/:id/sign') @Roles('SIGN_TERMINAL') @HttpCode(200) sign(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.sign(a, id, b); }
}

@Module({ providers: [SlipsService], controllers: [SlipsController], exports: [SlipsService] })
export class SlipsModule {}
