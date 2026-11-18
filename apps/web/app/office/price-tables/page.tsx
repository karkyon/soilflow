'use client';
/* SCR-56 単価表（FR-MST-07、11 3.2・3.3）。品目×車格の1台あたりの税抜の金額。参考値（㎥単価×容量）と違う金額に印 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, cx, Dialog, ErrorBox, errMsg, Field, Input, Loading, PageHead, Pill, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { jdate, yen } from '@/lib/format';
import { Item, useMaster, VehicleClass } from '@/lib/masters';

interface Entry { itemId: string; vehicleClassId: string; unitPrice: number; referencePrice: number | null; differsFromReference: boolean }
interface PT { id: string; effectiveFrom: string; note: string | null; locked: boolean; entries: Entry[] }

export default function PriceTablesPage() {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['price-tables'], queryFn: () => api.get<PT[]>('/price-tables') });
  const items = useMaster<Item>('items'); const vcs = useMaster<VehicleClass>('vehicleClasses');
  const [id, setId] = useState(''); const [draft, setDraft] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [newOpen, setNewOpen] = useState(false);
  const [nf, setNf] = useState({ effectiveFrom: '', note: '' });
  const t = q.data?.find((x) => x.id === id) ?? q.data?.[0];
  useEffect(() => { if (t) setDraft(Object.fromEntries(t.entries.map((e) => [`${e.itemId}|${e.vehicleClassId}`, String(e.unitPrice)]))); }, [t]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data || !items.data || !vcs.data) return <Loading />;
  const changed = t ? Object.entries(draft).filter(([k, v]) => { const e = t.entries.find((x) => `${x.itemId}|${x.vehicleClassId}` === k); return v !== '' && String(e?.unitPrice ?? '') !== v; }) : [];
  const save = async () => {
    setBusy(true);
    try { await api.put(`/price-tables/${t!.id}/entries`, changed.map(([k, v]) => { const [itemId, vehicleClassId] = k.split('|'); return { itemId, vehicleClassId, unitPrice: Number(v) }; })); toast(`${changed.length} 件の金額を保存しました`); qc.invalidateQueries({ queryKey: ['price-tables'] }); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true);
    try { const r = await api.post<PT>('/price-tables', { effectiveFrom: nf.effectiveFrom, note: nf.note || undefined, ...(t ? { copyFrom: t.id } : {}) }); toast('単価表を作りました'); await qc.invalidateQueries({ queryKey: ['price-tables'] }); setId(r.id); setNewOpen(false); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <PageHead title="単価表" sub="便の日付（来場日）で、適用開始日が最も新しい表の金額を使います。改定のときは今の表を写して新しい表を作ります"
        actions={<>
          <Select className="w-64" value={t?.id ?? ''} onChange={(e) => setId(e.target.value)}>{q.data.map((x) => <option key={x.id} value={x.id}>{jdate(x.effectiveFrom)} から{x.note ? `（${x.note}）` : ''}</option>)}</Select>
          <Button onClick={() => { setNf({ effectiveFrom: '', note: '' }); setNewOpen(true); }}>＋ 新しい単価表（今の表を写す）</Button>
          {t && !t.locked && <Button kind="primary" busy={busy} disabled={!changed.length} onClick={save}>{changed.length} 件を保存</Button>}
        </>} />
      {!t ? <Alert>単価表がありません。「新しい単価表」で作ってください。</Alert> : <>
        {t.locked && <Alert tone="info">この単価表は請求書に使われたため変更できません。改定は新しい適用開始日の表を作ってください。</Alert>}
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead><tr className="bg-navy text-white"><th className="px-3 py-2 text-left">品目（価格表）</th><th className="px-2">区分</th>{vcs.data.map((v) => <th key={v.id} className="px-2 num">{v.name}<div className="text-xs font-normal opacity-70">{v.capacityM3}㎥</div></th>)}</tr></thead>
            <tbody>{items.data.map((it) => (
              <tr key={it.id} className="border-b border-line">
                <td className="px-3 py-1.5 font-bold">{it.priceItemName}<div className="text-xs font-normal text-gray-500">{it.reportLabel}{it.pricePerM3Ref ? `　${yen(it.pricePerM3Ref)}円/㎥` : ''}</div></td>
                <td className="text-center text-xs">{it.direction === 'RECEIVE' ? '受入' : '納品'}</td>
                {vcs.data.map((v) => {
                  const k = `${it.id}|${v.id}`; const e = t.entries.find((x) => `${x.itemId}|${x.vehicleClassId}` === k);
                  return (
                    <td key={v.id} className={cx('px-1 py-1', e?.differsFromReference && 'bg-warn-bg')}>
                      <Input className="h-8 text-right num" inputMode="numeric" disabled={t.locked} value={draft[k] ?? ''} placeholder="—" aria-label={`${it.priceItemName} ${v.name}`} onChange={(x) => setDraft({ ...draft, [k]: x.target.value.replace(/\D/g, '') })} />
                      {e?.referencePrice !== null && e?.referencePrice !== undefined && <div className={cx('text-right text-[11px] num', e.differsFromReference ? 'font-bold text-warn' : 'text-gray-400')} title="参考値（㎥単価×容量＋積込料）">参 {yen(e.referencePrice)}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="text-xs text-gray-600"><Pill tone="warn">黄色</Pill> 参考値（四捨五入（㎥単価×容量）＋4t車以下の積込料）と違う金額。空欄は「単価なし」で、その便がある請求先の請求書は作りません。</p>
      </>}
      <Dialog open={newOpen} onClose={() => setNewOpen(false)} title="新しい単価表" width={440} footer={<><Button onClick={() => setNewOpen(false)}>やめる</Button><Button kind="primary" busy={busy} disabled={!nf.effectiveFrom} onClick={create}>作る</Button></>}>
        <div className="space-y-3"><Field label="適用開始日" required hint="この日以降の便に使います"><Input type="date" value={nf.effectiveFrom} onChange={(e) => setNf({ ...nf, effectiveFrom: e.target.value })} /></Field>
          <Field label="メモ"><Input value={nf.note} onChange={(e) => setNf({ ...nf, note: e.target.value })} placeholder="例：2027年4月改定" /></Field>
          {t && <p className="text-xs text-gray-600">{jdate(t.effectiveFrom)} からの表の金額を写して作ります。</p>}</div>
      </Dialog>
    </div>
  );
}
