'use client';
/* SCR-43 品目の対応付け（FR-FRE-08）。品目ごとに freee の勘定科目・税区分・品目 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, ErrorBox, errMsg, Loading, PageHead, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { RequireRole } from '@/lib/auth';
import { Item, useMaster } from '@/lib/masters';

type Ref = { id: number; name: string; code: string | null };
export default function Page() { return <RequireRole roles={['ADMIN']}><ItemsMapping /></RequireRole>; }

function ItemsMapping() {
  const toast = useToast(); const qc = useQueryClient();
  const items = useMaster<Item>('items');
  const ais = useQuery({ queryKey: ['freee-ai'], queryFn: () => api.get<Ref[]>('/freee/account-items') });
  const taxes = useQuery({ queryKey: ['freee-tax'], queryFn: () => api.get<Ref[]>('/freee/taxes') });
  const fitems = useQuery({ queryKey: ['freee-items'], queryFn: () => api.get<Ref[]>('/freee/items') });
  const [draft, setDraft] = useState<Record<string, { a: string; t: string; i: string }>>({}); const [busy, setBusy] = useState<string | null>(null);
  // 1件を保存して一覧を読み直しても、ほかの行の書きかけは消さない
  useEffect(() => { if (items.data) setDraft((cur) => Object.fromEntries(items.data!.map((x) => [x.id, cur[x.id] ?? { a: String(x.freeeAccountItemId ?? ''), t: String(x.freeeTaxCode ?? ''), i: String(x.freeeItemId ?? '') }]))); }, [items.data]);
  const err = ais.error ?? taxes.error ?? fitems.error ?? items.error;
  if (err) return <><PageHead title="品目の対応付け" /><ErrorBox error={err} /></>;
  if (!items.data || !ais.data || !taxes.data || !fitems.data) return <Loading />;
  const save = async (it: Item) => {
    const d = draft[it.id]; setBusy(it.id);
    try { await api.put(`/items/${it.id}/freee-mapping`, { accountItemId: Number(d.a), taxCode: Number(d.t), freeeItemId: d.i ? Number(d.i) : null }); toast(`「${it.priceItemName}」を対応付けました`); qc.invalidateQueries({ queryKey: ['masters', 'items'] }); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(null); }
  };
  const quick = ais.data.find((a) => a.name === '売上高'); const tax10 = taxes.data.find((t) => /課税売上10%/.test(t.name));
  const isChanged = (it: Item) => { const d = draft[it.id]; return !!d && !!d.a && !!d.t && (d.a !== String(it.freeeAccountItemId ?? '') || d.t !== String(it.freeeTaxCode ?? '') || d.i !== String(it.freeeItemId ?? '')); };
  const pending = items.data.filter(isChanged);
  const saveAll = async () => {
    setBusy('all'); let n = 0;
    for (const it of pending) {
      const d = draft[it.id];
      try { await api.put(`/items/${it.id}/freee-mapping`, { accountItemId: Number(d.a), taxCode: Number(d.t), freeeItemId: d.i ? Number(d.i) : null }); n++; }
      catch (e) { toast(`「${it.priceItemName}」：${errMsg(e)}`, 'err'); }
    }
    toast(`${n} 件を対応付けました`); setBusy(null); qc.invalidateQueries({ queryKey: ['masters', 'items'] });
  };
  return (
    <div className="space-y-4">
      <PageHead title="品目の対応付け" sub="請求書の明細は、勘定科目・税区分・品目の組合せごとに freee の取引の明細になります"
        actions={<>{quick && tax10 && <Button onClick={() => setDraft(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, { ...v, a: v.a || String(quick.id), t: v.t || String(tax10.id) }])))}>未設定を「売上高・課税売上10%」で埋める</Button>}{pending.length > 0 && <Button kind="primary" busy={busy === 'all'} onClick={saveAll}>変更した {pending.length} 件を保存</Button>}</>} />
      <Table head={<><Th>品目（価格表）</Th><Th>区分</Th><Th>勘定科目</Th><Th>税区分</Th><Th>freee の品目（任意）</Th><Th /></>}>
        {items.data.map((it) => { const d = draft[it.id] ?? { a: '', t: '', i: '' }; const changed = d.a !== String(it.freeeAccountItemId ?? '') || d.t !== String(it.freeeTaxCode ?? '') || d.i !== String(it.freeeItemId ?? '');
          return (
            <tr key={it.id}>
              <Td className="font-bold">{it.priceItemName}<div className="text-xs font-normal text-gray-500">{it.reportLabel}</div></Td><Td>{it.direction === 'RECEIVE' ? '受入れ' : '納品'}</Td>
              <Td><Select value={d.a} onChange={(e) => setDraft({ ...draft, [it.id]: { ...d, a: e.target.value } })}><option value="">未設定</option>{ais.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Td>
              <Td><Select value={d.t} onChange={(e) => setDraft({ ...draft, [it.id]: { ...d, t: e.target.value } })}><option value="">未設定</option>{taxes.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Td>
              <Td><Select value={d.i} onChange={(e) => setDraft({ ...draft, [it.id]: { ...d, i: e.target.value } })}><option value="">なし</option>{fitems.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Td>
              <Td><Button size="sm" kind={changed ? 'primary' : 'secondary'} disabled={!d.a || !d.t || !changed} busy={busy === it.id} onClick={() => save(it)}>保存</Button></Td>
            </tr>
          ); })}
      </Table>
    </div>
  );
}
