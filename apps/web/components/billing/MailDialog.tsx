'use client';
/* SCR-36 メール送信の確認（FR-MAL-01〜07、FR-FRE-22）。宛先・件名・本文・添付・freee の警告を見てから送る */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, errMsg, INVOICE_STATUS, Loading, StatusPill, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';

interface Preview { invoiceId: string; invoiceNo: string; status: string; to: string[]; cc: string[]; subject: string; body: string; attachmentName: string; hasPdf: boolean; warnings: string[] }
const WARN: Record<string, string> = { MAIL_TO_MISSING: '送付先メールがありません（請求先マスタで登録）', NOT_CONFIRMED: '確認済ではありません', FREEE_PARTNER_UNMAPPED: 'freee の取引先が対応付けられていません（送信後に要対応になります）', FREEE_ITEM_UNMAPPED: 'freee の勘定科目が未設定の品目があります（送信後に要対応になります）' };

export function MailDialog({ ids, onClose, onDone }: { ids: string[] | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const [open, setOpen] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ invoiceId: string; status: string; error?: { message: string } }[] | null>(null);
  useEffect(() => { setResults(null); setOpen(null); }, [ids]);
  const q = useQuery({ queryKey: ['mail-preview', ids], enabled: !!ids?.length, queryFn: () => api.post<{ items: Preview[] }>('/invoices/mail-preview', { invoiceIds: ids }) });
  const sendable = (q.data?.items ?? []).filter((p) => !p.warnings.includes('MAIL_TO_MISSING') && !p.warnings.includes('NOT_CONFIRMED'));
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ results: { invoiceId: string; status: string; error?: { message: string } }[] }>('/invoices/send', { invoiceIds: sendable.map((p) => p.invoiceId) });
      setResults(r.results);
      const ok = r.results.filter((x) => x.status === 'SENT').length;
      toast(`${ok} 件を送信しました${ok < r.results.length ? `（${r.results.length - ok} 件は送れませんでした）` : ''}`, ok === r.results.length ? 'ok' : 'warn');
      onDone();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  const no = (id: string) => q.data?.items.find((p) => p.invoiceId === id)?.invoiceNo ?? id;
  return (
    <Dialog open={!!ids} onClose={onClose} title={`メール送信の確認（${ids?.length ?? 0} 件）`} width={820}
      footer={results ? <Button kind="primary" onClick={onClose}>閉じる</Button> : <><Button onClick={onClose}>やめる</Button><Button kind="primary" busy={busy} disabled={!sendable.length} onClick={send}>{sendable.length} 件を送信する</Button></>}>
      {results ? (
        <div className="space-y-1">{results.map((r) => <div key={r.invoiceId} className="flex items-center gap-2 text-sm"><b className="w-32 num">{no(r.invoiceId)}</b><StatusPill map={INVOICE_STATUS} value={r.status} />{r.error && <span className="text-err">{r.error.message}</span>}</div>)}</div>
      ) : q.isLoading ? <Loading /> : (
        <div className="space-y-3">
          {sendable.length < (q.data?.items.length ?? 0) && <Alert>送れない請求書は送信から外します（警告を見てください）。</Alert>}
          {q.data?.items.map((p) => (
            <div key={p.invoiceId} className="rounded-lg border border-line p-3 text-sm">
              <div className="flex items-center gap-2"><b className="num">{p.invoiceNo}</b><StatusPill map={INVOICE_STATUS} value={p.status} /><span className="ml-auto text-xs text-gray-600">添付：{p.attachmentName}{!p.hasPdf && '（PDF 作成中）'}</span></div>
              <div className="mt-1">宛先：{p.to.join('、') || '—'}{p.cc.length > 0 && `　CC：${p.cc.join('、')}`}</div>
              <div>件名：{p.subject}</div>
              <button type="button" className="text-xs text-info hover:underline" onClick={() => setOpen(open === p.invoiceId ? null : p.invoiceId)}>{open === p.invoiceId ? '本文を閉じる' : '本文を見る'}</button>
              {open === p.invoiceId && <pre className="mt-1 whitespace-pre-wrap rounded bg-cream p-2 text-xs">{p.body}</pre>}
              {p.warnings.map((w) => <div key={w} className={`mt-1 text-xs font-bold ${w.startsWith('FREEE') ? 'text-warn' : 'text-err'}`}>⚠ {WARN[w]}</div>)}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
