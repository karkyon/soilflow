/* freee会計連携（FR-FRE、SCR-40〜44、09 3・4章） */
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Logger, Module, OnModuleInit, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { freeeDetails } from '@soilflow/billing';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { FREEE, FreeeAdapter, FreeeError, FreeeRequest } from '../../adapters/freee';
import { KMS, KmsAdapter } from '../../adapters/kms';
import { Actor, AnyActor, CurrentActor, Roles, systemActor } from '../../common/actor';
import { AuditService, redact } from '../../common/audit.service';
import { config } from '../../common/config';
import { isoJst, now, toDate, ymd } from '../../common/dates';
import { big, jsonOf, num } from '../../common/domain';
import { AppError, conflict, invalidState, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse, zCsvQ, zDate, zMonth, zUuid } from '../../common/validation';
import { GiveUp, JobsService, RetryLater } from '../jobs/jobs.module';
import { invoiceFileName, PdfService, sha256 } from '../pdf/pdf.module';

type Reason = { code: string; message: string };
const REG_STATUSES = ['PENDING', 'NEEDS_ACTION', 'QUEUED', 'PROCESSING', 'REGISTERED', 'ERROR', 'DELETED'] as const;
const R_NOT_CONNECTED: Reason = { code: 'FREEE_NOT_CONNECTED', message: 'freee と連携していません（連携すると自動で判定し直します）' };
const INCOME_CATEGORIES = ['売上高', '営業外収益', '特別利益', '収入'];

/* ---------------------------------------------------------------- 取引先の名前の照合（09 4.3） */
const CORP = /株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|\(同\)|㈱|㈲/g;
export function normalizeName(s: string) {
  return s.normalize('NFKC').replace(CORP, '').replace(/[\s　・.,，、。]/g, '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).toLowerCase();
}
function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function matchPartner(name: string, partners: { id: number; name: string; code: string | null }[]) {
  const n = normalizeName(name);
  const exact = partners.filter((p) => normalizeName(p.name) === n);
  if (exact.length === 1) return { status: 'AUTO' as const, partner: exact[0], candidates: [] };
  const cands = (exact.length > 1 ? exact : partners.filter((p) => { const m = normalizeName(p.name); return m && n && (m.includes(n) || n.includes(m) || (Math.min(m.length, n.length) >= 3 && distance(m, n) <= 2)); })).slice(0, 5);
  return cands.length ? { status: 'CANDIDATE' as const, partner: null, candidates: cands } : { status: 'UNMAPPED' as const, partner: null, candidates: [] };
}

@Injectable()
export class FreeeService implements OnModuleInit {
  private readonly log = new Logger('Freee');
  private partnerCache: { at: number; list: { id: number; name: string; code: string | null }[] } | null = null;
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly jobs: JobsService, private readonly pdf: PdfService,
    @Inject(FREEE) private readonly api: FreeeAdapter, @Inject(KMS) private readonly kms: KmsAdapter,
  ) {}

  onModuleInit() {
    this.jobs.register('FREEE_REGISTER', (p, c) => this.process(String(p.registrationId), c.final));
    this.jobs.register('FREEE_DELETE', (p, c) => this.process(String(p.registrationId), c.final));
    this.jobs.register('FREEE_TOKEN_REFRESH', async () => {
      const c = await this.prisma.freeeConnection.findUnique({ where: { id: 1 } });
      if (c?.status === 'CONNECTED') await this.accessToken(true);
    });
  }

  /* ---------------------------------------------------------------- 鍵（09 3章） */
  private async saveTokens(tx: Tx, t: { access_token: string; refresh_token: string; expires_in: number }) {
    const a = await this.kms.encrypt(t.access_token), r = await this.kms.encrypt(t.refresh_token);
    await tx.freeeConnection.update({ where: { id: 1 }, data: { accessTokenEnc: new Uint8Array(a.ciphertext), refreshTokenEnc: new Uint8Array(r.ciphertext), kmsKeyVersion: a.keyVersion, accessTokenExpiresAt: new Date(now().getTime() + t.expires_in * 1000), lastCheckedAt: now(), lastError: null } });
  }
  /** アクセストークン。期限の5分前なら更新する。更新は行をロックして1つずつ（09 3章） */
  async accessToken(force = false, allowCompanyRequired = false): Promise<{ token: string; companyId: number | null }> {
    const r = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM freee_connection WHERE id = 1 FOR UPDATE`;
      const c = await tx.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
      if (!(c.status === 'CONNECTED' || (allowCompanyRequired && c.status === 'COMPANY_REQUIRED')) || !c.refreshTokenEnc) return { error: c.status };
      if (!force && c.accessTokenEnc && c.accessTokenExpiresAt && c.accessTokenExpiresAt.getTime() - now().getTime() > 5 * 60000) {
        return { token: await this.kms.decrypt(Buffer.from(c.accessTokenEnc)), companyId: num(c.companyId) };
      }
      try {
        const t = await this.api.token({ grant_type: 'refresh_token', refresh_token: await this.kms.decrypt(Buffer.from(c.refreshTokenEnc)) });
        await this.saveTokens(tx, t);
        return { token: t.access_token, companyId: num(c.companyId) };
      } catch (e) {
        if (e instanceof FreeeError && (e.status === 400 || e.status === 401)) {
          await tx.freeeConnection.update({ where: { id: 1 }, data: { status: 'REAUTH_REQUIRED', lastError: `鍵の更新に失敗：${e.freeeMessage}`.slice(0, 500), lastCheckedAt: now() } });
          await this.audit.write(tx, systemActor(), { action: 'FREEE_REAUTH_REQUIRED', targetType: 'freee_connection', targetId: '1', summary: 'freee の鍵の更新に失敗したため、再連携が必要になりました' });
          this.log.warn(JSON.stringify({ severity: 'WARNING', alert: 'FREEE_REAUTH_REQUIRED' }));
          return { error: 'REAUTH_REQUIRED' };
        }
        throw e;
      }
    }, { timeout: 40000 });
    if ('error' in r) throw new AppError('FREEE_NOT_CONNECTED', r.error === 'REAUTH_REQUIRED' ? 'freee との再連携が必要です（連携の設定から再び許可してください）' : 'freee と連携していません');
    return r as { token: string; companyId: number | null };
  }

  /** freee の API を呼ぶ。401 なら鍵を一度更新して1回だけやり直す。すべて freee_api_logs に記録（09 4.8） */
  async call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: FreeeRequest = {}, o: { registrationId?: string; actor?: AnyActor | null; allowCompanyRequired?: boolean } = {}): Promise<T> {
    let tok = await this.accessToken(false, o.allowCompanyRequired);
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      try {
        const r = await this.api.request<T>(tok.token, method, path, opts);
        await this.logCall(method, path, opts, r.status, Date.now() - t0, r.data, null, o);
        return r.data;
      } catch (e) {
        const fe = e instanceof FreeeError ? e : new FreeeError(0, null, String((e as Error)?.message ?? e));
        await this.logCall(method, path, opts, fe.status || null, Date.now() - t0, fe.body, fe.freeeMessage, o);
        if (fe.status === 401 && attempt === 0) { tok = await this.accessToken(true, o.allowCompanyRequired); continue; }
        if (fe.status === 401) {
          await this.prisma.freeeConnection.update({ where: { id: 1 }, data: { status: 'REAUTH_REQUIRED', lastError: 'freee が鍵を受け付けません（freee 側で連携が解除された可能性）' } });
          throw new AppError('FREEE_NOT_CONNECTED', 'freee との再連携が必要です');
        }
        throw fe;
      }
    }
  }
  private async logCall(method: string, path: string, opts: FreeeRequest, status: number | null, ms: number, body: unknown, error: string | null, o: { registrationId?: string; actor?: AnyActor | null }) {
    const summarize = (v: unknown) => {
      const b = (v ?? {}) as Record<string, unknown>;
      const pick = (x: unknown) => { const y = (x ?? {}) as Record<string, unknown>; return { id: y.id, ref_number: y.ref_number, issue_date: y.issue_date, amount: y.amount, partner_id: y.partner_id, status: y.status }; };
      if (b.deal) return { deal: pick(b.deal), payments: Array.isArray((b.deal as Record<string, unknown>).payments) ? ((b.deal as Record<string, unknown>).payments as unknown[]).length : undefined };
      if (b.receipt) return { receipt: pick(b.receipt) };
      if (b.partner) return { partner: pick(b.partner) };
      if (Array.isArray(b.deals)) return { deals: (b.deals as unknown[]).map(pick) };
      if (b.errors) return { errors: b.errors };
      return Object.fromEntries(Object.entries(b).map(([k, x]) => [k, Array.isArray(x) ? `[${x.length}件]` : typeof x === 'object' ? '{…}' : x]));
    };
    const j = (opts.json ?? {}) as Record<string, unknown>;
    const req = { query: opts.query, ...(opts.json ? { issue_date: j.issue_date, ref_number: j.ref_number, partner_id: j.partner_id, details: Array.isArray(j.details) ? (j.details as Record<string, unknown>[]).map((d) => ({ amount: d.amount, vat: d.vat, tax_code: d.tax_code, account_item_id: d.account_item_id })) : undefined, receipt_ids: j.receipt_ids, name: j.name } : {}), ...(opts.form ? { fields: Object.fromEntries(Object.entries(opts.form.fields).filter(([k]) => k !== 'company_id')), file: opts.form.file ? { name: opts.form.file.name, size: opts.form.file.data.length } : undefined } : {}) };
    await this.prisma.freeeApiLog.create({
      data: {
        registrationId: o.registrationId ?? null, method, path, statusCode: status, durationMs: ms, requestSummary: jsonOf(redact(req)), responseSummary: jsonOf(redact(summarize(body))),
        error: error?.slice(0, 1000) ?? null, requestedBy: o.actor?.id ?? null,
      },
    }).catch(() => undefined);
  }

  /* ---------------------------------------------------------------- 連携の状態（FR-FRE-01〜04・09） */
  async connection() {
    const c = await this.prisma.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
    return {
      status: c.status, companyId: num(c.companyId), companyName: c.companyName, authorizedFreeeUser: c.authorizedFreeeUser, connectedAt: isoJst(c.connectedAt),
      lastCheckedAt: isoJst(c.lastCheckedAt), registrationMode: c.registrationMode, lastError: c.lastError, version: c.version,
    };
  }
  async authorize(actor: Actor) {
    const state = randomBytes(32).toString('base64url');
    await this.prisma.freeeOauthState.create({ data: { state, userId: actor.id, expiresAt: new Date(now().getTime() + 10 * 60000) } });
    return { authorizeUrl: this.api.authorizeUrl(state) };
  }
  async callback(actor: Actor, query: Record<string, unknown>, res: Response) {
    const back = (r: 'ok' | 'error', msg?: string) => res.redirect(302, `${config.freeeSettingsPath}?result=${r}${msg ? `&message=${encodeURIComponent(msg)}` : ''}`);
    const q = parse(z.object({ code: z.string().max(500).optional(), state: z.string().max(200), error: z.string().max(200).optional() }), query);
    const st = await this.prisma.freeeOauthState.findUnique({ where: { state: q.state } });
    if (!st || st.usedAt || st.expiresAt < now() || st.userId !== actor.id) return back('error', '連携の許可の期限が切れたか、正しくありません。もう一度やり直してください');
    await this.prisma.freeeOauthState.update({ where: { state: q.state }, data: { usedAt: now() } });
    if (q.error || !q.code) return back('error', q.error === 'access_denied' ? 'freee で許可されませんでした' : 'freee から連携の許可を受け取れませんでした');
    let t;
    try { t = await this.api.token({ grant_type: 'authorization_code', code: q.code }); }
    catch (e) { return back('error', `freee の鍵の発行に失敗しました（${e instanceof FreeeError ? e.freeeMessage : (e as Error).message}）`); }
    const companyId = t.company_id ?? null;
    await this.prisma.tx(async (tx) => {
      await this.saveTokens(tx, t);
      await tx.freeeConnection.update({ where: { id: 1 }, data: { status: companyId ? 'CONNECTED' : 'COMPANY_REQUIRED', companyId, companyName: null, connectedAt: now(), connectedBy: actor.id, lastError: null } });
      await this.audit.write(tx, actor, { action: 'FREEE_CONNECT', targetType: 'freee_connection', targetId: '1', summary: `freee と連携した${companyId ? `（事業所 ID ${companyId}）` : '（事業所の選択待ち）'}` });
    });
    if (companyId) await this.afterConnected(actor, companyId);
    return back('ok');
  }
  private async afterConnected(actor: AnyActor, companyId: number) {
    try {
      const c = await this.call<{ company: { display_name?: string; name?: string } }>('GET', `/api/1/companies/${companyId}`, { query: { details: 'false' } }, { actor });
      const me = await this.call<{ user: { email?: string } }>('GET', '/api/1/users/me', {}, { actor }).catch(() => null);
      await this.prisma.freeeConnection.update({ where: { id: 1 }, data: { companyName: c.company?.display_name ?? c.company?.name ?? null, authorizedFreeeUser: me?.user?.email ?? null, lastCheckedAt: now() } });
    } catch (e) { this.log.warn(`事業所名の取得に失敗：${(e as Error).message}`); }
    this.partnerCache = null;
    await this.reevaluate();
  }
  async updateConnection(actor: Actor, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), registrationMode: z.enum(['REVIEW', 'AUTO']).optional(), companyId: z.number().int().positive().optional() }).strict(), body);
    const c = await this.prisma.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
    if (c.version !== b.version) throw conflict();
    let companyName: string | null = null;
    if (b.companyId !== undefined) {
      if (!['COMPANY_REQUIRED', 'CONNECTED'].includes(c.status)) throw new AppError('FREEE_NOT_CONNECTED', 'freee と連携してから事業所を選んでください');
      const list = await this.companies(actor);
      const hit = list.find((x) => x.id === b.companyId);
      if (!hit) throw new AppError('VALIDATION_ERROR', 'その事業所は選べません');
      companyName = hit.name;
    }
    await this.prisma.tx(async (tx) => {
      const r = await tx.freeeConnection.updateMany({ where: { id: 1, version: b.version }, data: { ...(b.registrationMode ? { registrationMode: b.registrationMode } : {}), ...(b.companyId !== undefined ? { companyId: b.companyId, companyName, status: 'CONNECTED' } : {}) } });
      if (!r.count) throw conflict();
      await this.audit.write(tx, actor, { action: b.companyId !== undefined ? 'FREEE_CONNECT' : 'FREEE_MODE', targetType: 'freee_connection', targetId: '1', summary: [b.registrationMode ? `freee への登録のしかたを「${b.registrationMode === 'AUTO' ? '自動で登録' : '確認してから登録'}」にした` : '', b.companyId !== undefined ? `freee の事業所を「${companyName}」にした` : ''].filter(Boolean).join('、'), before: { registrationMode: c.registrationMode, companyId: num(c.companyId) }, after: b });
    });
    if (b.companyId !== undefined) await this.afterConnected(actor, b.companyId);
    return this.connection();
  }
  async disconnect(actor: Actor) {
    await this.prisma.tx(async (tx) => {
      await tx.freeeConnection.update({ where: { id: 1 }, data: { status: 'DISCONNECTED', accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, kmsKeyVersion: null, companyId: null, companyName: null, authorizedFreeeUser: null, lastError: null } });
      await tx.freeeRegistration.updateMany({ where: { status: { in: ['QUEUED', 'NEEDS_ACTION'] }, action: { not: 'DELETE' } }, data: { status: 'PENDING', reasons: [R_NOT_CONNECTED] } });
      await this.audit.write(tx, actor, { action: 'FREEE_DISCONNECT', targetType: 'freee_connection', targetId: '1', summary: 'freee との連携を解除した（鍵を削除。freee 側の連携の解除は freee の画面で行う）' });
    });
    this.partnerCache = null;
  }

  /* ---------------------------------------------------------------- freee の一覧 */
  async companies(actor: AnyActor) {
    const r = await this.call<{ companies: { id: number; display_name?: string; name?: string; name_kana?: string }[] }>('GET', '/api/1/companies', {}, { actor, allowCompanyRequired: true });
    return r.companies.map((c) => ({ id: c.id, name: c.display_name ?? c.name ?? String(c.id), code: c.name ?? null }));
  }
  private async companyId() {
    const c = await this.prisma.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
    if (c.status !== 'CONNECTED' || !c.companyId) throw new AppError('FREEE_NOT_CONNECTED', c.status === 'REAUTH_REQUIRED' ? 'freee との再連携が必要です' : 'freee と連携していません');
    return Number(c.companyId);
  }
  async partners(actor: AnyActor, keyword?: string) {
    const r = await this.call<{ partners: { id: number; name: string; code: string | null }[] }>('GET', '/api/1/partners', { query: { company_id: await this.companyId(), keyword: keyword || undefined, limit: 100 } }, { actor });
    return r.partners.map((p) => ({ id: p.id, name: p.name, code: p.code ?? null }));
  }
  private async allPartners(actor: AnyActor) {
    if (this.partnerCache && Date.now() - this.partnerCache.at < 5 * 60000) return this.partnerCache.list;
    const cid = await this.companyId(); const list: { id: number; name: string; code: string | null }[] = [];
    for (let off = 0; off < 3000; off += 100) {
      const r = await this.call<{ partners: { id: number; name: string; code: string | null }[] }>('GET', '/api/1/partners', { query: { company_id: cid, offset: off, limit: 100 } }, { actor });
      list.push(...r.partners.map((p) => ({ id: p.id, name: p.name, code: p.code ?? null })));
      if (r.partners.length < 100) break;
    }
    this.partnerCache = { at: Date.now(), list };
    return list;
  }
  async accountItems(actor: AnyActor) {
    const r = await this.call<{ account_items: { id: number; name: string; account_category?: string; shortcut?: string }[] }>('GET', '/api/1/account_items', { query: { company_id: await this.companyId() } }, { actor });
    return r.account_items.filter((a) => !a.account_category || INCOME_CATEGORIES.some((c) => a.account_category!.includes(c))).map((a) => ({ id: a.id, name: a.name, code: a.shortcut ?? a.account_category ?? null }));
  }
  async taxes(actor: AnyActor) {
    const cid = await this.companyId();
    const r = await this.call<{ taxes: { code: number; name: string; name_ja: string; available?: boolean }[] }>('GET', `/api/1/taxes/companies/${cid}`, {}, { actor });
    return r.taxes.filter((t) => t.available !== false).map((t) => ({ id: t.code, name: t.name_ja, code: t.name }));
  }
  async items(actor: AnyActor) {
    const r = await this.call<{ items: { id: number; name: string; shortcut1?: string }[] }>('GET', '/api/1/items', { query: { company_id: await this.companyId(), limit: 3000 } }, { actor });
    return r.items.map((i) => ({ id: i.id, name: i.name, code: i.shortcut1 ?? null }));
  }

  /* ---------------------------------------------------------------- 取引先の対応付け（FR-FRE-06・07） */
  async partnerMappings(actor: AnyActor) {
    const bps = await this.prisma.billingParty.findMany({ where: { active: true }, orderBy: { kana: 'asc' } });
    let partners: { id: number; name: string; code: string | null }[] = [];
    if (bps.some((b) => b.freeeMappingStatus === 'CANDIDATE')) partners = await this.allPartners(actor).catch(() => []);
    return bps.map((b) => ({
      billingPartyId: b.id, billingPartyName: b.name, freeePartnerId: num(b.freeePartnerId), freeePartnerName: b.freeePartnerName, status: b.freeeMappingStatus,
      candidates: b.freeeMappingStatus === 'CANDIDATE' ? matchPartner(b.name, partners).candidates : [],
    }));
  }
  async autoMatch(actor: Actor) {
    const partners = await this.allPartners(actor);
    const bps = await this.prisma.billingParty.findMany({ where: { active: true, freeeMappingStatus: { in: ['UNMAPPED', 'CANDIDATE', 'AUTO'] } } });
    const count = { AUTO: 0, CANDIDATE: 0, UNMAPPED: 0 };
    await this.prisma.tx(async (tx) => {
      for (const b of bps) {
        const m = matchPartner(b.name, partners);
        count[m.status]++;
        await tx.billingParty.update({ where: { id: b.id }, data: { freeeMappingStatus: m.status, freeePartnerId: m.partner?.id ?? null, freeePartnerName: m.partner?.name ?? null, freeePartnerCode: m.partner?.code ?? null } });
      }
      await this.audit.write(tx, actor, { action: 'FREEE_PARTNER_MAP', targetType: 'billing_party', summary: `freee の取引先を名前で自動照合（一致 ${count.AUTO}・候補 ${count.CANDIDATE}・なし ${count.UNMAPPED}）` });
    });
    await this.reevaluate();
    return this.partnerMappings(actor);
  }
  async setPartner(actor: Actor, billingPartyId: string, body: unknown) {
    const b = parse(z.object({ freeePartnerId: z.number().int().positive().nullable() }).strict(), body);
    const bp = await this.prisma.billingParty.findUnique({ where: { id: parse(zUuid, billingPartyId) } });
    if (!bp) throw notFound('請求先');
    let p: { id: number; name: string; code: string | null } | undefined;
    if (b.freeePartnerId !== null) {
      p = (await this.allPartners(actor)).find((x) => x.id === b.freeePartnerId);
      if (!p) { this.partnerCache = null; p = (await this.allPartners(actor)).find((x) => x.id === b.freeePartnerId); }
      if (!p) throw new AppError('VALIDATION_ERROR', 'freee にその取引先がありません');
    }
    await this.prisma.tx(async (tx) => {
      await tx.billingParty.update({ where: { id: bp.id }, data: p ? { freeeMappingStatus: 'MANUAL', freeePartnerId: p.id, freeePartnerName: p.name, freeePartnerCode: p.code } : { freeeMappingStatus: 'UNMAPPED', freeePartnerId: null, freeePartnerName: null, freeePartnerCode: null } });
      await this.audit.write(tx, actor, { action: 'FREEE_PARTNER_MAP', targetType: 'billing_party', targetId: bp.id, summary: p ? `請求先「${bp.name}」を freee の取引先「${p.name}」に対応付けた` : `請求先「${bp.name}」の freee の取引先の対応付けを外した`, before: { freeePartnerId: num(bp.freeePartnerId) }, after: { freeePartnerId: p?.id ?? null } });
    });
    await this.reevaluate();
    return (await this.partnerMappings(actor)).find((m) => m.billingPartyId === bp.id);
  }
  async createPartner(actor: Actor, body: unknown) {
    const { billingPartyId } = parse(z.object({ billingPartyId: zUuid }).strict(), body);
    const bp = await this.prisma.billingParty.findUnique({ where: { id: billingPartyId } });
    if (!bp) throw notFound('請求先');
    const r = await this.call<{ partner: { id: number; name: string; code: string | null } }>('POST', '/api/1/partners', {
      json: { company_id: await this.companyId(), name: bp.name, long_name: bp.name, name_kana: bp.kana, ...(bp.postalCode || bp.address ? { address_attributes: { zipcode: bp.postalCode ?? undefined, street_name1: bp.address ?? undefined } } : {}) },
    }, { actor });
    this.partnerCache = null;
    await this.prisma.tx(async (tx) => {
      await tx.billingParty.update({ where: { id: bp.id }, data: { freeeMappingStatus: 'CREATED', freeePartnerId: r.partner.id, freeePartnerName: r.partner.name, freeePartnerCode: r.partner.code ?? null } });
      await this.audit.write(tx, actor, { action: 'FREEE_PARTNER_CREATE', targetType: 'billing_party', targetId: bp.id, summary: `請求先「${bp.name}」から freee に取引先を作成（ID ${r.partner.id}）` });
    });
    await this.reevaluate();
    return (await this.partnerMappings(actor)).find((m) => m.billingPartyId === bp.id);
  }

  /* ---------------------------------------------------------------- 品目の対応付け（FR-FRE-08） */
  async setItemMapping(actor: Actor, itemId: string, body: unknown) {
    const b = parse(z.object({ accountItemId: z.number().int().positive(), taxCode: z.number().int().min(0), freeeItemId: z.number().int().positive().nullable().optional() }).strict(), body);
    const item = await this.prisma.item.findUnique({ where: { id: parse(zUuid, itemId) } });
    if (!item) throw notFound('品目');
    const [ais, taxes, fitems] = await Promise.all([this.accountItems(actor), this.taxes(actor), b.freeeItemId ? this.items(actor) : Promise.resolve([])]);
    const ai = ais.find((x) => x.id === b.accountItemId), tx_ = taxes.find((x) => x.id === b.taxCode), fi = b.freeeItemId ? fitems.find((x) => x.id === b.freeeItemId) : null;
    if (!ai) throw new AppError('VALIDATION_ERROR', 'freee にその勘定科目がありません');
    if (!tx_) throw new AppError('VALIDATION_ERROR', 'その税区分はこの事業所で使えません');
    if (b.freeeItemId && !fi) throw new AppError('VALIDATION_ERROR', 'freee にその品目がありません');
    const after = await this.prisma.tx(async (tx) => {
      const r = await tx.item.update({ where: { id: item.id }, data: { freeeAccountItemId: ai.id, freeeAccountItemName: ai.name, freeeTaxCode: tx_.id, freeeTaxName: tx_.name, freeeItemId: fi?.id ?? null, freeeItemName: fi?.name ?? null } });
      await this.audit.write(tx, actor, { action: 'FREEE_ITEM_MAP', targetType: 'item', targetId: item.id, summary: `品目「${item.priceItemName}」を勘定科目「${ai.name}」・税区分「${tx_.name}」${fi ? `・品目「${fi.name}」` : ''}に対応付けた` });
      return r;
    });
    await this.reevaluate();
    return {
      id: after.id, reportLabel: after.reportLabel, priceItemName: after.priceItemName, direction: after.direction, sortOrder: after.sortOrder,
      freeeAccountItemId: num(after.freeeAccountItemId), freeeAccountItemName: after.freeeAccountItemName, freeeTaxCode: after.freeeTaxCode, freeeTaxName: after.freeeTaxName,
      freeeItemId: num(after.freeeItemId), freeeItemName: after.freeeItemName, active: after.active, version: after.version,
    };
  }

  /* ---------------------------------------------------------------- 登録待ちの判定（09 4.2） */
  private async build(db: Tx | PrismaService, invoiceId: string) {
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const lines = await db.invoiceLine.findMany({ where: { invoiceId }, orderBy: { lineNo: 'asc' } });
    const bp = await db.billingParty.findUniqueOrThrow({ where: { id: inv.billingPartyId } });
    const items = await db.item.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.itemId))] } } });
    const conn = await db.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
    const reasons: Reason[] = [];
    if (conn.status !== 'CONNECTED') reasons.push(R_NOT_CONNECTED);
    if (!bp.freeePartnerId || ['UNMAPPED', 'CANDIDATE'].includes(bp.freeeMappingStatus)) reasons.push({ code: 'PARTNER_UNMAPPED', message: `請求先「${bp.name}」に freee の取引先が対応付いていません` });
    const mapping: Record<string, { accountItemId: number; taxCode: number; freeeItemId: number | null }> = {};
    for (const it of items) if (it.freeeAccountItemId && it.freeeTaxCode !== null) mapping[it.id] = { accountItemId: Number(it.freeeAccountItemId), taxCode: it.freeeTaxCode, freeeItemId: num(it.freeeItemId) };
    const fd = freeeDetails({ lines: lines.map((l) => ({ lineNo: l.lineNo, itemId: l.itemId, amount: big(l.amount) })), taxRate: inv.taxRate, taxAmount: big(inv.taxAmount) }, mapping, inv.taxRounding as 'floor');
    if (fd.error === 'ITEM_MAPPING_MISSING') for (const id of fd.itemIds) reasons.push({ code: 'ITEM_UNMAPPED', message: `品目「${items.find((i) => i.id === id)?.priceItemName}」の勘定科目・税区分が設定されていません` });
    if (fd.error === 'TOO_MANY_DETAILS') reasons.push({ code: 'TOO_MANY_DETAILS', message: `明細が多すぎます（${fd.count} 行。freee は100行まで）` });
    const [y, m] = ymd(inv.periodTo).split('-').map(Number);
    const deal = {
      company_id: num(conn.companyId), type: 'income', issue_date: ymd(inv.issueDate), due_date: ymd(inv.dueDate), partner_id: num(bp.freeePartnerId), ref_number: inv.invoiceNo,
      details: 'details' in fd && fd.details ? fd.details.map((d) => ({ account_item_id: d.accountItemId, tax_code: d.taxCode, ...(d.itemId ? { item_id: d.itemId } : {}), amount: d.amount, vat: d.vat, description: `${y}年${m}月分 受入・納品（SoilFlow）` })) : [],
    };
    return { inv, bp, items, conn, reasons, deal, fileName: invoiceFileName(inv.billingPartyName, ymd(inv.periodTo)), description: `SoilFlow 請求書 ${inv.invoiceNo}` };
  }
  private statusFor(reasons: Reason[], mode: string): { status: string; reasons: Reason[] } {
    if (reasons.some((r) => r.code === 'FREEE_NOT_CONNECTED')) return { status: 'PENDING', reasons: [R_NOT_CONNECTED] };
    if (reasons.length) return { status: 'NEEDS_ACTION', reasons };
    return { status: mode === 'AUTO' ? 'QUEUED' : 'PENDING', reasons: [] };
  }
  /** メール送信に成功した請求書の freee 登録を作る（09 4.2）。すぐ登録するならジョブの ID を返す */
  async ensureRegistration(tx: Tx, invoiceId: string): Promise<bigint | null> {
    const ex = await tx.freeeRegistration.findUnique({ where: { invoiceId } });
    if (ex) return null;
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    let action = 'CREATE', target: bigint | null = null;
    if (inv.replacesInvoiceId) {
      const old = await tx.freeeRegistration.findUnique({ where: { invoiceId: inv.replacesInvoiceId } });
      if (old?.dealId && old.status === 'REGISTERED') { action = 'UPDATE'; target = old.dealId; }
    }
    const b = await this.build(tx, invoiceId);
    const s = this.statusFor(b.reasons, b.conn.registrationMode);
    const reg = await tx.freeeRegistration.create({ data: { invoiceId, action, status: s.status, reasons: s.reasons, updateTargetDealId: target } });
    if (s.status !== 'QUEUED') return null;
    return this.jobs.enqueue(tx, 'FREEE_REGISTER', { registrationId: reg.id }, { dedupeKey: `FREEE_REGISTER:${invoiceId}` });
  }
  /** 対応付け・連携を直したら、確認待ち・要対応の登録を判定し直す（09 4.2） */
  async reevaluate() {
    const regs = await this.prisma.freeeRegistration.findMany({ where: { status: { in: ['PENDING', 'NEEDS_ACTION'] }, action: { not: 'DELETE' } } });
    const jobs: (bigint | null)[] = [];
    for (const r of regs) {
      if (r.reasons && Array.isArray(r.reasons) && (r.reasons as Reason[]).some((x) => x.code === 'FREEE_DEAL_SETTLED')) continue;
      jobs.push(await this.prisma.tx(async (tx) => {
        const b = await this.build(tx, r.invoiceId);
        const s = this.statusFor(b.reasons, b.conn.registrationMode);
        // 確認してから登録（REVIEW）なら PENDING のまま本社の操作を待つ。自動（AUTO）なら QUEUED
        const next = s;
        await tx.freeeRegistration.update({ where: { id: r.id }, data: { status: next.status, reasons: next.reasons } });
        return next.status === 'QUEUED' ? this.jobs.enqueue(tx, 'FREEE_REGISTER', { registrationId: r.id }, { dedupeKey: `FREEE_REGISTER:${r.invoiceId}` }) : null;
      }));
    }
    for (const j of jobs) await this.jobs.runNow(j).catch(() => undefined);
  }

  /** 請求書の取消（FR-FRE-18）。登録済なら取引の削除を予約する。再発行なら元の取引は新しい請求書で更新する（FR-FRE-19） */
  async onInvoiceVoided(tx: Tx, actor: Actor, invoiceId: string, reissue: boolean): Promise<bigint | null> {
    const r = await tx.freeeRegistration.findUnique({ where: { invoiceId } });
    if (!r || r.status === 'DELETED') return null;
    if (r.status === 'PROCESSING') throw invalidState('freee への登録を処理中です。少し待ってから取り消してください');
    if (r.dealId) {
      if (reissue) return null;
      await tx.freeeRegistration.update({ where: { id: r.id }, data: { action: 'DELETE', status: 'QUEUED', reasons: [], attempts: 0, requestedBy: actor.id, requestedAt: now() } });
      return this.jobs.enqueue(tx, 'FREEE_DELETE', { registrationId: r.id }, { dedupeKey: `FREEE_DELETE:${invoiceId}` });
    }
    await tx.freeeRegistration.update({ where: { id: r.id }, data: { status: 'DELETED', reasons: [{ code: 'INVOICE_VOIDED', message: '請求書を取り消したため、登録しません' }] } });
    return null;
  }

  /* ---------------------------------------------------------------- 登録の手順（09 4.4、冪等） */
  async process(id: string, final: boolean) {
    const claimed = await this.prisma.freeeRegistration.updateMany({ where: { id, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
    if (!claimed.count) return;
    const reg = await this.prisma.freeeRegistration.findUniqueOrThrow({ where: { id } });
    const setReg = (data: Record<string, unknown>) => this.prisma.freeeRegistration.update({ where: { id }, data });
    const auditSys = (action: string, summary: string, after?: unknown) => this.audit.writeAlone(systemActor('freee 登録'), { action, targetType: 'freee_registration', targetId: id, summary, after });
    const conn = await this.prisma.freeeConnection.findUniqueOrThrow({ where: { id: 1 } });
    if (conn.status !== 'CONNECTED') { await setReg({ status: 'PENDING', reasons: [R_NOT_CONNECTED] }); return; }
    const opt = { registrationId: id };
    try {
      if (reg.action === 'DELETE') {
        const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: reg.invoiceId } });
        const settled = await this.dealSettled(Number(reg.dealId), opt);
        if (settled === 'MISSING') { await setReg({ status: 'DELETED', reasons: [] }); return; }
        if (settled) { await setReg({ status: 'NEEDS_ACTION', reasons: [{ code: 'FREEE_DEAL_SETTLED', message: 'freee で決済済みのため、取引を自動で削除しませんでした。freee で処理してください' }] }); return; }
        try { await this.call('DELETE', `/api/1/deals/${reg.dealId}`, { query: { company_id: Number(conn.companyId) } }, opt); }
        catch (e) { if (!(e instanceof FreeeError && e.status === 404)) throw e; }
        await setReg({ status: 'DELETED', reasons: [] });
        await auditSys('FREEE_DELETE', `請求書 ${inv.invoiceNo} の取消により freee の取引（ID ${reg.dealId}）を削除`);
        return;
      }
      const b = await this.build(this.prisma, reg.invoiceId);
      const blocking = b.reasons.filter((r) => r.code !== 'FREEE_NOT_CONNECTED');
      if (blocking.length) { await setReg({ status: 'NEEDS_ACTION', reasons: blocking }); return; }
      if (b.inv.status !== 'SENT' && b.inv.status !== 'SEND_ERROR') { await setReg({ status: 'DELETED', reasons: [{ code: 'INVOICE_VOIDED', message: '請求書を取り消したため、登録しません' }] }); return; }
      // 手順1：証憑（PDF）。登録済なら飛ばす
      let receiptId = reg.receiptId;
      if (!receiptId) {
        if (!b.inv.pdfObjectKey) throw new GiveUp('請求書の PDF がありません');
        const pdf = await this.pdf.get(b.inv.pdfObjectKey);
        if (sha256(pdf) !== b.inv.pdfSha256) throw new GiveUp('請求書の PDF がお客さまに送ったものと一致しません');
        const r = await this.call<{ receipt: { id: number } }>('POST', '/api/1/receipts', {
          form: {
            fields: { company_id: Number(conn.companyId), document_type: 'invoice', description: b.description.slice(0, 255), receipt_metadatum_partner_name: b.inv.billingPartyName, receipt_metadatum_issue_date: ymd(b.inv.issueDate), receipt_metadatum_amount: big(b.inv.total) },
            file: { field: 'receipt', name: b.fileName, data: pdf, type: 'application/pdf' },
          },
        }, opt);
        receiptId = BigInt(r.receipt.id);
        await setReg({ receiptId });
      }
      // 手順2：取引
      const payload = { ...b.deal, company_id: Number(conn.companyId), receipt_ids: [Number(receiptId)] };
      let dealId = reg.dealId;
      if (!dealId && reg.action === 'UPDATE' && reg.updateTargetDealId) {
        const settled = await this.dealSettled(Number(reg.updateTargetDealId), opt);
        if (settled === true) { await setReg({ status: 'NEEDS_ACTION', payload, reasons: [{ code: 'FREEE_DEAL_SETTLED', message: '元の取引が freee で決済済みのため、自動で更新しませんでした。freee で処理してください' }] }); return; }
        if (settled === 'MISSING') { await setReg({ action: 'CREATE', updateTargetDealId: null }); reg.action = 'CREATE'; }
        else {
          await this.call('PUT', `/api/1/deals/${reg.updateTargetDealId}`, { json: payload }, opt);
          dealId = reg.updateTargetDealId;
        }
      }
      if (!dealId) {
        const found = await this.call<{ deals: { id: number; ref_number?: string }[] }>('GET', '/api/1/deals', { query: { company_id: Number(conn.companyId), partner_id: payload.partner_id ?? undefined, type: 'income', start_issue_date: payload.issue_date, end_issue_date: payload.issue_date, limit: 100 } }, opt);
        const same = found.deals.find((d) => d.ref_number === payload.ref_number);
        dealId = BigInt(same ? same.id : (await this.call<{ deal: { id: number } }>('POST', '/api/1/deals', { json: payload }, opt)).deal.id);
      }
      await setReg({ status: 'REGISTERED', dealId, payload, reasons: [], registeredAt: now(), lastErrorCode: null, lastErrorMessage: null });
      await auditSys(reg.action === 'UPDATE' ? 'FREEE_UPDATE' : 'FREEE_REGISTER', `請求書 ${b.inv.invoiceNo} を freee に${reg.action === 'UPDATE' ? '登録し直した（元の取引を更新）' : '登録'}（取引 ID ${dealId}・証憑 ID ${receiptId}）`, { dealId: Number(dealId), receiptId: Number(receiptId), total: big(b.inv.total) });
    } catch (e) {
      await this.onFailure(id, e, final);
    }
  }
  /** 取引が決済済みか（payments がある）。取引がなければ 'MISSING' */
  private async dealSettled(dealId: number, opt: { registrationId: string }): Promise<boolean | 'MISSING'> {
    try {
      const d = await this.call<{ deal: { payments?: unknown[] } }>('GET', `/api/1/deals/${dealId}`, { query: { company_id: await this.companyId() } }, opt);
      return !!d.deal.payments?.length;
    } catch (e) { if (e instanceof FreeeError && e.status === 404) return 'MISSING'; throw e; }
  }
  /** 失敗の扱い（09 4.7） */
  private async onFailure(id: string, e: unknown, final: boolean) {
    const setReg = (data: Record<string, unknown>) => this.prisma.freeeRegistration.update({ where: { id }, data });
    if (e instanceof AppError && e.code === 'FREEE_NOT_CONNECTED') { await setReg({ status: 'PENDING', reasons: [{ code: 'FREEE_NOT_CONNECTED', message: e.message }] }); return; }
    if (e instanceof GiveUp) { await setReg({ status: 'ERROR', lastErrorCode: 'INTERNAL', lastErrorMessage: e.message, reasons: [{ code: 'INTERNAL', message: e.message }] }); return; }
    if (!(e instanceof FreeeError)) {
      if (final) { await setReg({ status: 'ERROR', lastErrorCode: 'INTERNAL', lastErrorMessage: String((e as Error)?.message).slice(0, 500), reasons: [{ code: 'INTERNAL', message: 'SoilFlow の処理でエラーが起きました' }] }); return; }
      await setReg({ status: 'QUEUED', lastErrorCode: 'INTERNAL', lastErrorMessage: String((e as Error)?.message).slice(0, 500) });
      throw e;
    }
    const msg = e.freeeMessage.slice(0, 500);
    const rate = e.status === 429 || (e.status === 403 && /limit|制限|too many/i.test(msg));
    if (rate && !final) { await setReg({ status: 'QUEUED', lastErrorCode: `HTTP_${e.status}`, lastErrorMessage: msg }); throw new RetryLater(msg, 11 * 60000); }
    const transient = e.status === 0 || e.status >= 500;
    if (transient && !final) { await setReg({ status: 'QUEUED', lastErrorCode: e.status ? `HTTP_${e.status}` : 'NETWORK', lastErrorMessage: msg }); throw new RetryLater(msg); }
    const reason = e.status === 403 ? 'freee のアプリの権限・プランを確認してください' : e.status === 400 ? `freee が受け付けませんでした：${msg}` : `freee の応答 ${e.status}：${msg}`;
    await setReg({ status: 'ERROR', lastErrorCode: e.status ? `HTTP_${e.status}` : 'NETWORK', lastErrorMessage: msg, reasons: [{ code: e.status ? `HTTP_${e.status}` : 'NETWORK', message: reason }] });
  }

  /* ---------------------------------------------------------------- 登録の一覧・確認・登録（FR-FRE-11〜17・20） */
  private async regDtos(ids: string[]) {
    if (!ids.length) return [];
    const regs = await this.prisma.$queryRaw<{ id: string; invoice_id: string; invoice_no: string; billing_party_name: string; issue_date: Date; total: bigint; partner_name: string | null; action: string; status: string; reasons: Reason[]; deal_id: bigint | null; receipt_id: bigint | null; attempts: number; registered_at: Date | null; last_error_message: string | null }[]>`
      SELECT r.id, r.invoice_id, i.invoice_no, i.billing_party_name, i.issue_date, i.total, b.freee_partner_name AS partner_name, r.action, r.status, r.reasons, r.deal_id, r.receipt_id, r.attempts, r.registered_at, r.last_error_message
      FROM freee_registrations r JOIN invoices i ON i.id = r.invoice_id JOIN billing_parties b ON b.id = i.billing_party_id
      WHERE r.id = ANY(${ids}::uuid[]) ORDER BY i.issue_date DESC, i.invoice_no`;
    return regs.map((r) => ({
      id: r.id, invoiceId: r.invoice_id, invoiceNo: r.invoice_no, billingPartyName: r.billing_party_name, issueDate: ymd(r.issue_date), total: big(r.total),
      freeePartnerName: r.partner_name, action: r.action, status: r.status, reasons: r.reasons ?? [], dealId: num(r.deal_id), receiptId: num(r.receipt_id),
      freeeDealUrl: r.deal_id ? `${process.env.FREEE_WEB_BASE ?? 'https://secure.freee.co.jp'}/deals/${r.deal_id}` : null,
      attempts: r.attempts, registeredAt: isoJst(r.registered_at), lastErrorMessage: r.last_error_message,
    }));
  }
  async registrations(query: Record<string, unknown>) {
    const q = parse(z.object({ status: zCsvQ(z.enum(REG_STATUSES)).optional(), month: zMonth.optional() }), query);
    const rows = await this.prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT r.id, r.status FROM freee_registrations r JOIN invoices i ON i.id = r.invoice_id
      WHERE (${q.month ?? null}::text IS NULL OR to_char(i.period_to, 'YYYY-MM') = ${q.month ?? null})`;
    const counts: Record<string, number> = Object.fromEntries(REG_STATUSES.map((s) => [s, 0]));
    for (const r of rows) counts[r.status]++;
    const ids = rows.filter((r) => !q.status?.length || q.status.includes(r.status as never)).map((r) => r.id);
    return { counts, items: await this.regDtos(ids.slice(0, 1000)) };
  }
  async preview(id: string) {
    const reg = await this.prisma.freeeRegistration.findUnique({ where: { id: parse(zUuid, id) } });
    if (!reg) throw notFound('freee 登録');
    const b = await this.build(this.prisma, reg.invoiceId);
    const ai = new Map(b.items.map((i) => [num(i.freeeAccountItemId), i.freeeAccountItemName]));
    const tn = new Map(b.items.map((i) => [i.freeeTaxCode, i.freeeTaxName]));
    const fin = new Map(b.items.map((i) => [num(i.freeeItemId), i.freeeItemName]));
    return {
      deal: {
        type: 'income', issueDate: b.deal.issue_date, dueDate: b.deal.due_date, partnerId: b.deal.partner_id, partnerName: b.bp.freeePartnerName, refNumber: b.deal.ref_number,
        details: b.deal.details.map((d) => ({ accountItemName: ai.get(d.account_item_id) ?? String(d.account_item_id), taxName: tn.get(d.tax_code) ?? String(d.tax_code), itemName: 'item_id' in d ? fin.get(d.item_id as number) ?? null : null, amount: d.amount, vat: d.vat })),
      },
      receipt: { fileName: b.fileName, documentType: 'invoice', description: b.description },
      action: reg.action, updateTargetDealId: num(reg.updateTargetDealId),
      canRegister: !b.reasons.length && ['PENDING', 'ERROR'].includes(reg.status), reasons: b.reasons,
    };
  }
  async register(actor: Actor, body: unknown) {
    const { registrationIds } = parse(z.object({ registrationIds: z.array(zUuid).min(1).max(100) }).strict(), body);
    const jobs: (bigint | null)[] = [];
    for (const id of [...new Set(registrationIds)]) jobs.push(await this.queue(actor, id, ['PENDING', 'ERROR']).catch(() => null));
    for (const j of jobs) await this.jobs.runNow(j).catch(() => undefined);
    return { results: await this.regDtos(registrationIds) };
  }
  async retry(actor: Actor, id: string) {
    const j = await this.queue(actor, parse(zUuid, id), ['ERROR']);
    await this.jobs.runNow(j).catch(() => undefined);
    const [r] = await this.regDtos([id]);
    return r;
  }
  /** 要対応・連携なしのものは受け付けない（FR-FRE-12） */
  private async queue(actor: Actor, id: string, from: string[]) {
    return this.prisma.tx(async (tx) => {
      const r = await tx.freeeRegistration.findUnique({ where: { id } });
      if (!r) throw notFound('freee 登録');
      if (!from.includes(r.status)) throw invalidState(`この状態（${r.status}）の登録はできません`);
      if (r.action !== 'DELETE') {
        const b = await this.build(tx, r.invoiceId);
        if (b.reasons.length) {
          const s = this.statusFor(b.reasons, 'REVIEW');
          await tx.freeeRegistration.update({ where: { id }, data: { status: s.status, reasons: s.reasons } });
          return null;
        }
      }
      await tx.freeeRegistration.update({ where: { id }, data: { status: 'QUEUED', reasons: [], requestedBy: actor.id, requestedAt: now(), attempts: 0 } });
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: r.invoiceId } });
      await this.audit.write(tx, actor, { action: 'FREEE_REGISTER', targetType: 'freee_registration', targetId: id, summary: `請求書 ${inv.invoiceNo} の freee への${r.status === 'ERROR' ? '再登録' : '登録'}を指示` });
      return this.jobs.enqueue(tx, r.action === 'DELETE' ? 'FREEE_DELETE' : 'FREEE_REGISTER', { registrationId: id }, { dedupeKey: `${r.action === 'DELETE' ? 'FREEE_DELETE' : 'FREEE_REGISTER'}:${r.invoiceId}` });
    });
  }
  async apiLogs(query: Record<string, unknown>) {
    const q = parse(z.object({ registrationId: zUuid.optional(), from: zDate.optional(), to: zDate.optional() }), query);
    const logs = await this.prisma.$queryRaw<{ id: bigint; registration_id: string | null; method: string; path: string; status_code: number | null; duration_ms: number | null; error: string | null; user_name: string | null; created_at: Date; request_summary: unknown; response_summary: unknown }[]>`
      SELECT l.id, l.registration_id, l.method, l.path, l.status_code, l.duration_ms, l.error, u.name AS user_name, l.created_at, l.request_summary, l.response_summary
      FROM freee_api_logs l LEFT JOIN users u ON u.id = l.requested_by
      WHERE (${q.registrationId ?? null}::uuid IS NULL OR l.registration_id = ${q.registrationId ?? null}::uuid)
        AND (${q.from ?? null}::date IS NULL OR l.created_at >= (${q.from ?? null}::date::timestamp AT TIME ZONE 'Asia/Tokyo'))
        AND (${q.to ?? null}::date IS NULL OR l.created_at < ((${q.to ?? null}::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo'))
      ORDER BY l.id DESC LIMIT 1000`;
    return logs.map((l) => ({ id: Number(l.id), registrationId: l.registration_id, method: l.method, path: l.path, statusCode: l.status_code, durationMs: l.duration_ms ?? 0, error: l.error, requestedBy: l.user_name, createdAt: isoJst(l.created_at), request: l.request_summary, response: l.response_summary }));
  }
}

const O = ['OFFICE', 'ADMIN'] as const;
@Controller()
export class FreeeController {
  constructor(private readonly s: FreeeService) {}
  @Get('freee/connection') @Roles(...O) connection() { return this.s.connection(); }
  @Patch('freee/connection') @Roles('ADMIN') update(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.updateConnection(a, b); }
  @Delete('freee/connection') @Roles('ADMIN') @HttpCode(204) async disconnect(@CurrentActor() a: Actor) { await this.s.disconnect(a); }
  @Post('freee/connection/authorize') @Roles('ADMIN') @HttpCode(200) authorize(@CurrentActor() a: Actor) { return this.s.authorize(a); }
  @Get('freee/oauth/callback') @Roles('ADMIN') callback(@CurrentActor() a: Actor, @Query() q: Record<string, unknown>, @Res() res: Response) { return this.s.callback(a, q, res); }
  @Get('freee/companies') @Roles('ADMIN') companies(@CurrentActor() a: Actor) { return this.s.companies(a); }
  @Get('freee/partners') @Roles('ADMIN') partners(@CurrentActor() a: Actor, @Query('keyword') k?: string) { return this.s.partners(a, k); }
  @Post('freee/partners') @Roles('ADMIN') createPartner(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.createPartner(a, b); }
  @Get('freee/partner-mappings') @Roles(...O) mappings(@CurrentActor() a: Actor) { return this.s.partnerMappings(a); }
  @Post('freee/partner-mappings/auto-match') @Roles('ADMIN') @HttpCode(200) autoMatch(@CurrentActor() a: Actor) { return this.s.autoMatch(a); }
  @Put('billing-parties/:id/freee-partner') @Roles('ADMIN') setPartner(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.setPartner(a, id, b); }
  @Get('freee/account-items') @Roles('ADMIN') accountItems(@CurrentActor() a: Actor) { return this.s.accountItems(a); }
  @Get('freee/taxes') @Roles('ADMIN') taxes(@CurrentActor() a: Actor) { return this.s.taxes(a); }
  @Get('freee/items') @Roles('ADMIN') items(@CurrentActor() a: Actor) { return this.s.items(a); }
  @Put('items/:id/freee-mapping') @Roles('ADMIN') itemMapping(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.setItemMapping(a, id, b); }
  @Get('freee/registrations') @Roles(...O) registrations(@Query() q: Record<string, unknown>) { return this.s.registrations(q); }
  @Get('freee/registrations/:id/preview') @Roles(...O) preview(@Param('id') id: string) { return this.s.preview(id); }
  @Post('freee/registrations/register') @Roles('ADMIN') @HttpCode(200) register(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.register(a, b); }
  @Post('freee/registrations/:id/retry') @Roles('ADMIN') @HttpCode(200) retry(@CurrentActor() a: Actor, @Param('id') id: string) { return this.s.retry(a, id); }
  @Get('freee/api-logs') @Roles(...O) logs(@Query() q: Record<string, unknown>) { return this.s.apiLogs(q); }
}

@Module({ providers: [FreeeService], controllers: [FreeeController], exports: [FreeeService] })
export class FreeeModule {}

export { toDate };
