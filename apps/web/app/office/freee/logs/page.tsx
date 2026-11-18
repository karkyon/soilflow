'use client';
/* SCR-44 freee 登録の履歴（FR-FRE-20）。API の呼び出しの記録（鍵・PDF の中身は残さない） */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, ErrorBox, Input, Loading, PageHead, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api/client';
import { addDays, jdatetime, today } from '@/lib/format';

interface Log { id: number; method: string; path: string; statusCode: number | null; durationMs: number; error: string | null; requestedBy: string | null; createdAt: string; response: unknown }
export default function FreeeLogsPage() {
  const [from, setFrom] = useState(addDays(today(), -30)); const [to, setTo] = useState(today()); const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['freee-logs', from, to], queryFn: () => api.get<Log[]>('/freee/api-logs', { from, to }) });
  return (
    <div className="space-y-4">
      <PageHead title="freee 登録の履歴" actions={<><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />〜<Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></>} />
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>記録はありません</Empty> : (
        <Table head={<><Th>日時</Th><Th>呼び出し</Th><Th>結果</Th><Th className="text-right">時間</Th><Th>操作した人</Th></>}>
          {q.data.map((l) => [
            <tr key={l.id} className="cursor-pointer hover:bg-cream/50" onClick={() => setOpen(open === l.id ? null : l.id)}>
              <Td className="text-xs num">{jdatetime(l.createdAt)}</Td><Td className="font-mono text-xs">{l.method} {l.path}</Td>
              <Td className={l.statusCode && l.statusCode < 300 ? 'text-ok' : 'font-bold text-err'}>{l.statusCode ?? '通信エラー'}{l.error && <div className="text-xs font-normal">{l.error}</div>}</Td>
              <Td className="text-right text-xs num">{l.durationMs} ms</Td><Td className="text-xs">{l.requestedBy ?? '（自動）'}</Td>
            </tr>,
            open === l.id && <tr key={`d${l.id}`}><Td colSpan={5}><pre className="max-h-60 overflow-auto rounded bg-cream p-2 text-xs">{JSON.stringify(l.response, null, 2)}</pre></Td></tr>,
          ])}
        </Table>
      )}
    </div>
  );
}
