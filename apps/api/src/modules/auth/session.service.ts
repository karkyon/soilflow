/* セッション（NFR-13、13 3章）。Cookie __session に乱数（256ビット）、DB には SHA-256 だけ */
import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Role } from '../../common/actor';
import { config } from '../../common/config';
import { now } from '../../common/dates';
import { PrismaService } from '../../common/prisma.service';

export const SESSION_COOKIE = '__session';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionRow {
  id: string; user_id: string; mfa_passed: boolean; expires_at: Date; last_seen_at: Date; idle_ms: number; revoked_at: Date | null;
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 受付・サイン端末は12時間（無操作でも）、本社・管理者は無操作60分（最長12時間） */
  async create(userId: string, role: Role, mfaPassed: boolean, ip: string | null, userAgent: string | null) {
    const raw = randomBytes(32).toString('base64url');
    const idle = role === 'RECEPTION' || role === 'SIGN_TERMINAL' ? '12 hours' : '60 minutes';
    const t = now();
    await this.prisma.$executeRaw`
      INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, idle_timeout, mfa_passed, ip, user_agent)
      VALUES (${sha(raw)}, ${userId}::uuid, ${t}, ${t}, ${new Date(t.getTime() + 12 * 3600 * 1000)}, ${idle}::interval, ${mfaPassed},
              ${ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null}::inet, ${userAgent?.slice(0, 300) ?? null})`;
    return raw;
  }

  async find(raw: string): Promise<SessionRow | null> {
    if (!raw || raw.length > 100) return null;
    const rows = await this.prisma.$queryRaw<SessionRow[]>`
      SELECT id, user_id, mfa_passed, expires_at, last_seen_at, revoked_at, (extract(epoch from idle_timeout) * 1000)::float8 AS idle_ms
      FROM sessions WHERE id = ${sha(raw)}`;
    const s = rows[0];
    if (!s || s.revoked_at) return null;
    const t = now().getTime();
    if (s.expires_at.getTime() <= t || s.last_seen_at.getTime() + Number(s.idle_ms) <= t) return null;
    return s;
  }

  /** 30秒に1回だけ最終操作の時刻を進める */
  async touch(s: SessionRow) {
    if (now().getTime() - s.last_seen_at.getTime() < 30000) return;
    await this.prisma.$executeRaw`UPDATE sessions SET last_seen_at = ${now()} WHERE id = ${s.id}`;
  }
  markMfaPassed(id: string) { return this.prisma.$executeRaw`UPDATE sessions SET mfa_passed = true WHERE id = ${id}`; }
  revoke(id: string) { return this.prisma.$executeRaw`UPDATE sessions SET revoked_at = ${now()} WHERE id = ${id} AND revoked_at IS NULL`; }
  revokeAllOf(userId: string, exceptId?: string) {
    return this.prisma.$executeRaw`UPDATE sessions SET revoked_at = ${now()} WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND id <> ${exceptId ?? ''}`;
  }

  /** CSRF トークン＝セッションに結びついた HMAC（08 2章） */
  csrfFor(sessionId: string) { return createHmac('sha256', config.sessionSecret).update(`csrf:${sessionId}`).digest('base64url'); }
  checkCsrf(sessionId: string, token: string | undefined) {
    if (!token) return false;
    const a = Buffer.from(this.csrfFor(sessionId)), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  cookieOptions() {
    return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' as const, path: '/', maxAge: 12 * 3600 * 1000 };
  }
}
