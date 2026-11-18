'use client';
/* SCR-61 操作履歴（FR-CMN-04）。追記のみ。1ページ100件 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Empty, ErrorBox, Input, Loading, PageHead, Select, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api/client';
import { addDays, jdatetime, today } from '@/lib/format';

interface Log { id: number; occurredAt: string; userName: string | null; role: string | null; action: string; targetType: string; targetId: string | null; summary: string; before: unknown; after: unknown; reason: string | null }
const TYPES = [['', 'すべて'], ['trip', '便'], ['report_row', '日報の行'], ['slip', '伝票'], ['invoice', '請求書'], ['billing_run', '締め'], ['freee_registration', 'freee 登録'], ['freee_connection', 'freee 連携'], ['billing_party', '請求先'], ['customer', '客先'], ['item', '品目'], ['price_table', '単価表'], ['user', '利用者'], ['settings', '設定']];

export default function AuditPage() {
  const [f, setF] = useState({ from: addDays(today(), -7), to: today(), targetType: '' }); const [page, setPage] = useState(1); const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['audit', f, page], queryFn: () => api.get<{ items: Log[]; total: number }>('/audit-logs', { ...f, page }) });
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / 100));
  return (
    <div className="space-y-4">
      <PageHead title="操作履歴" sub="記入・修正・取消・送信・freee 登録・設定の変更など、すべての操作の記録です（書き換え・削除はできません）"
        actions={<><Input type="date" className="w-40" value={f.from} onChange={(e) => { setF({ ...f, from: e.target.value }); setPage(1); }} />〜<Input type="date" className="w-40" value={f.to} onChange={(e) => { setF({ ...f, to: e.target.value }); setPage(1); }} />
          <Select className="w-40" value={f.targetType} onChange={(e) => { setF({ ...f, targetType: e.target.value }); setPage(1); }}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></>} />
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.items.length ? <Empty>記録はありません</Empty> : <>
        <Table head={<><Th className="w-40">日時</Th><Th className="w-40">操作した人</Th><Th>内容</Th><Th className="w-40">種類</Th></>}>
          {q.data.items.map((l) => [
            <tr key={l.id} className="cursor-pointer hover:bg-cream/50" onClick={() => setOpen(open === l.id ? null : l.id)}>
              <Td className="text-xs num">{jdatetime(l.occurredAt)}</Td><Td className="text-xs">{l.userName ?? '—'}{l.role && <span className="ml-1 text-gray-500">（{l.role}）</span>}</Td>
              <Td>{l.summary}{l.reason && <div className="text-xs text-gray-600">理由：{l.reason}</div>}</Td><Td className="font-mono text-xs">{l.action}</Td>
            </tr>,
            open === l.id && (l.before || l.after) ? <tr key={`d${l.id}`}><Td colSpan={4}><div className="grid grid-cols-2 gap-2 text-xs"><div><b>変更前</b><pre className="max-h-48 overflow-auto rounded bg-cream p-2">{JSON.stringify(l.before, null, 2)}</pre></div><div><b>変更後</b><pre className="max-h-48 overflow-auto rounded bg-cream p-2">{JSON.stringify(l.after, null, 2)}</pre></div></div></Td></tr> : null,
          ])}
        </Table>
        <div className="flex items-center justify-center gap-3"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>前へ</Button><span className="text-sm num">{page} / {pages}（{q.data.total} 件）</span><Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>次へ</Button></div>
      </>}
    </div>
  );
}
