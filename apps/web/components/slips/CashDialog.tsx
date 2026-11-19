'use client';
/* 現金で受け取る（FR-BIL-15、設計案）。金額を確かめて代金を受け取り、領収書（RPT-07）を出して印刷する */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, ErrorBox, errMsg, Field, Input, Loading, Table, Td, Th, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { jdate, yen } from '@/lib/format';

interface Preview { slipId: string; slipNo: string; receiptDate: string; addresseeName: string; billingPartyName: string; lines: { itemName: string; vehicleClassName: string; tripCount: number; unitPrice: number; amount: number }[]; subtotal: number; taxRate: number; taxAmount: number; total: number; revenueStamp: boolean; tripCount: number }

export function CashDialog({ slipId, onClose, onDone }: { slipId: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['cash-preview', slipId], enabled: !!slipId, staleTime: 0, gcTime: 0, queryFn: () => api.get<Preview>(`/slips/${slipId}/cash-preview`) });
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setErr(null); if (q.data) setName(q.data.addresseeName); }, [q.data]);
  const issue = async () => {
    setBusy(true); setErr(null);
    try {
      const w = window.open('', '_blank');
      const r = await api.post<{ id: string; receiptNo: string; total: number }>(`/slips/${slipId}/cash-receipt`, name.trim() && name.trim() !== q.data?.addresseeName ? { addresseeName: name.trim() } : {});
      const f = await api.get<{ url: string }>(`/cash-receipts/${r.id}/pdf`);
      if (w) w.location.href = f.url; else void openFile(`/cash-receipts/${r.id}/pdf`);
      toast(`${yen(r.total)} 円を受け取り、領収書 ${r.receiptNo} を出しました`);
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const p = q.data;
  return (
    <Dialog open={!!slipId} onClose={onClose} title="現金で受け取る" width={640}
      footer={<><Button onClick={onClose}>やめる</Button><Button kind="primary" busy={busy} disabled={!p || !name.trim()} onClick={issue}>{p ? `${yen(p.total)} 円を受け取って領収書を出す` : '受け取って領収書を出す'}</Button></>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : p && (
        <div className="space-y-3">
          <p className="text-sm">伝票 <b className="num">{p.slipNo}</b>　請求先：{p.billingPartyName}　{jdate(p.receiptDate)}</p>
          <div className="rounded-lg border-2 border-navy p-4 text-center"><div className="text-sm text-gray-600">お預かりする金額（税込）</div><div className="text-4xl font-bold text-navy num">¥{yen(p.total)}</div></div>
          <Table head={<><Th>品目</Th><Th>車格</Th><Th className="text-right">台数</Th><Th className="text-right">単価</Th><Th className="text-right">金額（税抜）</Th></>}>
            {p.lines.map((l, i) => <tr key={i}><Td>{l.itemName}</Td><Td>{l.vehicleClassName}</Td><Td className="text-right num">{l.tripCount}</Td><Td className="text-right num">{yen(l.unitPrice)}</Td><Td className="text-right num">{yen(l.amount)}</Td></tr>)}
            <tr><Td colSpan={4} className="text-right text-xs">{p.taxRate}%対象（税抜）／消費税</Td><Td className="text-right num">{yen(p.subtotal)}／{yen(p.taxAmount)}</Td></tr>
          </Table>
          {p.revenueStamp && <Alert>税抜5万円以上のため、領収書に収入印紙を貼って割り印してください。</Alert>}
          <Field label="領収書の宛名" hint="「上様」にもできます"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
          <p className="text-xs text-gray-600">領収書を出したこの伝票の便は、月の締めの請求書には入りません。誤りや返金は本社で領収書を取り消します。</p>
          {err && <p className="text-sm font-bold text-err" role="alert">{err}</p>}
        </div>
      )}
    </Dialog>
  );
}
