/* 利用者管理（FR-CMN-03、SCR-60）と操作履歴（FR-CMN-04、SCR-61） */
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Actor, CurrentActor, Role, ROLE_JA, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { isoJst } from '../../common/dates';
import { AppError, conflict, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse, zDate, zIntQ, zUuid } from '../../common/validation';
import type { User } from '../../generated/prisma/client';
import { SessionService } from '../auth/session.service';
import { AuthModule } from '../auth/auth.module';
import { hashPassword, temporaryPassword } from '../auth/password';

const ROLES = ['RECEPTION', 'OFFICE', 'ADMIN', 'SIGN_TERMINAL'] as const;
const UserInput = z.object({
  loginId: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'ログイン ID は英小文字・数字・._- の3〜40文字'),
  name: z.string().trim().min(1).max(40), role: z.enum(ROLES), email: z.string().trim().email().nullable().optional(),
  mfaEnabled: z.boolean().optional(), pairedTerminalId: zUuid.nullable().optional(), active: z.boolean().optional(),
});
export const userDto = (u: User) => ({
  id: u.id, loginId: u.loginId, name: u.name, role: u.role as Role, email: u.email, mfaEnabled: u.mfaEnabled, pairedTerminalId: u.pairedTerminalId,
  lockedUntil: isoJst(u.lockedUntil), mustChangePassword: u.mustChangePassword, active: u.active, version: u.version,
});

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sessions: SessionService) {}

  async list() { return (await this.prisma.user.findMany({ orderBy: [{ active: 'desc' }, { role: 'asc' }, { loginId: 'asc' }] })).map(userDto); }

  private async check(tx: Tx, d: { role?: string; pairedTerminalId?: string | null; mfaEnabled?: boolean; email?: string | null }, selfId?: string) {
    if (d.pairedTerminalId) {
      if (d.role === 'SIGN_TERMINAL') throw new AppError('VALIDATION_ERROR', 'サイン端末に対の端末は設定できません');
      const t = await tx.user.findUnique({ where: { id: d.pairedTerminalId } });
      if (!t || t.role !== 'SIGN_TERMINAL' || t.id === selfId) throw new AppError('VALIDATION_ERROR', '対の端末にはサイン端末の利用者を選んでください');
    }
    if (d.role === 'ADMIN' && d.mfaEnabled && !d.email) throw new AppError('VALIDATION_ERROR', '2段階の確認を使う管理者にはメールアドレスが必要です');
  }

  async create(actor: Actor, body: unknown) {
    const b = parse(UserInput.strict(), body);
    const pw = temporaryPassword();
    const hash = await hashPassword(pw);
    const u = await this.prisma.tx(async (tx) => {
      if (await tx.user.findUnique({ where: { loginId: b.loginId } })) throw new AppError('VALIDATION_ERROR', 'そのログイン ID は使われています');
      await this.check(tx, b);
      const u = await tx.user.create({ data: { ...b, mfaEnabled: b.mfaEnabled ?? b.role === 'ADMIN', email: b.email ?? null, pairedTerminalId: b.pairedTerminalId ?? null, passwordHash: hash, mustChangePassword: true } });
      if (u.role === 'ADMIN' && u.mfaEnabled && !u.email) throw new AppError('VALIDATION_ERROR', '2段階の確認を使う管理者にはメールアドレスが必要です');
      await this.audit.write(tx, actor, { action: 'USER_CREATE', targetType: 'user', targetId: u.id, summary: `利用者「${u.name}」（${ROLE_JA[u.role as Role]}）を追加`, after: userDto(u) });
      return u;
    });
    return { user: userDto(u), temporaryPassword: pw };
  }

  async update(actor: Actor, id: string, body: unknown) {
    const b = parse(UserInput.partial().extend({ version: z.number().int() }).strict(), body);
    parse(zUuid, id);
    const { version, ...data } = b;
    return this.prisma.tx(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw notFound('利用者');
      if (id === actor.id && ((data.role && data.role !== before.role) || data.active === false)) throw new AppError('VALIDATION_ERROR', '自分の区分の変更・無効化はできません（ほかの管理者に頼んでください）');
      if (data.loginId && data.loginId !== before.loginId && (await tx.user.findUnique({ where: { loginId: data.loginId } }))) throw new AppError('VALIDATION_ERROR', 'そのログイン ID は使われています');
      const next = { ...before, ...data };
      await this.check(tx, next, id);
      if (before.role === 'ADMIN' && (next.role !== 'ADMIN' || !next.active)) {
        const admins = await tx.user.count({ where: { role: 'ADMIN', active: true, id: { not: id } } });
        if (!admins) throw new AppError('VALIDATION_ERROR', '有効な管理者が1人もいなくなります');
      }
      if (next.role === 'SIGN_TERMINAL' && before.role !== 'SIGN_TERMINAL') data.pairedTerminalId = null;
      const r = await tx.user.updateMany({ where: { id, version }, data });
      if (!r.count) throw conflict();
      const after = await tx.user.findUniqueOrThrow({ where: { id } });
      if (before.role !== after.role || !after.active) await this.sessions.revokeAllOf(id);
      const changed = Object.keys(data);
      await this.audit.write(tx, actor, {
        action: before.role !== after.role ? 'USER_ROLE_CHANGE' : 'USER_UPDATE', targetType: 'user', targetId: id,
        summary: `利用者「${after.name}」を${after.active ? '変更' : '無効に'}${before.role !== after.role ? `（${ROLE_JA[before.role as Role]} → ${ROLE_JA[after.role as Role]}）` : ''}`,
        before: Object.fromEntries(changed.map((k) => [k, (userDto(before) as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (userDto(after) as Record<string, unknown>)[k]])),
      });
      return userDto(after);
    });
  }

  async resetPassword(actor: Actor, id: string) {
    parse(zUuid, id);
    const pw = temporaryPassword();
    const hash = await hashPassword(pw);
    await this.prisma.tx(async (tx) => {
      const u = await tx.user.findUnique({ where: { id } });
      if (!u) throw notFound('利用者');
      await tx.user.update({ where: { id }, data: { passwordHash: hash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null } });
      await this.audit.write(tx, actor, { action: 'USER_PASSWORD_RESET', targetType: 'user', targetId: id, summary: `利用者「${u.name}」のパスワードを初期化（ロックも解除）` });
    });
    await this.sessions.revokeAllOf(id);
    return { temporaryPassword: pw };
  }

  /** 操作履歴（1ページ100件、08 1章） */
  async auditLogs(query: Record<string, unknown>) {
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional(), targetType: z.string().max(40).optional(), targetId: z.string().max(80).optional(), userId: zUuid.optional(), action: z.string().max(40).optional(), page: zIntQ.pipe(z.number().int().min(1)).optional() }), query);
    const where = {
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00+09:00`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00+09:00`).getTime() + 86400000) } : {}) } } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}), ...(q.targetId ? { targetId: q.targetId } : {}), ...(q.userId ? { userId: q.userId } : {}), ...(q.action ? { action: q.action } : {}),
    };
    const page = q.page ?? 1;
    const [items, total] = await Promise.all([this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 100, take: 100 }), this.prisma.auditLog.count({ where })]);
    return {
      items: items.map((a) => ({ id: Number(a.id), occurredAt: isoJst(a.occurredAt), userName: a.userName, role: a.role, action: a.action, targetType: a.targetType, targetId: a.targetId, summary: a.summary, before: a.beforeData, after: a.afterData, reason: a.reason })),
      total, page,
    };
  }
}

@Controller()
export class UsersController {
  constructor(private readonly s: UsersService) {}
  @Get('users') @Roles('ADMIN') list() { return this.s.list(); }
  @Post('users') @Roles('ADMIN') create(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.create(a, b); }
  @Patch('users/:id') @Roles('ADMIN') update(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.update(a, id, b); }
  @Post('users/:id/reset-password') @Roles('ADMIN') @HttpCode(200) reset(@CurrentActor() a: Actor, @Param('id') id: string) { return this.s.resetPassword(a, id); }
  @Get('audit-logs') @Roles('OFFICE', 'ADMIN') audit(@Query() q: Record<string, unknown>) { return this.s.auditLogs(q); }
}

@Module({ imports: [AuthModule], providers: [UsersService], controllers: [UsersController] })
export class UsersModule {}
