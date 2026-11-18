/* すべての API の入口で、セッション・利用者区分（x-roles）・CSRF・2段階の確認を確かめる（NFR-15） */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Actor, ALLOW_PENDING_KEY, PUBLIC_KEY, Role, ROLES_KEY } from '../../common/actor';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { SESSION_COOKIE, SessionService } from './session.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const clientIp = (req: Request) => (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || null)?.replace(/^::ffff:/, '') ?? null;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionService, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor; requestId: string; cookies: Record<string, string> }>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const roles = this.reflector.getAllAndOverride<(Role | 'ANY')[]>(ROLES_KEY, targets);
    if (!roles?.length) throw new AppError('FORBIDDEN'); // 区分の書き忘れは拒否する

    const s = await this.sessions.find(req.cookies?.[SESSION_COOKIE]);
    if (!s) throw new AppError('UNAUTHENTICATED');
    const u = await this.prisma.user.findUnique({ where: { id: s.user_id } });
    if (!u || !u.active) throw new AppError('UNAUTHENTICATED');
    await this.sessions.touch(s);
    const actor: Actor = {
      id: u.id, loginId: u.loginId, name: u.name, role: u.role as Role, sessionId: s.id, mfaPassed: s.mfa_passed,
      mustChangePassword: u.mustChangePassword, pairedTerminalId: u.pairedTerminalId, ip: clientIp(req), requestId: req.requestId,
    };
    req.actor = actor;

    if (MUTATING.has(req.method) && !this.sessions.checkCsrf(s.id, req.header('x-csrf-token'))) throw new AppError('CSRF_INVALID');
    const pendingOk = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_KEY, targets);
    if (!pendingOk) {
      if (u.role === 'ADMIN' && u.mfaEnabled && !s.mfa_passed) throw new AppError('MFA_REQUIRED');
      if (u.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED');
    }
    if (!roles.includes('ANY') && !roles.includes(actor.role)) throw new AppError('FORBIDDEN');
    return true;
  }
}
