/* 請求書のメール送信（FR-MAL、09 5章、08 7.2） */
import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Module, OnModuleInit, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { MAIL, MailAdapter, MailError } from '../../adapters/mail';
import { Actor, CurrentActor, Public, Roles, systemActor } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { isoJst, jdateShort, now, ymd } from '../../common/dates';
import { big, touchTrips, yen } from '../../common/domain';
import { AppError, invalidState, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { parse, zUuid } from '../../common/validation';
import { FreeeModule, FreeeService } from '../freee/freee.module';
import { JobsService, RetryLater } from '../jobs/jobs.module';
import { invoiceFileName, PdfService, sha256 } from '../pdf/pdf.module';
import { SettingsService } from '../settings/settings.module';
import type { Invoice } from '../../generated/prisma/client';

/** 件名・本文のひな形への差し込み（09 5章） */
export function fillTemplate(t: string, inv: Invoice, company: string) {
  const to = ymd(inv.periodTo);
  const v: Record<string, string> = {
    company, billing_party: inv.billingPartyName, year: to.slice(0, 4), month: String(Number(to.slice(5, 7))), invoice_no: inv.invoiceNo,
    total: yen(big(inv.total)), due_date: jdateShort(ymd(inv.dueDate)), issue_date: jdateShort(ymd(inv.issueDate)),
  };
  return t.replace(/\{([a-z_]+)\}/g, (m, k: string) => v[k] ?? m);
}

@Injectable()
export class MailService implements OnModuleInit {
  private readonly log = new Logger('Mail');
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly pdf: PdfService,
    private readonly jobs: JobsService, private readonly freee: FreeeService, @Inject(MAIL) private readonly mail: MailAdapter,
  ) {}
  onModuleInit() { this.jobs.register('MAIL_SEND', (p, c) => this.deliver(String(p.mailLogId), c.final)); }

  private async compose(inv: Invoice) {
    const st = await this.settings.get();
    const bp = await this.prisma.billingParty.findUniqueOrThrow({ where: { id: inv.billingPartyId } });
    const company = `${st.companyName}${st.officeName ? ' ' + st.officeName : ''}`;
    return {
      st, bp, to: bp.mailTo, cc: bp.mailCc.filter((c) => !bp.mailTo.includes(c)),
      subject: fillTemplate(st.mailSubjectTemplate, inv, st.companyName), body: fillTemplate(st.mailBodyTemplate, inv, company),
      attachmentName: invoiceFileName(inv.billingPartyName, ymd(inv.periodTo)),
    };
  }

  /* ---------------------------------------------------------------- 送信前の確認（FR-MAL-02、FR-FRE-22） */
  async preview(body: unknown) {
    const { invoiceIds } = parse(z.object({ invoiceIds: z.array(zUuid).min(1).max(100) }).strict(), body);
    const conn = await this.prisma.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
    const out = [];
    for (const id of invoiceIds) {
      const inv = await this.prisma.invoice.findUnique({ where: { id } });
      if (!inv) throw notFound('請求書');
      const c = await this.compose(inv);
      const warnings: string[] = [];
      if (!c.to.length) warnings.push('MAIL_TO_MISSING');
      if (!['CONFIRMED', 'SEND_ERROR'].includes(inv.status)) warnings.push('NOT_CONFIRMED');
      if (conn.status !== 'DISCONNECTED') {
        if (!c.bp.freeePartnerId || ['UNMAPPED', 'CANDIDATE'].includes(c.bp.freeeMappingStatus)) warnings.push('FREEE_PARTNER_UNMAPPED');
        const un = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM invoice_lines l JOIN items i ON i.id = l.item_id WHERE l.invoice_id = ${id}::uuid AND (i.freee_account_item_id IS NULL OR i.freee_tax_code IS NULL)`;
        if (Number(un[0].n)) warnings.push('FREEE_ITEM_UNMAPPED');
      }
      out.push({ invoiceId: id, invoiceNo: inv.invoiceNo, status: inv.status, to: c.to, cc: c.cc, subject: c.subject, body: c.body, attachmentName: c.attachmentName, hasPdf: !!inv.pdfObjectKey, warnings });
    }
    return { items: out };
  }

  /* ---------------------------------------------------------------- 送信（08 7.2） */
  async send(actor: Actor, body: unknown) {
    const { invoiceIds } = parse(z.object({ invoiceIds: z.array(zUuid).min(1).max(100) }).strict(), body);
    const results = [];
    for (const id of [...new Set(invoiceIds)]) {
      try { results.push({ invoiceId: id, status: await this.sendOne(actor, id, 'SEND') }); }
      catch (e) {
        const err = e instanceof AppError ? e : new AppError('INTERNAL');
        if (!(e instanceof AppError)) this.log.error(`送信に失敗 ${id}: ${(e as Error)?.stack}`);
        const cur = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true } });
        results.push({ invoiceId: id, status: cur?.status ?? null, error: { code: err.code, message: err.message } });
      }
    }
    return { results };
  }
  async resend(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ to: z.array(z.string().trim().email()).min(1).max(10).optional(), cc: z.array(z.string().trim().email()).max(10).optional() }).strict(), body ?? {});
    const logId = await this.queue(actor, parse(zUuid, id), 'RESEND', b);
    await this.deliver(logId, false).catch(() => undefined);
    return this.logDto(logId);
  }

  private async sendOne(actor: Actor, id: string, kind: 'SEND') {
    const logId = await this.queue(actor, id, kind, {});
    await this.deliver(logId, false).catch(() => undefined);
    return (await this.prisma.invoice.findUniqueOrThrow({ where: { id } })).status;
  }

  /** 状態を SENDING にし、送信履歴を QUEUED で作る */
  private async queue(actor: Actor, id: string, kind: 'SEND' | 'RESEND', o: { to?: string[]; cc?: string[] }) {
    let inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw notFound('請求書');
    if (kind === 'SEND' && !['CONFIRMED', 'SEND_ERROR'].includes(inv.status)) throw invalidState(inv.status === 'SENT' ? '送信済です（送り直すときは「再送」）' : '確認済の請求書だけ送信できます');
    if (kind === 'RESEND' && !['SENT', 'SEND_ERROR'].includes(inv.status)) throw invalidState('送信済・送信エラーの請求書だけ再送できます');
    if (!inv.pdfObjectKey) {
      if (['CONFIRMED'].includes(inv.status)) { await this.pdf.renderInvoice(id); inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id } }); }
      if (!inv.pdfObjectKey) throw invalidState('請求書の PDF がまだできていません。少し待ってから送信してください');
    }
    const c = await this.compose(inv);
    const to = o.to ?? c.to, cc = o.cc ?? c.cc;
    if (!to.length) throw new AppError('MAIL_TO_MISSING', `請求先「${inv.billingPartyName}」の送付先メールが登録されていません`);
    if (!c.st.mailFromAddress) throw invalidState('送信元のメールアドレスが設定されていません（システム設定）');
    return this.prisma.tx(async (tx) => {
      const r = await tx.invoice.updateMany({ where: { id, status: inv!.status, version: inv!.version }, data: { status: 'SENDING' } });
      if (!r.count) throw new AppError('CONFLICT', '他の人が先に操作しました。読み直してください');
      await touchTrips(tx, { invoiceId: id });
      const log = await tx.mailLog.create({ data: { invoiceId: id, kind, toAddresses: to, ccAddresses: cc, subject: c.subject, body: c.body, attachmentName: c.attachmentName, attachmentSha256: inv!.pdfSha256 ?? '', requestedBy: actor.id } });
      await this.audit.write(tx, actor, { action: kind === 'SEND' ? 'MAIL_SEND' : 'MAIL_RESEND', targetType: 'invoice', targetId: id, summary: `請求書 ${inv!.invoiceNo} を${kind === 'SEND' ? '送信' : '再送'}（${to.join('、')}）`, after: { to, cc, subject: c.subject, mailLogId: log.id } });
      return log.id;
    });
  }

  /** メールサービスへ送る。受け付けられたら SENT と freee 登録、断られたら SEND_ERROR（4xx）、一時的な失敗はジョブで再試行 */
  async deliver(logId: string, final: boolean) {
    const log = await this.prisma.mailLog.findUnique({ where: { id: logId } });
    if (!log || log.status !== 'QUEUED') return;
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: log.invoiceId } });
    if (inv.status !== 'SENDING') { await this.prisma.mailLog.update({ where: { id: logId }, data: { status: 'FAILED', errorMessage: '送信の前に請求書の状態が変わりました', completedAt: now() } }); return; }
    const st = await this.settings.get();
    let messageId: string | null = null;
    try {
      const pdf = await this.pdf.get(inv.pdfObjectKey!);
      if (sha256(pdf) !== inv.pdfSha256) throw new MailError('請求書の PDF のハッシュが記録と一致しません', 0, false);
      ({ messageId } = await this.mail.send({
        from: st.mailFromAddress!, fromName: st.mailFromName, replyTo: st.mailReplyTo, to: log.toAddresses, cc: log.ccAddresses, subject: log.subject, text: log.body,
        attachments: [{ filename: log.attachmentName, content: pdf, type: 'application/pdf' }], customArgs: { mail_log_id: log.id, invoice_id: inv.id },
      }));
    } catch (e) {
      const me = e instanceof MailError ? e : new MailError(String((e as Error)?.message ?? e), 0, true);
      if (me.retryable && !final) {
        await this.prisma.mailLog.update({ where: { id: logId }, data: { errorMessage: me.message.slice(0, 500) } });
        const job = await this.jobs.enqueue(this.prisma, 'MAIL_SEND', { mailLogId: logId }, { dedupeKey: `MAIL_SEND:${logId}`, runAfter: new Date(now().getTime() + 60000) });
        if (job === null) throw new RetryLater(me.message); // ジョブの中から呼ばれた
        return;
      }
      await this.prisma.tx(async (tx) => {
        await tx.mailLog.update({ where: { id: logId }, data: { status: 'FAILED', errorMessage: me.message.slice(0, 500), completedAt: now() } });
        await tx.invoice.update({ where: { id: inv.id }, data: { status: 'SEND_ERROR' } });
        await this.audit.write(tx, systemActor('メール送信'), { action: 'MAIL_FAILED', targetType: 'invoice', targetId: inv.id, summary: `請求書 ${inv.invoiceNo} のメール送信に失敗：${me.message.slice(0, 200)}` });
      });
      return;
    }
    const job = await this.prisma.tx(async (tx) => {
      await tx.mailLog.update({ where: { id: logId }, data: { status: 'SENT', providerMessageId: messageId, completedAt: now(), errorMessage: null } });
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'SENT', sentAt: inv.sentAt ?? now() } });
      return this.freee.ensureRegistration(tx, inv.id);
    });
    await this.jobs.runNow(job).catch(() => undefined);
  }

  async logs(id: string) {
    const ls = await this.prisma.mailLog.findMany({ where: { invoiceId: parse(zUuid, id) }, orderBy: { requestedAt: 'desc' } });
    return Promise.all(ls.map((l) => this.logDto(l.id)));
  }
  private async logDto(id: string) {
    const l = await this.prisma.mailLog.findUniqueOrThrow({ where: { id } });
    const u = await this.prisma.user.findUnique({ where: { id: l.requestedBy }, select: { name: true } });
    return { id: l.id, kind: l.kind, to: l.toAddresses, cc: l.ccAddresses, subject: l.subject, attachmentName: l.attachmentName, status: l.status, errorMessage: l.errorMessage, requestedBy: u?.name ?? '', requestedAt: isoJst(l.requestedAt), completedAt: isoJst(l.completedAt) };
  }

  /* ---------------------------------------------------------------- 送信結果の受け取り（FR-MAL-06） */
  async webhook(req: Request & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? []));
    if (!this.mail.verifyWebhook(raw, req.headers)) throw new AppError('UNAUTHENTICATED', '署名が正しくありません');
    let events: unknown;
    try { events = JSON.parse(raw.toString('utf8')); } catch { throw new AppError('VALIDATION_ERROR', 'JSON ではありません'); }
    if (!Array.isArray(events)) throw new AppError('VALIDATION_ERROR', '配列を送ってください');
    for (const ev of events as { event?: string; mail_log_id?: string; reason?: string; response?: string; email?: string }[]) {
      if (!ev?.mail_log_id || !/^[0-9a-f-]{36}$/i.test(ev.mail_log_id)) continue;
      if (!['bounce', 'dropped', 'blocked'].includes(String(ev.event))) continue;
      const log = await this.prisma.mailLog.findUnique({ where: { id: ev.mail_log_id } });
      if (!log || log.status === 'FAILED') continue;
      const msg = `${ev.event === 'dropped' ? '送信されませんでした' : '届きませんでした'}（${ev.email ?? ''}${ev.reason || ev.response ? '：' + (ev.reason ?? ev.response) : ''}）`.slice(0, 500);
      await this.prisma.tx(async (tx) => {
        await tx.mailLog.update({ where: { id: log.id }, data: { status: 'FAILED', errorMessage: msg, completedAt: now() } });
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: log.invoiceId } });
        if (inv.status === 'SENT') await tx.invoice.update({ where: { id: inv.id }, data: { status: 'SEND_ERROR' } });
        await this.audit.write(tx, systemActor('メールサービス'), { action: 'MAIL_FAILED', targetType: 'invoice', targetId: inv.id, summary: `請求書 ${inv.invoiceNo} のメールが${msg}` });
      });
    }
  }
}

const O = ['OFFICE', 'ADMIN'] as const;
@Controller()
export class MailController {
  constructor(private readonly s: MailService) {}
  @Post('invoices/mail-preview') @Roles(...O) @HttpCode(200) preview(@Body() b: unknown) { return this.s.preview(b); }
  @Post('invoices/send') @Roles(...O) @HttpCode(200) send(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.send(a, b); }
  @Post('invoices/:id/resend') @Roles(...O) @HttpCode(200) resend(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.resend(a, id, b); }
  @Get('invoices/:id/mail-logs') @Roles(...O) logs(@Param('id') id: string) { return this.s.logs(id); }
  @Post('webhooks/mail-events') @Public() @HttpCode(204) async webhook(@Req() req: Request) { await this.s.webhook(req); }
}

@Module({ imports: [FreeeModule], providers: [MailService], controllers: [MailController] })
export class MailModule {}
