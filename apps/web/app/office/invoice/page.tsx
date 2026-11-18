'use client';
/* SCR-35 請求書の詳細（FR-BIL-05〜14）。明細・元の便と伝票・確認・作り直し・日付・送信・再送・取消・再発行 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { MailDialog } from '@/components/billing/MailDialog';
import { Alert, Button, Card, ConfirmDialog, Dialog, ErrorBox, errMsg, Field, FREEE_STATUS, Input, INVOICE_STATUS, Loading, PageHead, StatusPill, Table, Td, Th, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { jdate, jdatetime, yen } from '@/lib/format';

interface Line { lineNo: number; siteId: string | null; siteName: string | null; itemName: string; vehicleClassName: string; unitPrice: number; tripCount: number; amount: number; tripIds: string[]; slipIds: string[] }
interface Invoice {
  id: string; invoiceNo: string; billingPartyName: string; billingPartyHonorific: string; billingPartyPostal: string | null; billingPartyAddress: string | null; periodFrom: string; periodTo: string; issueDate: string; dueDate: string;
  subtotal: number; taxRate: number; taxAmount: number; total: number; status: string; freeeStatus: string | null; hasPdf: boolean; sentAt: string | null; version: number; lines: Line[];
  replacesInvoiceId: string | null; replacedByInvoiceId: string | null; voidReason: string | null; voidedAt: string | null; confirmedAt: string | null;
}
interface MailLog { id: string; kind: string; to: string[]; cc: string[]; subject: string; status: string; errorMessage: string | null; requestedBy: string; requestedAt: string }
const EDITABLE = ['DRAFT', 'NEEDS_RECHECK', 'CONFIRMED'];

export default function Page() { return <Suspense fallback={<Loading />}><InvoiceDetail /></Suspense>; }

function InvoiceDetail() {
  const id = useSearchParams().get('id') ?? ''; const toast = useToast(); const qc = useQueryClient(); const router = useRouter();
  const q = useQuery({ queryKey: ['invoice', id], enabled: !!id, queryFn: () => api.get<Invoice>(`/invoices/${id}`), refetchInterval: (x) => (x.state.data && (!x.state.data.hasPdf && EDITABLE.includes(x.state.data.status) || x.state.data.status === 'SENDING') ? 3000 : false) });
  const logs = useQuery({ queryKey: ['mail-logs', id], enabled: !!id, queryFn: () => api.get<MailLog[]>(`/invoices/${id}/mail-logs`) });
  const [dlg, setDlg] = useState<'void' | 'reissue' | 'dates' | 'resend' | 'mail' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dates, setDates] = useState({ issueDate: '', dueDate: '' }); const [resendTo, setResendTo] = useState(''); const [err, setErr] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoice', id] }); qc.invalidateQueries({ queryKey: ['mail-logs', id] }); qc.invalidateQueries({ queryKey: ['invoices'] }); };
  const act = async (key: string, path: string, msg: string) => {
    setBusy(key);
    try { await api.post(path, { version: q.data!.version }); toast(msg); refresh(); } catch (e) { toast(errMsg(e), 'err'); refresh(); } finally { setBusy(null); }
  };
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const i = q.data; const editable = EDITABLE.includes(i.status); const sent = ['SENT', 'SEND_ERROR'].includes(i.status);
  const sites: (string | null)[] = []; i.lines.forEach((l) => { if (!sites.includes(l.siteId)) sites.push(l.siteId); });

  return (
    <div className="space-y-4">
      <PageHead title={<>請求書 <span className="num">{i.invoiceNo}</span></>} sub={<Link className="text-info hover:underline" href="/office/billing/">← 請求の一覧へ</Link>}
        actions={<>
          <StatusPill map={INVOICE_STATUS} value={i.status} />
          <Button onClick={() => openFile(`/invoices/${i.id}/pdf`).catch((e) => toast(errMsg(e), 'err'))} disabled={!i.hasPdf && !editable}>PDF を開く</Button>
          {i.status === 'DRAFT' && <Button kind="primary" busy={busy === 'c'} onClick={() => act('c', `/invoices/${i.id}/confirm`, '確認済にしました')}>確認済にする</Button>}
          {i.status === 'CONFIRMED' && <Button busy={busy === 'u'} onClick={() => act('u', `/invoices/${i.id}/unconfirm`, '確認を取り消しました')}>確認を取り消す</Button>}
          {editable && <Button busy={busy === 'r'} onClick={() => act('r', `/invoices/${i.id}/rebuild`, '作り直しました')}>作り直す</Button>}
          {editable && <Button onClick={() => { setDates({ issueDate: i.issueDate, dueDate: i.dueDate }); setErr(null); setDlg('dates'); }}>日付を変える</Button>}
          {['CONFIRMED', 'SEND_ERROR'].includes(i.status) && <Button kind="primary" onClick={() => setDlg('mail')}>メールで送る</Button>}
          {sent && <Button onClick={() => { setResendTo(''); setErr(null); setDlg('resend'); }}>再送</Button>}
          {i.status !== 'VOIDED' && i.status !== 'SENDING' && <Button kind="danger" onClick={() => setDlg('void')}>取消</Button>}
          {sent && <Button kind="danger" onClick={() => setDlg('reissue')}>取消して再発行</Button>}
        </>} />
      {i.status === 'NEEDS_RECHECK' && <Alert>含まれる便が変わりました。「作り直す」で計算し直してから確認してください。</Alert>}
      {i.status === 'VOIDED' && <Alert tone="err">取消（{jdatetime(i.voidedAt)}）：{i.voidReason}{i.replacedByInvoiceId && <> → <Link className="underline" href={`/office/invoice/?id=${i.replacedByInvoiceId}`}>再発行した請求書</Link></>}</Alert>}
      {i.replacesInvoiceId && <Alert tone="info">再発行した請求書です（<Link className="underline" href={`/office/invoice/?id=${i.replacesInvoiceId}`}>元の請求書</Link>）</Alert>}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card title="内容">
          <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div><span className="text-gray-500">請求先　</span><b>{i.billingPartyName} {i.billingPartyHonorific}</b></div><div><span className="text-gray-500">請求期間　</span>{jdate(i.periodFrom)}〜{jdate(i.periodTo)}</div>
            <div className="text-xs text-gray-600">{i.billingPartyPostal && `〒${i.billingPartyPostal} `}{i.billingPartyAddress}</div><div><span className="text-gray-500">請求日　</span>{jdate(i.issueDate)}　<span className="text-gray-500">入金期日　</span>{jdate(i.dueDate)}</div>
          </div>
          <Table head={<><Th>品目</Th><Th>車格</Th><Th className="text-right">台数</Th><Th className="text-right">単価</Th><Th className="text-right">金額</Th><Th>元の伝票</Th></>}>
            {sites.map((s) => {
              const ls = i.lines.filter((l) => l.siteId === s);
              return [
                <tr key={`h${s}`} className="bg-cream"><Td colSpan={6} className="font-bold">■ 現場：{ls[0].siteName ?? '（現場なし）'}</Td></tr>,
                ...ls.map((l) => <tr key={l.lineNo}><Td>{l.itemName}</Td><Td>{l.vehicleClassName}</Td><Td className="text-right num">{l.tripCount}</Td><Td className="text-right num">{yen(l.unitPrice)}</Td><Td className="text-right num">{yen(l.amount)}</Td><Td className="text-xs">{l.slipIds.length ? `${l.slipIds.length} 枚` : '—'}</Td></tr>),
                <tr key={`s${s}`}><Td colSpan={4} className="text-right text-xs text-gray-600">現場の小計</Td><Td className="text-right num">{yen(ls.reduce((a, l) => a + l.amount, 0))}</Td><Td /></tr>,
              ];
            })}
          </Table>
          <div className="mt-3 ml-auto w-72 space-y-1 text-sm">
            <div className="flex justify-between"><span>小計（税抜）</span><span className="num">{yen(i.subtotal)} 円</span></div>
            <div className="flex justify-between"><span>{i.taxRate}%対象 {yen(i.subtotal)}円　消費税</span><span className="num">{yen(i.taxAmount)} 円</span></div>
            <div className="flex justify-between border-t border-navy pt-1 text-lg font-bold"><span>合計（税込）</span><span className="num">{yen(i.total)} 円</span></div>
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="freee 会計"><div className="flex items-center gap-2"><StatusPill map={FREEE_STATUS} value={i.freeeStatus} />{!i.freeeStatus && <span className="text-sm text-gray-500">メール送信に成功すると登録待ちになります</span>}</div>{i.freeeStatus && <Link className="mt-2 block text-sm text-info hover:underline" href="/office/freee/">freee 登録へ</Link>}</Card>
          <Card title="送信履歴">
            {!logs.data?.length ? <p className="text-sm text-gray-500">まだ送っていません</p> : <div className="space-y-2">{logs.data.map((l) => (
              <div key={l.id} className="border-b border-line pb-2 text-xs"><div className="flex justify-between"><b>{l.kind === 'SEND' ? '送信' : '再送'}　{jdatetime(l.requestedAt)}</b><span className={l.status === 'FAILED' ? 'font-bold text-err' : l.status === 'SENT' ? 'text-ok' : ''}>{l.status === 'SENT' ? '送信済' : l.status === 'FAILED' ? '失敗' : '送信中'}</span></div>
                <div>宛先：{l.to.join('、')}</div><div className="text-gray-500">{l.requestedBy}</div>{l.errorMessage && <div className="text-err">{l.errorMessage}</div>}</div>
            ))}</div>}
          </Card>
        </div>
      </div>
      <ConfirmDialog open={dlg === 'void'} onClose={() => setDlg(null)} title={`請求書 ${i.invoiceNo} の取消`} danger needReason okLabel="取り消す"
        message={<>請求書を取り消すと、含まれていた便は再び請求の対象になります。{i.freeeStatus === 'REGISTERED' && <b className="mt-1 block">freee の取引も削除します（freee で決済済みなら自動では消しません）。</b>}</>}
        onOk={async (reason) => { await api.post(`/invoices/${i.id}/void`, { version: i.version, reason }); toast('請求書を取り消しました'); refresh(); }} />
      <ConfirmDialog open={dlg === 'reissue'} onClose={() => setDlg(null)} title={`請求書 ${i.invoiceNo} を取消して再発行`} danger needReason okLabel="再発行する"
        message={<>この請求書を取り消し、同じ請求先・同じ請求期間で新しい番号の請求書（作成済）を作ります。{i.freeeStatus === 'REGISTERED' && ' freee の取引は、新しい請求書を送ったときに更新します。'}</>}
        onOk={async (reason) => { const n = await api.post<{ id: string; invoiceNo: string }>(`/invoices/${i.id}/reissue`, { version: i.version, reason }); toast(`${n.invoiceNo} を作りました`); refresh(); router.push(`/office/invoice/?id=${n.id}`); }} />
      <Dialog open={dlg === 'dates'} onClose={() => setDlg(null)} title="請求日・入金期日" width={420}
        footer={<><Button onClick={() => setDlg(null)}>やめる</Button><Button kind="primary" busy={busy === 'd'} onClick={async () => { setBusy('d'); setErr(null); try { await api.patch(`/invoices/${i.id}`, { version: i.version, ...dates }); toast('日付を変えました'); refresh(); setDlg(null); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } }}>保存</Button></>}>
        <div className="space-y-3"><Field label="請求日"><Input type="date" value={dates.issueDate} onChange={(e) => setDates({ ...dates, issueDate: e.target.value })} /></Field>
          <Field label="入金期日" error={err}><Input type="date" value={dates.dueDate} onChange={(e) => setDates({ ...dates, dueDate: e.target.value })} /></Field></div>
      </Dialog>
      <Dialog open={dlg === 'resend'} onClose={() => setDlg(null)} title="再送" width={480}
        footer={<><Button onClick={() => setDlg(null)}>やめる</Button><Button kind="primary" busy={busy === 's'} onClick={async () => {
          setBusy('s'); setErr(null);
          try { const to = resendTo.split(/[,、;\s]+/).filter(Boolean); await api.post(`/invoices/${i.id}/resend`, to.length ? { to } : {}); toast('再送しました'); refresh(); setDlg(null); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
        }}>再送する</Button></>}>
        <Field label="宛先（変えるときだけ。複数はカンマ区切り）" error={err} hint="空のままなら請求先マスタの送付先へ送ります"><Input value={resendTo} onChange={(e) => setResendTo(e.target.value)} placeholder="keiri@example.jp" /></Field>
      </Dialog>
      <MailDialog ids={dlg === 'mail' ? [i.id] : null} onClose={() => setDlg(null)} onDone={refresh} />
    </div>
  );
}
