/* ログイン・2段階の確認・ログアウト・自分の情報・パスワード変更（FR-CMN-01・02、NFR-12・13） */
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, Req, Res } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { MAIL, MailAdapter } from '../../adapters/mail';
import { Actor, AllowPending, CurrentActor, Public, Role, Roles, systemActor } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { config } from '../../common/config';
import { now } from '../../common/dates';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { parse } from '../../common/validation';
import { SettingsModule, SettingsService } from '../settings/settings.module';
import { clientIp } from './auth.guard';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password';
import { SESSION_COOKIE, SessionService } from './session.service';

const LOCK_AFTER = 5, LOCK_MS = 15 * 60 * 1000, MFA_TTL_MS = 10 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** 1分あたりの回数制限（IP ごと。ログインは10回/分、13 2章） */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 60000) {}
  take(key: string) {
    const t = Date.now(); const a = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (a.length >= this.limit) { this.hits.set(key, a); return false; }
    a.push(t); this.hits.set(key, a);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
  reset() { this.hits.clear(); }
}
export const loginLimiter = new RateLimiter(10);
// 失敗が1時間に20回を超えたら知らせる（13 8章）。Cloud Logging のアラートで拾う
const failureWindow: number[] = [];

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService, private readonly sessions: SessionService, private readonly audit: AuditService,
    private readonly settings: SettingsService, @Inject(MAIL) private readonly mail: MailAdapter,
  ) {}

  async me(a: { id: string; sessionId: string; mfaPassed?: boolean }) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    const st = await this.settings.get();
    return {
      id: u.id, loginId: u.loginId, name: u.name, role: u.role as Role, pairedTerminalId: u.pairedTerminalId,
      mustChangePassword: u.mustChangePassword, mfaRequired: u.role === 'ADMIN' && u.mfaEnabled && !a.mfaPassed,
      csrfToken: this.sessions.csrfFor(a.sessionId), reportHours: { first: st.reportFirstHour, last: st.reportLastHour }, serverTime: new Date(now()).toISOString(),
    };
  }

  async login(req: Request, res: Response, body: unknown) {
    const { loginId, password } = parse(z.object({ loginId: z.string().trim().min(1).max(40), password: z.string().min(1).max(200) }), body);
    const ip = clientIp(req);
    if (!loginLimiter.take(`login:${ip}`)) throw new AppError('RATE_LIMITED', '短い時間にログインが多すぎます。1分ほど待ってください');
    const u = await this.prisma.user.findUnique({ where: { loginId: loginId.toLowerCase() } });
    const actor = { ...systemActor(u?.name ?? loginId, (req as Request & { requestId: string }).requestId), ip } as unknown as Actor;
    if (u?.lockedUntil && u.lockedUntil > now()) {
      throw new AppError('ACCOUNT_LOCKED', `続けて間違えたため、${new Date(u.lockedUntil).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })} までログインできません`);
    }
    const ok = !!u && u.active && (await verifyPassword(u.passwordHash, password));
    if (!ok) {
      if (u) {
        const n = u.failedLoginCount + 1; const lock = n >= LOCK_AFTER;
        await this.prisma.tx(async (tx) => {
          await tx.user.update({ where: { id: u.id }, data: { failedLoginCount: lock ? 0 : n, lockedUntil: lock ? new Date(now().getTime() + LOCK_MS) : u.lockedUntil } });
          await this.audit.write(tx, { ...actor, id: u.id }, { action: 'LOGIN_FAILED', targetType: 'user', targetId: u.id, summary: `${u.name} のログインに失敗${lock ? '（5回続けて失敗したため15分ロック）' : `（${n}回目）`}` });
        });
      }
      const t = Date.now(); failureWindow.push(t); while (failureWindow.length && t - failureWindow[0] > 3600000) failureWindow.shift();
      if (failureWindow.length > 20) console.warn(JSON.stringify({ severity: 'WARNING', alert: 'LOGIN_FAILURES', count: failureWindow.length }));
      throw new AppError('UNAUTHENTICATED', 'ログイン ID かパスワードが違います');
    }
    const needMfa = u.role === 'ADMIN' && u.mfaEnabled;
    const raw = await this.sessions.create(u.id, u.role as Role, !needMfa, ip, req.header('user-agent') ?? null);
    await this.prisma.tx(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await this.audit.write(tx, { ...actor, id: u.id, role: u.role as Role }, { action: 'LOGIN', targetType: 'user', targetId: u.id, summary: `${u.name} がログイン${needMfa ? '（確認コードを送信）' : ''}` });
    });
    if (needMfa) await this.sendMfaCode(u.id, u.email, u.name);
    res.cookie(SESSION_COOKIE, raw, this.sessions.cookieOptions());
    const sid = sha(raw);
    return { mfaRequired: needMfa, me: await this.me({ id: u.id, sessionId: sid, mfaPassed: !needMfa }) };
  }

  private async sendMfaCode(userId: string, email: string | null, name: string) {
    if (!email) throw new AppError('INVALID_STATE', '確認コードの送り先メールが登録されていません。ほかの管理者に登録を頼んでください');
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    await this.prisma.mfaCode.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now() } });
    await this.prisma.mfaCode.create({ data: { userId, codeHash: sha(`${userId}:${code}`), expiresAt: new Date(now().getTime() + MFA_TTL_MS) } });
    const st = await this.settings.get();
    await this.mail.send({
      from: st.mailFromAddress ?? 'no-reply@soilflow.local', fromName: 'SoilFlow', to: [email],
      subject: '【SoilFlow】ログインの確認コード', text: `${name} 様\n\nSoilFlow のログインの確認コードは ${code} です（10分間有効）。\n心当たりがない場合は、このメールを破棄し、管理者に連絡してください。`,
    });
  }

  async verifyMfa(a: Actor, body: unknown) {
    const { code } = parse(z.object({ code: z.string().regex(/^[0-9]{6}$/, '6桁の数字') }), body);
    const c = await this.prisma.mfaCode.findFirst({ where: { userId: a.id, usedAt: null, expiresAt: { gt: now() } }, orderBy: { expiresAt: 'desc' } });
    if (!c || c.attempts >= 5) throw new AppError('UNAUTHENTICATED', '確認コードの期限が切れました。もう一度ログインしてください');
    if (c.codeHash !== sha(`${a.id}:${code}`)) {
      await this.prisma.mfaCode.update({ where: { id: c.id }, data: { attempts: c.attempts + 1 } });
      throw new AppError('UNAUTHENTICATED', '確認コードが違います');
    }
    await this.prisma.mfaCode.update({ where: { id: c.id }, data: { usedAt: now() } });
    await this.sessions.markMfaPassed(a.sessionId);
    return this.me({ ...a, mfaPassed: true });
  }

  async logout(req: Request & { actor?: Actor }, res: Response) {
    const s = await this.sessions.find(req.cookies?.[SESSION_COOKIE]);
    if (s) {
      await this.sessions.revoke(s.id);
      const u = await this.prisma.user.findUnique({ where: { id: s.user_id } });
      if (u) await this.audit.writeAlone({ ...systemActor(u.name, (req as Request & { requestId: string }).requestId), id: u.id, role: u.role as Role, ip: clientIp(req) } as unknown as Actor, { action: 'LOGOUT', targetType: 'user', targetId: u.id, summary: `${u.name} がログアウト` });
    }
    res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' });
  }

  async changePassword(a: Actor, body: unknown) {
    const { current, next } = parse(z.object({ current: z.string().min(1), next: z.string().min(12, 'パスワードは12文字以上にしてください') }), body);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    if (!(await verifyPassword(u.passwordHash, current))) throw new AppError('VALIDATION_ERROR', '今のパスワードが違います');
    if (current === next) throw new AppError('VALIDATION_ERROR', '新しいパスワードは今と違うものにしてください');
    assertPasswordPolicy(next, u.loginId);
    const hash = await hashPassword(next);
    await this.prisma.tx(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { passwordHash: hash, mustChangePassword: false, passwordChangedAt: now() } });
      await this.audit.write(tx, a, { action: 'USER_PASSWORD_CHANGE', targetType: 'user', targetId: u.id, summary: `${u.name} が自分のパスワードを変更` });
    });
    await this.sessions.revokeAllOf(u.id, a.sessionId);
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login') @Public() @HttpCode(200)
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() b: unknown) { return this.auth.login(req, res, b); }
  @Post('mfa') @Roles('ADMIN') @AllowPending() @HttpCode(200)
  mfa(@CurrentActor() a: Actor, @Body() b: unknown) { return this.auth.verifyMfa(a, b); }
  @Post('logout') @Public() @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { await this.auth.logout(req, res); }
  @Get('me') @Roles('ANY') @AllowPending()
  me(@CurrentActor() a: Actor) { return this.auth.me(a); }
  @Post('password') @Roles('ANY') @AllowPending() @HttpCode(204)
  async password(@CurrentActor() a: Actor, @Body() b: unknown) { await this.auth.changePassword(a, b); }
}

@Module({ imports: [SettingsModule], providers: [AuthService, SessionService], controllers: [AuthController], exports: [SessionService, AuthService] })
export class AuthModule {}
