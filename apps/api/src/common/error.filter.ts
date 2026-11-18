/* 例外を 08 3.1 の形に変換する。DB のトリガーのエラー（SF_…）もここで変換する（14 4章 No.10） */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from './errors';

const TRIGGER_CODES: Record<string, ErrorCode> = {
  INVOICE_FROZEN: 'INVOICE_FROZEN', TRIP_LOCKED_BY_SLIP: 'TRIP_LOCKED_BY_SLIP', TRIP_LOCKED_BY_INVOICE: 'TRIP_LOCKED_BY_INVOICE',
};

/** Prisma（ドライバアダプタ）・pg のエラーから PostgreSQL のコードと文言を取り出す */
export function dbErrorOf(e: unknown): { code: string; message: string; constraint?: string } | null {
  const x = e as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string; constraint?: unknown } } }; code?: string; message?: string };
  const c = x?.meta?.driverAdapterError?.cause;
  if (c?.originalCode) return { code: c.originalCode, message: c.originalMessage ?? '', constraint: typeof c.constraint === 'object' ? JSON.stringify(c.constraint) : (c.constraint as string | undefined) };
  if (x && typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code) && typeof x.message === 'string') return { code: x.code, message: x.message };
  if (x?.code === 'P2002') return { code: '23505', message: x.message ?? '' };
  if (x?.code === 'P2025') return { code: 'P2025', message: x.message ?? '' };
  return null;
}

export function toAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', '入力に誤りがあります', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const db = dbErrorOf(e);
  if (db) {
    const m = /SF_([A-Z_]+)/.exec(db.message);
    if (m && TRIGGER_CODES[m[1]]) return new AppError(TRIGGER_CODES[m[1]], db.message.replace(/^SF_[A-Z_]+:\s*/, ''));
    if (db.code === '23505') return new AppError('CONFLICT', '同じ内容のデータがすでにあります');
    if (db.code === '23503') return new AppError('VALIDATION_ERROR', '関係するデータが見つかりません（客先と現場・車番の組合せなど）');
    if (db.code === '23514') return new AppError('VALIDATION_ERROR', '入力の値が決まりに合いません');
    if (db.code === '22P02' || db.code === '22007' || db.code === '22008') return new AppError('VALIDATION_ERROR', '入力の形式に誤りがあります');
    if (db.code === 'P2025') return new AppError('NOT_FOUND');
  }
  return null;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');
  catch(e: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>(); const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId;
    let err = toAppError(e);
    if (!err && e instanceof HttpException) {
      const st = e.getStatus();
      const code: ErrorCode = st === 404 ? 'NOT_FOUND' : st === 401 ? 'UNAUTHENTICATED' : st === 403 ? 'FORBIDDEN' : st === 413 ? 'VALIDATION_ERROR' : st === 400 ? 'VALIDATION_ERROR' : 'INTERNAL';
      err = new AppError(code, code === 'VALIDATION_ERROR' ? (st === 413 ? 'ファイルが大きすぎます' : '入力に誤りがあります') : undefined);
    }
    if (!err) {
      this.log.error(`${req.method} ${req.path} requestId=${requestId}: ${(e as Error)?.stack ?? String(e)}`);
      err = new AppError('INTERNAL');
    }
    if (res.headersSent) return;
    res.status(err.status).json({ code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}), requestId });
  }
}
