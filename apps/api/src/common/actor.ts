/* 操作した人（認証の Guard が req.actor に入れる） */
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export type Role = 'RECEPTION' | 'OFFICE' | 'ADMIN' | 'SIGN_TERMINAL';
export const ROLE_JA: Record<Role, string> = { RECEPTION: '受付', OFFICE: '本社', ADMIN: '管理者', SIGN_TERMINAL: 'サイン端末' };

export interface Actor {
  id: string; loginId: string; name: string; role: Role;
  sessionId: string; mfaPassed: boolean; mustChangePassword: boolean; pairedTerminalId: string | null;
  ip: string | null; requestId: string;
}
/** 利用者の操作でないもの（ジョブ・webhook） */
export interface SystemActor { id: null; name: string; role: null; ip: null; requestId: string | null }
export type AnyActor = Actor | SystemActor;
export const systemActor = (name = 'システム', requestId: string | null = null): SystemActor => ({ id: null, name, role: null, ip: null, requestId });

export const isOffice = (a: { role: string | null }) => a.role === 'OFFICE' || a.role === 'ADMIN';

/* ---- ルートの印 ---- */
export const ROLES_KEY = 'sf:roles';
export const PUBLIC_KEY = 'sf:public';
export const ALLOW_PENDING_KEY = 'sf:allowPending';
/** openapi.yaml の x-roles。'ANY' はログイン済みならだれでも */
export const Roles = (...roles: (Role | 'ANY')[]) => SetMetadata(ROLES_KEY, roles);
/** 認証なし（ログイン・webhook・ジョブ・稼働確認・署名付き URL） */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** 2段階の確認・パスワード変更の前でも呼べる（me・mfa・logout・password） */
export const AllowPending = () => SetMetadata(ALLOW_PENDING_KEY, true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => ctx.switchToHttp().getRequest().actor);
