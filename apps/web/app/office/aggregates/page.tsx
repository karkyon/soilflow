'use client';
/* SCR-33 集計（FR-AGG-03〜05、11 6章）。金額は税抜、単価なしの便は件数を別に出す。行を押すと元の便（FR-AGG-04） */
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, cx, Dialog, Empty, ErrorBox, errMsg, Input, Loading, PageHead, SLIP_STATUS, StatusPill, Table, Td, Th, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { addMonths, thisMonth, yen } from '@/lib/format';

const KEYS = [['date', '日付'], ['customer', '客先'], ['site', '現場'], ['billingParty', '請求先'], ['item', '品目'], ['vehicleClass', '車格']] as const;
interface Drill { total: number; truncated: boolean; items: { id: string; date: string; time: string; customerName: string; siteName: string | null; vehicleNo: string; itemName: string; vehicleClassName: string; markSymbol: string | null; unitPrice: number | null; billingPartyName: string | null; slipId: string | null; slipNo: string | null; slipStatus: string | null; hasScan: boolean; invoiceId: string | null; invoiceNo: string | null }[] }
interface Agg { rows: { keys: Record<string, string>; labels: Record<string, string>; tripCount: number; amount: number; priceMissingCount: number }[]; total: { tripCount: number; amount: number; priceMissingCount: number } }

export default function AggregatesPage() {
  const toast = useToast();
  const m = addMonths(thisMonth(), 0);
  const [from, setFrom] = useState(`${m}-01`); const [to, setTo] = useState(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState<string[]>(['customer', 'item']);
  const q = useQuery({ queryKey: ['agg', from, to, groupBy], enabled: !!groupBy.length && from <= to, queryFn: () => api.get<Agg>('/aggregates', { from, to, groupBy }) });
  const [open, setOpen] = useState<{ keys: Record<string, string>; title: string } | null>(null);
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
            {q.data.rows.map((r, i) => <tr key={i} className="cursor-pointer hover:bg-cream/50" title="元の便を見る" onClick={() => setOpen({ keys: r.keys, title: groupBy.map((k) => r.labels[k]).join('・') })}>{groupBy.map((k) => <Td key={k}>{r.labels[k]}</Td>)}<Td className="text-right num">{r.tripCount}</Td><Td className="text-right num">{yen(r.amount)}</Td><Td className={cx('text-right num', r.priceMissingCount && 'font-bold text-warn')}>{r.priceMissingCount || ''}</Td></tr>)}
            <tr className="bg-cream font-bold"><Td colSpan={groupBy.length}>合計</Td><Td className="text-right num">{q.data.total.tripCount}</Td><Td className="text-right num">{yen(q.data.total.amount)}</Td><Td className="text-right num">{q.data.total.priceMissingCount || ''}</Td></tr>
          </Table>
        </>
      )}
      <TripsDialog from={from} to={to} target={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function TripsDialog({ from, to, target, onClose }: { from: string; to: string; target: { keys: Record<string, string>; title: string } | null; onClose: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['agg-trips', from, to, target?.keys], enabled: !!target, queryFn: () => api.get<Drill>('/aggregates/trips', { from, to, ...target!.keys }) });
  const pdf = (id: string, kind: string) => openFile(`/slips/${id}/pdf`, { kind }).catch((e) => toast(errMsg(e), 'err'));
  return (
    <Dialog open={!!target} onClose={onClose} title={`元の便　${target?.title ?? ''}`} width={1100}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data && <>
        <p className="mb-2 text-sm">{q.data.total} 台{q.data.truncated && '（先頭の2,000台を表示）'}　日付を押すとその日の受入日報を開きます</p>
        <div className="max-h-[60vh] overflow-y-auto">
          <Table head={<><Th>日付</Th><Th>時刻</Th><Th>客先・現場</Th><Th>車番</Th><Th>品目・車格</Th><Th className="text-right">単価</Th><Th>請求先</Th><Th>伝票・サイン</Th><Th>請求書</Th></>}>
            {q.data.items.map((t) => (
              <tr key={t.id}>
                <Td><Link className="text-info num hover:underline" href={`/office/report/?date=${t.date}`}>{t.date}</Link></Td><Td className="num">{t.time}{t.markSymbol && <span className="ml-1 font-bold">{t.markSymbol}</span>}</Td>
                <Td>{t.customerName}<div className="text-xs text-gray-600">{t.siteName ?? '（現場なし）'}</div></Td><Td className="num">{t.vehicleNo}</Td><Td>{t.itemName}<div className="text-xs text-gray-600">{t.vehicleClassName}</div></Td>
                <Td className={cx('text-right num', t.unitPrice === null && 'font-bold text-warn')}>{t.unitPrice === null ? '単価なし' : yen(t.unitPrice)}</Td><Td className="text-xs">{t.billingPartyName ?? '—'}</Td>
                <Td>{t.slipNo ? <div className="flex items-center gap-1"><span className="num text-xs">{t.slipNo}</span><StatusPill map={SLIP_STATUS} value={t.slipStatus} />
                  {t.slipStatus === 'SIGNED' && <button type="button" className="text-xs text-info hover:underline" onClick={() => pdf(t.slipId!, 'office')}>サイン入り</button>}
                  {t.hasScan && <button type="button" className="text-xs text-info hover:underline" onClick={() => pdf(t.slipId!, 'scan')}>スキャン</button>}</div> : <span className="text-xs text-gray-500">伝票未発行</span>}</Td>
                <Td>{t.invoiceId ? <Link className="text-info num hover:underline" href={`/office/invoice/?id=${t.invoiceId}`}>{t.invoiceNo}</Link> : '—'}</Td>
              </tr>
            ))}
          </Table>
        </div>
      </>}
    </Dialog>
  );
}
