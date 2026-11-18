'use client';
/* SCR-40 freee 登録（FR-FRE-10〜21）。確認してから登録・要対応の理由・送る内容の確認 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, cx, Dialog, Empty, ErrorBox, errMsg, FREEE_STATUS, Loading, PageHead, StatusPill, Table, Td, Th, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { useMe } from '@/lib/auth';
import { jdateShort, jdatetime, yen } from '@/lib/format';

interface Reg { id: string; invoiceId: string; invoiceNo: string; billingPartyName: string; issueDate: string; total: number; freeePartnerName: string | null; action: string; status: string; reasons: { code: string; message: string }[]; dealId: number | null; receiptId: number | null; freeeDealUrl: string | null; attempts: number; registeredAt: string | null; lastErrorMessage: string | null }
interface Preview { deal: { issueDate: string; dueDate: string; partnerName: string | null; refNumber: string; details: { accountItemName: string; taxName: string; itemName: string | null; amount: number; vat: number }[] }; receipt: { fileName: string; description: string }; action: string; canRegister: boolean; reasons: { code: string; message: string }[] }
const ACTION: Record<string, string> = { CREATE: '新規', UPDATE: '更新（再発行）', DELETE: '削除（取消）' };
const ORDER = ['PENDING', 'NEEDS_ACTION', 'ERROR', 'QUEUED', 'PROCESSING', 'REGISTERED', 'DELETED'];

export default function FreeeRegistrationsPage() {
  const me = useMe(); const admin = me.role === 'ADMIN'; const toast = useToast(); const qc = useQueryClient();
  const [status, setStatus] = useState<string>('PENDING'); const [sel, setSel] = useState<Set<string>>(new Set()); const [pv, setPv] = useState<Reg | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { const s = new URLSearchParams(location.search).get('status'); if (s) setStatus(s); }, []);
  const conn = useQuery({ queryKey: ['freee-conn'], queryFn: () => api.get<{ status: string; companyName: string | null; registrationMode: string }>('/freee/connection') });
  const q = useQuery({ queryKey: ['freee-regs'], queryFn: () => api.get<{ counts: Record<string, number>; items: Reg[] }>('/freee/registrations'), refetchInterval: (x) => (x.state.data?.items.some((r) => ['QUEUED', 'PROCESSING'].includes(r.status)) ? 3000 : 20000) });
  const preview = useQuery({ queryKey: ['freee-pv', pv?.id], enabled: !!pv, queryFn: () => api.get<Preview>(`/freee/registrations/${pv!.id}/preview`) });
  const list = (q.data?.items ?? []).filter((r) => !status || r.status === status);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['freee-regs'] }); setSel(new Set()); };
  const register = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = await api.post<{ results: Reg[] }>('/freee/registrations/register', { registrationIds: ids });
      const ok = r.results.filter((x) => x.status === 'REGISTERED').length;
      toast(`${ok} 件を freee に登録しました${ok < ids.length ? `（${ids.length - ok} 件は登録できませんでした。理由を見てください）` : ''}`, ok === ids.length ? 'ok' : 'warn');
      refresh(); setPv(null);
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <PageHead title="freee 登録" sub="メールで送った請求書を freee 会計に「取引（収入・未決済）」と「証憑（請求書 PDF）」で登録します"
        actions={admin && <Button kind="freee" busy={busy} disabled={!sel.size} onClick={() => register([...sel])}>選んだ {sel.size} 件を freee へ登録</Button>} />
      {conn.data && conn.data.status !== 'CONNECTED' && <Alert tone="err">freee と{conn.data.status === 'REAUTH_REQUIRED' ? '再連携が必要です' : '連携していません'}。<Link className="underline" href="/office/freee/settings/">連携の設定</Link>から許可してください。</Alert>}
      {conn.data?.status === 'CONNECTED' && <p className="text-sm">事業所：<b>{conn.data.companyName}</b>　登録のしかた：{conn.data.registrationMode === 'AUTO' ? '自動で登録（メール送信後すぐ）' : '確認してから登録'}</p>}
      <div className="flex flex-wrap gap-1">
        {ORDER.map((s) => <button key={s} type="button" onClick={() => { setStatus(s); setSel(new Set()); }} className={cx('h-8 rounded-full border px-3 text-sm', status === s ? 'border-navy bg-navy text-white' : 'border-line bg-white')}>{FREEE_STATUS[s][0]} <b className="num">{q.data?.counts[s] ?? 0}</b></button>)}
        <button type="button" onClick={() => setStatus('')} className={cx('h-8 rounded-full border px-3 text-sm', !status ? 'border-navy bg-navy text-white' : 'border-line bg-white')}>すべて</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !list.length ? <Empty>該当する登録はありません</Empty> : (
        <Table head={<><Th className="w-8" /><Th>請求書</Th><Th>請求先 → freee の取引先</Th><Th>請求日</Th><Th className="text-right">合計</Th><Th>処理</Th><Th>状態・理由</Th><Th>freee</Th><Th /></>}>
          {list.map((r) => (
            <tr key={r.id}>
              <Td>{admin && ['PENDING', 'ERROR'].includes(r.status) && <input type="checkbox" aria-label={`${r.invoiceNo} を選ぶ`} checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} />}</Td>
              <Td><Link className="font-bold text-info num hover:underline" href={`/office/invoice/?id=${r.invoiceId}`}>{r.invoiceNo}</Link></Td>
              <Td>{r.billingPartyName}<div className="text-xs text-gray-600">→ {r.freeePartnerName ?? <span className="text-warn">未対応付け</span>}</div></Td>
              <Td className="num">{jdateShort(r.issueDate)}</Td><Td className="text-right num">{yen(r.total)}</Td><Td className="text-xs">{ACTION[r.action]}</Td>
              <Td><StatusPill map={FREEE_STATUS} value={r.status} />{r.reasons.map((x) => <div key={x.code + x.message} className="mt-0.5 text-xs text-warn">{x.message}</div>)}{r.status === 'ERROR' && r.lastErrorMessage && <div className="text-xs text-err">{r.lastErrorMessage}</div>}</Td>
              <Td className="text-xs">{r.dealId ? <>取引 {r.dealId}<br />{jdatetime(r.registeredAt)}</> : '—'}</Td>
              <Td><div className="flex gap-1"><Button size="sm" onClick={() => setPv(r)}>送る内容</Button>
                {admin && r.status === 'ERROR' && <Button size="sm" onClick={async () => { try { await api.post(`/freee/registrations/${r.id}/retry`); toast('再登録しました'); } catch (e) { toast(errMsg(e), 'err'); } refresh(); }}>再登録</Button>}
                {r.reasons.some((x) => x.code === 'PARTNER_UNMAPPED') && <Link href="/office/freee/partners/" className="text-xs text-info hover:underline">取引先へ</Link>}
                {r.reasons.some((x) => x.code === 'ITEM_UNMAPPED') && admin && <Link href="/office/freee/items/" className="text-xs text-info hover:underline">品目へ</Link>}</div></Td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog open={!!pv} onClose={() => setPv(null)} title={`freee に送る内容　${pv?.invoiceNo ?? ''}`} width={720}
        footer={<><Button onClick={() => setPv(null)}>閉じる</Button>{admin && pv && ['PENDING', 'ERROR'].includes(pv.status) && <Button kind="freee" busy={busy} disabled={!preview.data?.canRegister} onClick={() => register([pv.id])}>この内容で freee へ登録</Button>}</>}>
        {preview.isLoading ? <Loading /> : preview.error ? <ErrorBox error={preview.error} /> : preview.data && (
          <div className="space-y-3 text-sm">
            {preview.data.reasons.map((r) => <Alert key={r.code + r.message}>{r.message}</Alert>)}
            <div className="grid grid-cols-2 gap-1"><div>取引の種類：収入（未決済）・{ACTION[preview.data.action]}</div><div>管理番号：{preview.data.deal.refNumber}</div><div>発生日：{preview.data.deal.issueDate}</div><div>決済期日：{preview.data.deal.dueDate}</div><div>取引先：{preview.data.deal.partnerName ?? '—'}</div></div>
            <Table head={<><Th>勘定科目</Th><Th>税区分</Th><Th>品目</Th><Th className="text-right">金額（税込）</Th><Th className="text-right">消費税</Th></>}>
              {preview.data.deal.details.map((d, k) => <tr key={k}><Td>{d.accountItemName}</Td><Td>{d.taxName}</Td><Td>{d.itemName ?? '—'}</Td><Td className="text-right num">{yen(d.amount)}</Td><Td className="text-right num">{yen(d.vat)}</Td></tr>)}
              <tr className="bg-cream font-bold"><Td colSpan={3}>合計</Td><Td className="text-right num">{yen(preview.data.deal.details.reduce((a, d) => a + d.amount, 0))}</Td><Td className="text-right num">{yen(preview.data.deal.details.reduce((a, d) => a + d.vat, 0))}</Td></tr>
            </Table>
            <div>証憑：{preview.data.receipt.fileName}（{preview.data.receipt.description}）</div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
