'use client';
/* SCR-34 請求（FR-BIL-03・04・09、02 6.3）。締めの前の確認 → 締め → 確認 → メール送信 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MailDialog } from '@/components/billing/MailDialog';
import { Alert, Button, Card, ConfirmDialog, Empty, ErrorBox, errMsg, FREEE_STATUS, Input, INVOICE_STATUS, Loading, PageHead, Select, StatusPill, Table, Td, Th, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { addMonths, jdateShort, monthLabel, thisMonth, yen } from '@/lib/format';
import { BillingParty, useMaster } from '@/lib/masters';

interface Precheck { month: string; billingParties: { billingPartyId: string; name: string; periodFrom: string; periodTo: string; tripCount: number; subtotal: number; existingInvoiceId: string | null }[]; problems: { kind: string; billingPartyId: string | null; tripIds: string[]; message: string }[] }
export interface InvoiceSummary { id: string; invoiceNo: string; billingPartyId: string; billingPartyName: string; periodFrom: string; periodTo: string; issueDate: string; dueDate: string; siteCount: number; tripCount: number; subtotal: number; taxAmount: number; total: number; status: string; freeeStatus: string | null; hasPdf: boolean; version: number }
const BLOCKING = ['PRICE_MISSING', 'INVOICE_BLOCKED'];

export default function BillingPage() {
  const toast = useToast(); const qc = useQueryClient();
  const [month, setMonth] = useState(addMonths(thisMonth(), -1));
  const [status, setStatus] = useState(''); const [search, setSearch] = useState({ issueFrom: '', issueTo: '', amountMin: '', amountMax: '', billingPartyId: '' }); const [byMonth, setByMonth] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set()); const [runOpen, setRunOpen] = useState(false); const [mailIds, setMailIds] = useState<string[] | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { const s = new URLSearchParams(location.search).get('status'); if (s) { setStatus(s); setByMonth(false); } }, []);
  const bps = useMaster<BillingParty>('billingParties', { includeInactive: true });
  const pre = useQuery({ queryKey: ['precheck', month], queryFn: () => api.get<Precheck>('/billing/precheck', { month }) });
  const inv = useQuery({
    queryKey: ['invoices', byMonth ? month : null, status, search],
    queryFn: () => api.get<{ items: InvoiceSummary[] }>('/invoices', { month: byMonth ? month : undefined, status: status || undefined, ...search }),
    refetchInterval: (q) => (q.state.data?.items.some((i) => !i.hasPdf && ['DRAFT', 'NEEDS_RECHECK', 'CONFIRMED'].includes(i.status)) || q.state.data?.items.some((i) => i.status === 'SENDING') ? 3000 : false),
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoices'] }); qc.invalidateQueries({ queryKey: ['precheck'] }); setSel(new Set()); };
  const items = inv.data?.items ?? [];
  const selected = items.filter((i) => sel.has(i.id));
  const confirmAll = async () => {
    setBusy(true);
    let n = 0;
    for (const i of selected.filter((x) => x.status === 'DRAFT')) { try { await api.post(`/invoices/${i.id}/confirm`, { version: i.version }); n++; } catch (e) { toast(`${i.invoiceNo}：${errMsg(e)}`, 'err'); } }
    toast(`${n} 件を確認済にしました`); setBusy(false); refresh();
  };
  const toCreate = pre.data?.billingParties.filter((b) => !b.existingInvoiceId) ?? [];
  const blockers = pre.data?.problems.filter((p) => BLOCKING.includes(p.kind)) ?? [];

  return (
    <div className="space-y-4">
      <PageHead title="請求" sub="締めで請求書を作り、内容を確かめて確認済にしてから、メールで送ります"
        actions={<><Button size="sm" onClick={() => setMonth(addMonths(month, -1))}>◀</Button><b className="px-2 text-lg text-navy">{monthLabel(month)}分</b><Button size="sm" onClick={() => setMonth(addMonths(month, 1))}>▶</Button></>} />
      <Card title="締めの前の確認" actions={<Button kind="primary" disabled={!toCreate.length} onClick={() => setRunOpen(true)}>締めを実行（{toCreate.length} 件作成）</Button>}>
        <ErrorBox error={pre.error} />
        {pre.isLoading ? <Loading /> : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-[13px] font-bold text-navy">請求先（{pre.data?.billingParties.length ?? 0}）</div>
              {!pre.data?.billingParties.length ? <Empty>この月に請求する便はありません</Empty> : (
                <table className="w-full text-sm"><tbody>{pre.data.billingParties.map((b) => (
                  <tr key={b.billingPartyId} className="border-b border-line"><td className="py-1.5">{b.name}</td><td className="text-xs text-gray-600 num">{jdateShort(b.periodFrom)}〜{jdateShort(b.periodTo)}</td><td className="text-right num">{b.tripCount}台</td><td className="text-right num">{yen(b.subtotal)}円</td>
                    <td className="text-right">{b.existingInvoiceId ? <Link className="text-xs text-info hover:underline" href={`/office/invoice/?id=${b.existingInvoiceId}`}>作成済</Link> : <span className="text-xs text-gray-500">作成前</span>}</td></tr>
                ))}</tbody></table>
              )}
            </div>
            <div>
              <div className="mb-1 text-[13px] font-bold text-navy">問題点（{pre.data?.problems.length ?? 0}）</div>
              {!pre.data?.problems.length ? <p className="text-sm text-ok">問題はありません。</p> : (
                <div className="space-y-1">{pre.data.problems.map((p, i) => <Alert key={i} tone={BLOCKING.includes(p.kind) ? 'err' : ['ALREADY_INVOICED', 'CASH_SETTLED'].includes(p.kind) ? 'info' : 'warn'}>{p.message}</Alert>)}</div>
              )}
            </div>
          </div>
        )}
      </Card>
      <Card title="請求書" actions={<>
        <Button size="sm" disabled={!selected.some((i) => i.status === 'DRAFT')} busy={busy} onClick={confirmAll}>選んだものを確認済にする</Button>
        <Button size="sm" kind="primary" disabled={!selected.some((i) => ['CONFIRMED', 'SEND_ERROR'].includes(i.status))} onClick={() => setMailIds(selected.filter((i) => ['CONFIRMED', 'SEND_ERROR'].includes(i.status)).map((i) => i.id))}>選んだものをメール送信</Button>
      </>}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1"><input type="checkbox" checked={byMonth} onChange={(e) => setByMonth(e.target.checked)} /> {monthLabel(month)}締め</label>
          <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">取消以外のすべて</option>{Object.entries(INVOICE_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select>
          <span className="ml-2 font-bold">検索</span>
          <Input type="date" className="w-36" value={search.issueFrom} onChange={(e) => setSearch({ ...search, issueFrom: e.target.value })} aria-label="請求日から" />〜<Input type="date" className="w-36" value={search.issueTo} onChange={(e) => setSearch({ ...search, issueTo: e.target.value })} aria-label="請求日まで" />
          <Input className="w-28 num" placeholder="金額から" inputMode="numeric" value={search.amountMin} onChange={(e) => setSearch({ ...search, amountMin: e.target.value.replace(/\D/g, '') })} />〜<Input className="w-28 num" placeholder="金額まで" inputMode="numeric" value={search.amountMax} onChange={(e) => setSearch({ ...search, amountMax: e.target.value.replace(/\D/g, '') })} />
          <Select className="w-44" value={search.billingPartyId} onChange={(e) => setSearch({ ...search, billingPartyId: e.target.value })}><option value="">すべての請求先</option>{(bps.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        </div>
        <ErrorBox error={inv.error} />
        {inv.isLoading ? <Loading /> : !items.length ? <Empty>請求書はありません</Empty> : (
          <Table head={<><Th className="w-8"><input type="checkbox" aria-label="すべて選ぶ" checked={sel.size === items.length} onChange={(e) => setSel(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} /></Th><Th>番号</Th><Th>請求先</Th><Th>請求期間</Th><Th>請求日</Th><Th className="text-right">台数</Th><Th className="text-right">合計（税込）</Th><Th>状態</Th><Th>freee</Th></>}>
            {items.map((i) => (
              <tr key={i.id} className="hover:bg-cream/50">
                <Td><input type="checkbox" aria-label={`${i.invoiceNo} を選ぶ`} checked={sel.has(i.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(i.id); else n.delete(i.id); setSel(n); }} /></Td>
                <Td><Link className="font-bold text-info num hover:underline" href={`/office/invoice/?id=${i.id}`}>{i.invoiceNo}</Link></Td>
                <Td>{i.billingPartyName}</Td><Td className="text-xs num">{jdateShort(i.periodFrom)}〜{jdateShort(i.periodTo)}</Td><Td className="num">{jdateShort(i.issueDate)}</Td>
                <Td className="text-right num">{i.tripCount}</Td><Td className="text-right font-bold num">{yen(i.total)}</Td>
                <Td><StatusPill map={INVOICE_STATUS} value={i.status} />{!i.hasPdf && i.status !== 'VOIDED' && <div className="text-xs text-gray-500">PDF 作成中</div>}</Td>
                <Td><StatusPill map={FREEE_STATUS} value={i.freeeStatus} /></Td>
              </tr>
            ))}
            <tr className="bg-cream font-bold"><Td colSpan={5}>合計 {items.length} 件</Td><Td className="text-right num">{items.reduce((a, i) => a + i.tripCount, 0)}</Td><Td className="text-right num">{yen(items.filter((i) => i.status !== 'VOIDED').reduce((a, i) => a + i.total, 0))}</Td><Td colSpan={2} /></tr>
          </Table>
        )}
      </Card>
      <ConfirmDialog open={runOpen} onClose={() => setRunOpen(false)} title={`${monthLabel(month)}分の締め`} okLabel="締めを実行する"
        message={<>{toCreate.length} 件の請求書を作ります。{blockers.length > 0 && <span className="mt-2 block font-bold text-err">単価なしの請求先は作りません（{blockers.filter((b) => b.kind === 'PRICE_MISSING').length} 件）。</span>}作成済の請求書がある請求先は飛ばします（直すときは請求書の「作り直す」）。</>}
        onOk={async () => { const r = await api.post<{ createdInvoiceIds: string[]; status: string }>('/billing/runs', { month }); toast(`請求書 ${r.createdInvoiceIds.length} 件を作成しました${r.status === 'RUNNING' ? '（PDF 作成中）' : ''}`); refresh(); }} />
      <MailDialog ids={mailIds} onClose={() => setMailIds(null)} onDone={refresh} />
    </div>
  );
}
