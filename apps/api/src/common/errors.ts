/* 08 API設計書 3章のエラー */
export type ErrorCode =
  | 'VALIDATION_ERROR' | 'UNAUTHENTICATED' | 'MFA_REQUIRED' | 'FORBIDDEN' | 'CSRF_INVALID' | 'PASSWORD_CHANGE_REQUIRED'
  | 'NOT_FOUND' | 'CONFLICT' | 'TERMINAL_BUSY' | 'SLIP_NOT_AWAITING'
  | 'TRIP_LOCKED_BY_SLIP' | 'TRIP_LOCKED_BY_INVOICE' | 'FUTURE_TIME' | 'ROW_HAS_TRIPS' | 'NO_TRIPS_FOR_SLIP'
  | 'SLIP_LOCKED_BY_INVOICE' | 'INVALID_STATE' | 'INVOICE_FROZEN' | 'PRICE_TABLE_LOCKED' | 'MAIL_TO_MISSING'
  | 'FREEE_NOT_CONNECTED' | 'FREEE_MAPPING_MISSING' | 'FREEE_DEAL_SETTLED'
  | 'ACCOUNT_LOCKED' | 'RATE_LIMITED' | 'INTERNAL' | 'FREEE_UPSTREAM' | 'MAIL_UPSTREAM' | 'MAINTENANCE';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, MFA_REQUIRED: 401, FORBIDDEN: 403, CSRF_INVALID: 403, PASSWORD_CHANGE_REQUIRED: 403,
  NOT_FOUND: 404, CONFLICT: 409, TERMINAL_BUSY: 409, SLIP_NOT_AWAITING: 409,
  TRIP_LOCKED_BY_SLIP: 422, TRIP_LOCKED_BY_INVOICE: 422, FUTURE_TIME: 422, ROW_HAS_TRIPS: 422, NO_TRIPS_FOR_SLIP: 422,
  SLIP_LOCKED_BY_INVOICE: 422, INVALID_STATE: 422, INVOICE_FROZEN: 422, PRICE_TABLE_LOCKED: 422, MAIL_TO_MISSING: 422,
  FREEE_NOT_CONNECTED: 422, FREEE_MAPPING_MISSING: 422, FREEE_DEAL_SETTLED: 422,
  ACCOUNT_LOCKED: 423, RATE_LIMITED: 429, INTERNAL: 500, FREEE_UPSTREAM: 502, MAIL_UPSTREAM: 502, MAINTENANCE: 503,
};

const DEFAULT_MESSAGE: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'ログインしてください',
  MFA_REQUIRED: 'メールで届いた確認コードを入力してください',
  FORBIDDEN: 'この操作はできません',
  CSRF_INVALID: '画面を読み直してから、もう一度操作してください',
  PASSWORD_CHANGE_REQUIRED: 'パスワードを変更してください',
  NOT_FOUND: '見つかりません',
  CONFLICT: '他の人が先に変更しました。読み直してください',
  TRIP_LOCKED_BY_SLIP: '伝票に含まれる便は変更できません。伝票を取り消してから直してください',
  TRIP_LOCKED_BY_INVOICE: '送信済の請求書に含まれる便は変更できません。請求書の取消・再発行で直します',
  INVOICE_FROZEN: '送信済の請求書の内容は変更できません',
  INTERNAL: 'サーバーで問題が起きました。時間をおいてやり直してください',
};

export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message?: string, readonly details?: unknown) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code);
    this.status = STATUS[code];
  }
}

export const notFound = (what = '') => new AppError('NOT_FOUND', what ? `${what}が見つかりません` : undefined);
export const conflict = () => new AppError('CONFLICT');
export const invalidState = (message: string, details?: unknown) => new AppError('INVALID_STATE', message, details);
export const forbidden = (message?: string) => new AppError('FORBIDDEN', message);
