'use client';
/* 現金の領収書（FR-BIL-15、設計案）。期間の一覧・日ごとの現金の合計（照合）・取消 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, ConfirmDialog, Empty, ErrorBox, errMsg, Input, Loading, PageHead, Pill, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { addDays, jdate, jdatetime, today, yen } from '@/lib/format';

interface Receipt { id: string; receiptNo: string; receiptDate: string; slipNo: string; siteName: string | null; billingPartyName: string; addresseeName: string; subtotal: number; taxAmount: number; total: number; revenueStamp: boolean; receivedByName: string; receivedAt: string; status: string; voidReason: string | null; voidedAt: string | null; voidedByName: string | null; version: number }
interface List { items: Receipt[]; byDate: { date: string; count: number; total: number }[]; total: { count: number; total: number } }

export default function CashPage() {
  const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = useState({ from: addDays(today(), -30), to: today(), status: '' }); const [v, setV] = useState<Receipt | null>(null);
  const q = useQuery({ queryKey: ['cash-receipts', f], queryFn: () => api.get<List>('/cash-receipts', { from: f.from, to: f.to, status: f.status || undefined }) });
  const st = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ cashPaymentEnabled: boolean }>('/settings') });
  return (
    <div className="space-y-4">
      <PageHead title="現金の領収書" sub="現金のお客さま（請求先の支払い方法が「現金」）は、伝票ごとにその場で受け取り、締めの請求書には入れません（設計案：Q-29 の回答で決めます）"
        actions={<><Input type="date" className="w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="から" />〜<Input type="date" className="w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="まで" />
          <Select className="w-32" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">すべて</option><option value="ACTIVE">有効</option><option value="VOIDED">取消</option></Select></>} />
      {st.data && !st.data.cashPaymentEnabled && <Alert>現金の領収書は使わない設定です（システム設定の「現金のお客さま」で有効にします）。</Alert>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : q.data && <>
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="rounded-lg border border-line bg-white p-3">
            <div className="mb-2 text-[13px] font-bold text-navy">日ごとの現金（取消を除く）</div>
            {!q.data.byDate.length ? <p className="text-sm text-gray-500">ありません</p> : <table className="w-full text-sm"><tbody>
              {q.data.byDate.map((d) => <tr key={d.date} className="border-b border-line"><td className="py-1">{jdate(d.date)}</td><td className="text-right num">{d.count}枚</td><td className="text-right font-bold num">¥{yen(d.total)}</td></tr>)}
              <tr className="font-bold"><td className="py-1">合計</td><td className="text-right num">{q.data.total.count}枚</td><td className="text-right num">¥{yen(q.data.total.total)}</td></tr></tbody></table>}
          </div>
          {!q.data.items.length ? <Empty>領収書はありません</Empty> : (
            <Table head={<><Th>番号</Th><Th>日付</Th><Th>宛名・請求先</Th><Th>伝票</Th><Th className="text-right">合計（税込）</Th><Th>受け取った人</Th><Th>状態</Th><Th className="w-40" /></>}>
              {q.data.items.map((r) => (
                <tr key={r.id} className={r.status === 'VOIDED' ? 'opacity-60' : ''}>
                  <Td className="font-bold num">{r.receiptNo}</Td><Td className="num">{r.receiptDate}</Td>
                  <Td>{r.addresseeName} 様<div className="text-xs text-gray-600">{r.billingPartyName}{r.siteName ? `・${r.siteName}` : ''}</div></Td><Td className="text-xs num">{r.slipNo}</Td>
                  <Td className="text-right font-bold num">¥{yen(r.total)}{r.revenueStamp && <div className="text-[11px] font-normal text-warn">収入印紙</div>}</Td>
                  <Td className="text-xs">{r.receivedByName}<div className="text-gray-500">{jdatetime(r.receivedAt)}</div></Td>
                  <Td>{r.status === 'ACTIVE' ? <Pill tone="ok">有効</Pill> : <><Pill tone="gray">取消</Pill><div className="text-xs text-gray-600">{r.voidReason}（{r.voidedByName}）</div></>}</Td>
                  <Td><div className="flex gap-1"><Button size="sm" onClick={() => openFile(`/cash-receipts/${r.id}/pdf`).catch((e) => toast(errMsg(e), 'err'))}>PDF</Button>
                    {r.status === 'ACTIVE' && <Button size="sm" kind="danger" onClick={() => setV(r)}>取消</Button>}</div></Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </>}
      <ConfirmDialog open={!!v} onClose={() => setV(null)} title={`領収書 ${v?.receiptNo} の取消`} danger needReason okLabel="取り消す"
        message="返金したとき・金額を誤ったときに取り消します。伝票の便は請求の対象に戻ります（出し直すか、月の締めで請求書に入れます）。お客さまに渡した領収書は回収してください。"
        onOk={async (reason) => { await api.post(`/cash-receipts/${v!.id}/void`, { version: v!.version, reason }); toast('領収書を取り消しました'); qc.invalidateQueries({ queryKey: ['cash-receipts'] }); qc.invalidateQueries({ queryKey: ['slips'] }); }} />
    </div>
  );
}
