/* 操作履歴（FR-CMN-04、08 5章）。業務の変更と同じトランザクションで1件書く。追記だけ */
import { Injectable } from '@nestjs/common';
import { AnyActor, ROLE_JA, Role } from './actor';
import { PrismaService, Prisma, Tx } from './prisma.service';

export interface AuditEntry {
  action: string; targetType: string; targetId?: string | null; summary: string;
  before?: unknown; after?: unknown; reason?: string | null;
}

const SECRET = /token|secret|password|authorization|code_verifier|passwordHash/i;
/** 鍵・パスワードを伏せる（13 6章） */
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || depth > 6) return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return '[binary]';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = SECRET.test(k) ? '[redacted]' : redact(x, depth + 1);
    return o;
  }
  return v;
}
const json = (v: unknown) => (v === undefined ? Prisma.DbNull : (redact(v) as Prisma.InputJsonValue));

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Tx, actor: AnyActor, e: AuditEntry) {
    await tx.auditLog.create({
      data: {
        userId: actor.id, userName: actor.name, role: actor.role ? ROLE_JA[actor.role as Role] : null,
        action: e.action, targetType: e.targetType, targetId: e.targetId ?? null, summary: e.summary.slice(0, 1000),
        beforeData: json(e.before), afterData: json(e.after), reason: e.reason ?? null,
        ip: actor.ip && /^[0-9a-fA-F:.]+$/.test(actor.ip) ? actor.ip : null, requestId: actor.requestId,
      },
    });
  }

  /** トランザクションの外で1件だけ書く（ログイン失敗など） */
  writeAlone(actor: AnyActor, e: AuditEntry) { return this.prisma.tx((tx) => this.write(tx, actor, e)); }
}
