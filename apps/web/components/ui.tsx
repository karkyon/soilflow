'use client';
/* 共通の部品（05 画面設計書 1章）。色だけで意味を表さない・Tab で操作できる・Esc で閉じる */
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/client';

export const cx = (...a: (string | number | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/* ---------------------------------------------------------------- ボタン */
type BtnKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'navy' | 'freee';
const BTN: Record<BtnKind, string> = {
  primary: 'bg-gold text-white hover:bg-gold-dark border border-gold',
  navy: 'bg-navy text-white hover:bg-navy-2 border border-navy',
  secondary: 'bg-white text-navy border border-line hover:bg-gold-pale',
  danger: 'bg-white text-err border border-err/40 hover:bg-err-bg',
  ghost: 'bg-transparent text-info hover:underline border border-transparent',
  freee: 'bg-freee text-white border border-freee hover:opacity-90',
};
export function Button({ kind = 'secondary', size = 'md', busy, className, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  return (
    <button type="button" {...p} disabled={p.disabled || busy}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-md font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-14 px-6 text-lg' : 'h-9 px-4 text-sm', BTN[kind], className)}>
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- 状態の表示（05 1.3） */
export type Tone = 'gray' | 'ok' | 'warn' | 'err' | 'info';
const TONE: Record<Tone, string> = { gray: 'bg-gray-100 text-gray-700 border-gray-300', ok: 'bg-ok-bg text-ok border-ok/30', warn: 'bg-warn-bg text-warn border-warn/30', err: 'bg-err-bg text-err border-err/30', info: 'bg-info-bg text-info border-info/30' };
export const Pill = ({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold', TONE[tone])}><span aria-hidden>●</span>{children}</span>
);
export const SLIP_STATUS: Record<string, [string, Tone]> = {
  DRAFT: ['作成', 'gray'], AWAITING_SIGNATURE: ['サイン待ち', 'warn'], SIGNED: ['サイン済', 'ok'], PAPER_PRINTED: ['紙で印刷', 'warn'], PAPER_SIGNED: ['紙サイン登録済', 'ok'], CANCELLED: ['取消', 'err'],
};
export const INVOICE_STATUS: Record<string, [string, Tone]> = {
  DRAFT: ['作成済（未確認）', 'gray'], NEEDS_RECHECK: ['要再確認', 'warn'], CONFIRMED: ['確認済', 'info'], SENDING: ['送信中', 'info'], SENT: ['送信済', 'ok'], SEND_ERROR: ['送信エラー', 'err'], VOIDED: ['取消', 'err'],
};
export const FREEE_STATUS: Record<string, [string, Tone]> = {
  PENDING: ['登録待ち', 'info'], NEEDS_ACTION: ['要対応', 'warn'], QUEUED: ['処理待ち', 'info'], PROCESSING: ['処理中', 'info'], REGISTERED: ['登録済', 'ok'], ERROR: ['エラー', 'err'], DELETED: ['削除済', 'gray'],
};
export const StatusPill = ({ map, value }: { map: Record<string, [string, Tone]>; value: string | null | undefined }) => (value && map[value] ? <Pill tone={map[value][1]}>{map[value][0]}</Pill> : <span className="text-gray-400">—</span>);

/* ---------------------------------------------------------------- 入力 */
export function Field({ label, error, hint, children, required }: { label: string; error?: string | null; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-bold text-navy">{label}{required && <span className="ml-1 text-err">*</span>}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-bold text-err" role="alert">{error}</span>}
    </label>
  );
}
export const inputCls = 'h-9 w-full rounded-md border border-line bg-white px-2.5 text-sm focus:border-gold focus:outline-none disabled:bg-gray-100';
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, 'h-auto min-h-20 py-2', p.className)} />;

/* ---------------------------------------------------------------- ダイアログ */
export function Dialog({ open, onClose, title, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus(), 0);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy/40 p-6 pt-16" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" className="w-full rounded-lg bg-white shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between rounded-t-lg bg-navy px-5 py-3 text-white">
          <h2 className="text-base font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="閉じる" className="text-xl leading-none opacity-80 hover:opacity-100">×</button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** 理由の入力・確認（取消・再発行・連携の解除、05 1.4） */
export function ConfirmDialog({ open, onClose, title, message, needReason, okLabel = '実行する', danger, onOk }: {
  open: boolean; onClose: () => void; title: string; message: ReactNode; needReason?: boolean; okLabel?: string; danger?: boolean; onOk: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setErr(null); } }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={title} width={480}
      footer={<><Button onClick={onClose}>やめる</Button><Button kind={danger ? 'danger' : 'primary'} busy={busy} disabled={needReason && !reason.trim()}
        onClick={async () => { setBusy(true); setErr(null); try { await onOk(reason.trim()); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>{okLabel}</Button></>}>
      <div className="space-y-3">
        <div className="text-sm leading-relaxed">{message}</div>
        {needReason && <Field label="理由" required error={err}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>}
        {!needReason && err && <p className="text-sm font-bold text-err">{err}</p>}
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- トースト（05 1.4） */
type ToastItem = { id: number; text: string; tone: Tone };
const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: Tone = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'err' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2" aria-live="polite">
        {items.map((t) => <div key={t.id} className={cx('pointer-events-auto rounded-lg border px-5 py-2.5 text-sm font-bold shadow-lg', TONE[t.tone])}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

/* ---------------------------------------------------------------- 枠 */
export const Card = ({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cx('rounded-lg border border-line bg-white', className)}>
    {(title || actions) && <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5"><h3 className="font-bold text-navy">{title}</h3><div className="flex items-center gap-2">{actions}</div></div>}
    <div className="p-4">{children}</div>
  </section>
);
export const PageHead = ({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div><h1 className="text-xl font-bold text-navy">{title}</h1>{sub && <p className="mt-1 text-[13px] text-gray-600">{sub}</p>}</div>
    <div className="flex flex-wrap items-center gap-2">{actions}</div>
  </div>
);
export const Loading = () => <div className="py-10 text-center text-gray-500">読み込み中…</div>;
export const ErrorBox = ({ error }: { error: unknown }) => (error ? <div className="rounded-md border border-err/30 bg-err-bg px-4 py-3 text-sm font-bold text-err" role="alert">{errMsg(error)}</div> : null);
export const Empty = ({ children }: { children: ReactNode }) => <div className="py-8 text-center text-gray-500">{children}</div>;
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => <th className={cx('border-b border-line bg-navy px-3 py-2 text-left text-[13px] font-bold text-white', className)}>{children}</th>;
export const Td = ({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cx('border-b border-line px-3 py-2 align-middle', className)}>{children}</td>;
export function Table({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  return <div className={cx('overflow-x-auto rounded-lg border border-line bg-white', className)}><table className="w-full text-sm"><thead><tr>{head}</tr></thead><tbody>{children}</tbody></table></div>;
}
export const Alert = ({ tone = 'warn', children }: { tone?: Tone; children: ReactNode }) => <div className={cx('rounded-md border px-4 py-2.5 text-sm', TONE[tone])} role={tone === 'err' ? 'alert' : undefined}>{children}</div>;
