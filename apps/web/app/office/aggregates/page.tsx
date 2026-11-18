'use client';
/* SCR-33 集計（FR-AGG-03〜05、11 6章）。金額は税抜、単価なしの便は件数を別に出す */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, cx, Empty, ErrorBox, errMsg, Input, Loading, PageHead, Table, Td, Th, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { addMonths, thisMonth, yen } from '@/lib/format';

const KEYS = [['date', '日付'], ['customer', '客先'], ['site', '現場'], ['billingParty', '請求先'], ['item', '品目'], ['vehicleClass', '車格']] as const;
interface Agg { rows: { keys: Record<string, string>; labels: Record<string, string>; tripCount: number; amount: number; priceMissingCount: number }[]; total: { tripCount: number; amount: number; priceMissingCount: number } }

export default function AggregatesPage() {
  const toast = useToast();
  const m = addMonths(thisMonth(), 0);
  const [from, setFrom] = useState(`${m}-01`); const [to, setTo] = useState(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState<string[]>(['customer', 'item']);
  const q = useQuery({ queryKey: ['agg', from, to, groupBy], enabled: !!groupBy.length && from <= to, queryFn: () => api.get<Agg>('/aggregates', { from, to, groupBy }) });
  const toggle = (k: string) => setGroupBy((g) => (g.includes(k) ? g.filter((x) => x !== k) : g.length >= 3 ? g : [...g, k]));
  const exp = (format: 'csv' | 'xlsx') => openFile('/aggregates/export', { from, to, format, groupBy }).catch((e) => toast(errMsg(e), 'err'));
  return (
    <div className="space-y-4">
      <PageHead title="集計" sub="請求書を作る前でも、単価表の金額でその場で計算します（税抜。消費税は請求書ごとに計算）"
        actions={<><Button onClick={() => exp('csv')}>CSV で出力</Button><Button onClick={() => exp('xlsx')}>Excel で出力</Button></>} />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-white p-3">
        <span className="text-sm font-bold">期間</span><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />〜<Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="ml-4 text-sm font-bold">まとめ方（3つまで、選んだ順）</span>
        {KEYS.map(([k, l]) => <button key={k} type="button" onClick={() => toggle(k)} className={cx('h-8 rounded-full border px-3 text-sm', groupBy.includes(k) ? 'border-navy bg-navy text-white' : 'border-line bg-white')}>{groupBy.includes(k) && `${groupBy.indexOf(k) + 1}. `}{l}</button>)}
      </div>
      <ErrorBox error={q.error} />
      {!groupBy.length ? <Empty>まとめ方を選んでください</Empty> : q.isLoading ? <Loading /> : !q.data?.rows.length ? <Empty>この期間の便はありません</Empty> : (
        <>
          {q.data.total.priceMissingCount > 0 && <Alert>単価表に金額がない便が {q.data.total.priceMissingCount} 台あります（金額に入っていません）。</Alert>}
          <Table head={<>{groupBy.map((k) => <Th key={k}>{KEYS.find((x) => x[0] === k)![1]}</Th>)}<Th className="text-right">台数</Th><Th className="text-right">金額（税抜・円）</Th><Th className="text-right">単価なし</Th></>}>
            {q.data.rows.map((r, i) => <tr key={i}>{groupBy.map((k) => <Td key={k}>{r.labels[k]}</Td>)}<Td className="text-right num">{r.tripCount}</Td><Td className="text-right num">{yen(r.amount)}</Td><Td className={cx('text-right num', r.priceMissingCount && 'font-bold text-warn')}>{r.priceMissingCount || ''}</Td></tr>)}
            <tr className="bg-cream font-bold"><Td colSpan={groupBy.length}>合計</Td><Td className="text-right num">{q.data.total.tripCount}</Td><Td className="text-right num">{yen(q.data.total.amount)}</Td><Td className="text-right num">{q.data.total.priceMissingCount || ''}</Td></tr>
          </Table>
        </>
      )}
    </div>
  );
}
