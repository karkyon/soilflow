'use client';
/* SCR-14 伝票発行（FR-SLP-01〜05・08・11）。未発行の便から伝票を作り、タブレットへ送るか紙で印刷する */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, cx, Dialog, Empty, errMsg, Field, Input, Select, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { jdate } from '@/lib/format';
import { BillingParty, Customer, Item, Site, useMaster, VehicleClass } from '@/lib/masters';
import type { Report } from './useDailyReport';

interface Unslipped { customerId: string; customerName: string; siteId: string | null; siteName: string | null; tripCount: number }

export function SlipDialog({ open, onClose, report, onDone }: { open: boolean; onClose: () => void; report: Report; onDone: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const list = useQuery({ queryKey: ['unslipped', report.date, open], enabled: open, queryFn: () => api.get<{ unslipped: Unslipped[] }>('/slips', { date: report.date }) });
  const customers = useMaster<Customer>('customers'); const sites = useMaster<Site>('sites'); const bps = useMaster<BillingParty>('billingParties');
  const items = useMaster<Item>('items'); const vcs = useMaster<VehicleClass>('vehicleClasses');
  const [sel, setSel] = useState<Unslipped | null>(null); const [bpId, setBpId] = useState(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (open) { setSel(null); setErr(null); } }, [open]);
  const def = useMemo(() => {
    if (!sel) return null;
    const site = sites.data?.find((s) => s.id === sel.siteId); const cust = customers.data?.find((c) => c.id === sel.customerId);
    if (site?.defaultBillingPartyId) return { id: site.defaultBillingPartyId, why: '現場の既定' };
    return cust ? { id: cust.defaultBillingPartyId, why: '客先の既定' } : null;
  }, [sel, sites.data, customers.data]);
  useEffect(() => { setBpId(def?.id ?? ''); setReason(''); }, [def]);

  // 伝票の見本：その客先・現場の未発行の便を、品目×車格でまとめる
  const preview = useMemo(() => {
    if (!sel) return [];
    const rows = report.rows.filter((r) => r.customerId === sel.customerId && (r.siteId ?? null) === sel.siteId);
    const g = new Map<string, { label: string; n: number; nos: Set<string> }>();
    for (const t of report.trips) {
      const r = rows.find((x) => x.id === t.rowId);
      if (!r || t.status !== 'ACTIVE' || t.slipId) continue;
      const it = items.data?.find((i) => i.id === t.effectiveItemId); const vc = vcs.data?.find((v) => v.id === r.vehicleClassId);
      const k = `${t.effectiveItemId}|${r.vehicleClassId}`;
      if (!g.has(k)) g.set(k, { label: `${it?.reportLabel ?? ''}${it && it.reportLabel !== it.priceItemName ? `（${it.priceItemName}）` : ''}${vc?.name ?? ''}`, n: 0, nos: new Set() });
      const x = g.get(k)!; x.n++; x.nos.add(r.vehicleNo);
    }
    return [...g.values()];
  }, [sel, report, items.data, vcs.data]);

  const issue = async (how: 'tablet' | 'paper') => {
    if (!sel) return;
    setBusy(how); setErr(null);
    try {
      const slip = await api.post<{ id: string; slipNo: string }>('/slips', { date: report.date, customerId: sel.customerId, siteId: sel.siteId, ...(bpId && bpId !== def?.id ? { billingPartyId: bpId, billingChangeReason: reason || undefined } : {}) });
      if (how === 'tablet') {
        try { await api.post(`/slips/${slip.id}/send-to-terminal`, {}); toast(`伝票 ${slip.slipNo} をタブレットへ送りました`); }
        catch (e) { toast(`伝票 ${slip.slipNo} は作りましたが、タブレットへ送れませんでした：${errMsg(e)}`, 'err'); }
      } else {
        const w = window.open('', '_blank');
        const f = await api.post<{ url: string }>(`/slips/${slip.id}/print-paper`, {});
        if (w) w.location.href = f.url;
        toast(`伝票 ${slip.slipNo} を紙伝票で印刷します`);
      }
      qc.invalidateQueries({ queryKey: ['slips'] });
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`伝票発行　${jdate(report.date)}`} width={860}
      footer={<><Button onClick={onClose}>閉じる</Button>
        <Button kind="secondary" disabled={!sel || !preview.length} busy={busy === 'paper'} onClick={() => issue('paper')}>紙伝票で印刷</Button>
        <Button kind="primary" disabled={!sel || !preview.length} busy={busy === 'tablet'} onClick={() => issue('tablet')}>サイン用タブレットへ送る</Button></>}>
      <div className="grid grid-cols-[260px_1fr] gap-4">
        <div>
          <div className="mb-2 text-[13px] font-bold text-navy">伝票未発行の便がある客先・現場</div>
          {list.isLoading ? <p className="text-sm text-gray-500">読み込み中…</p> : !list.data?.unslipped.length ? <Empty>未発行の便はありません</Empty> : (
            <div className="space-y-1">
              {list.data.unslipped.map((u) => (
                <button type="button" key={`${u.customerId}|${u.siteId}`} onClick={() => setSel(u)}
                  className={cx('flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm', sel?.customerId === u.customerId && sel?.siteId === u.siteId ? 'border-gold bg-gold-pale' : 'border-line hover:bg-cream')}>
                  <span><b>{u.customerName}</b><br /><span className="text-xs text-gray-600">{u.siteName ?? '（現場なし）'}</span></span><span className="num font-bold">{u.tripCount}台</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          {!sel ? <Empty>左から客先・現場を選んでください</Empty> : (
            <div className="space-y-3">
              <div className="rounded-lg border-2 border-navy p-4">
                <div className="flex justify-between"><b className="text-lg">納品伝票（受入）</b><span className="text-sm">{jdate(report.date)}</span></div>
                <div className="mt-2 text-lg font-bold">{sel.customerName} 様</div><div className="text-sm">現場：{sel.siteName ?? '—'}</div>
                <table className="mt-2 w-full text-sm"><thead><tr className="border-b border-navy text-left"><th className="py-1">品名</th><th className="w-14 text-center">台数</th><th>車番</th></tr></thead>
                  <tbody>{preview.map((l) => <tr key={l.label} className="border-b border-line"><td className="py-1">{l.label}</td><td className="text-center num">{l.n}</td><td className="text-xs">{[...l.nos].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })).join('・')}</td></tr>)}
                    <tr><td className="py-1 font-bold">合計</td><td className="text-center font-bold num">{preview.reduce((a, l) => a + l.n, 0)}</td><td /></tr></tbody></table>
              </div>
              <Field label="請求先" hint={def && bpId === def.id ? `${def.why}で決まりました` : '既定から変えています'}>
                <Select value={bpId} onChange={(e) => setBpId(e.target.value)}>{(bps.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
              </Field>
              {def && bpId !== def.id && <Field label="変更の理由（任意）"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="例：元請へ請求" /></Field>}
              <Alert tone="info">タブレットへ送ると、お客さまがサインしたあとに控えの印刷が開きます。</Alert>
            </div>
          )}
          {err && <p className="mt-3 text-sm font-bold text-err" role="alert">{err}</p>}
        </div>
      </div>
    </Dialog>
  );
}
