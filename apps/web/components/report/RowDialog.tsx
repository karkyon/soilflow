'use client';
/* SCR-11 行の追加・修正（FR-RCV-04・05・15）。会社は読みがなの頭文字で絞り込む */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, cx, Dialog, errMsg, Field, Input, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { KANA_ROWS, kanaRow } from '@/lib/format';
import { Customer, Item, Site, useMaster, Vehicle, VehicleClass } from '@/lib/masters';
import type { Row } from './useDailyReport';

export interface RowDraft { customerId?: string; siteId?: string | null; itemId?: string; vehicleClassId?: string }

export function RowDialog({ open, onClose, date, row, draft, onSaved, onDeleted }: {
  open: boolean; onClose: () => void; date: string; row?: Row | null; draft?: RowDraft | null; onSaved: (r: Row) => void; onDeleted?: (id: string) => void;
}) {
  const toast = useToast(); const qc = useQueryClient();
  const customers = useMaster<Customer>('customers'); const items = useMaster<Item>('items'); const vcs = useMaster<VehicleClass>('vehicleClasses');
  const [kana, setKana] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(''); const [siteId, setSiteId] = useState(''); const [vehicleNo, setVehicleNo] = useState('');
  const [itemId, setItemId] = useState(''); const [vcId, setVcId] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [confirmDel, setConfirmDel] = useState(false);
  const sites = useMaster<Site>('sites', { customerId: customerId || undefined }); const vehicles = useMaster<Vehicle>('vehicles', { customerId: customerId || undefined });

  useEffect(() => {
    if (!open) return;
    setErr(null); setKana(null);
    setCustomerId(row?.customerId ?? draft?.customerId ?? ''); setSiteId(row?.siteId ?? draft?.siteId ?? '');
    setVehicleNo(row?.vehicleNo ?? ''); setItemId(row?.itemId ?? draft?.itemId ?? ''); setVcId(row?.vehicleClassId ?? draft?.vehicleClassId ?? '');
  }, [open, row, draft]);

  const list = useMemo(() => (customers.data ?? []).filter((c) => !kana || kanaRow(c.kana) === kana), [customers.data, kana]);
  const custSites = (sites.data ?? []).filter((s) => s.customerId === customerId);
  const custVehicles = (vehicles.data ?? []).filter((v) => v.customerId === customerId);
  const item = items.data?.find((i) => i.id === itemId); const vc = vcs.data?.find((v) => v.id === vcId);
  const pickVehicle = (no: string) => {
    setVehicleNo(no);
    const v = custVehicles.find((x) => x.vehicleNo === no);
    if (v?.defaultVehicleClassId && !vcId) setVcId(v.defaultVehicleClassId);
  };

  const save = async () => {
    setErr(null);
    if (!customerId || !vehicleNo.trim() || !itemId || !vcId) { setErr('会社名・車番・品名・車格を入れてください'); return; }
    setBusy(true);
    try {
      const v = custVehicles.find((x) => x.vehicleNo === vehicleNo.trim());
      const body = { date, customerId, siteId: siteId || null, ...(v ? { vehicleId: v.id } : { vehicleNo: vehicleNo.trim() }), itemId, vehicleClassId: vcId };
      const r = row ? await api.patch<Row>(`/report-rows/${row.id}`, { ...body, version: row.version }) : await api.post<Row>('/report-rows', body);
      if (!v) qc.invalidateQueries({ queryKey: ['masters', 'vehicles'] });
      toast(row ? '行を直しました' : `行を追加しました（${r.customerName} ${r.vehicleNo}）`);
      onSaved(r); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} title={row ? '行の修正' : '行の追加'} width={720}
        footer={<>
          {row && <Button kind="danger" className="mr-auto" onClick={() => setConfirmDel(true)}>行を削除</Button>}
          <Button onClick={onClose}>閉じる</Button><Button kind="primary" busy={busy} onClick={save}>{row ? '直す' : '追加する'}</Button>
        </>}>
        <div className="space-y-4">
          <Field label="会社名（客先）" required>
            <div className="mb-2 flex flex-wrap gap-1">
              <button type="button" onClick={() => setKana(null)} className={cx('h-8 min-w-9 rounded border px-2 text-sm', !kana ? 'border-gold bg-gold text-white' : 'border-line bg-white')}>全部</button>
              {KANA_ROWS.map((k) => <button type="button" key={k} onClick={() => setKana(k)} className={cx('h-8 min-w-9 rounded border px-2 text-sm', kana === k ? 'border-gold bg-gold text-white' : 'border-line bg-white')}>{k}</button>)}
            </div>
            <div className="grid max-h-40 grid-cols-3 gap-1 overflow-y-auto rounded border border-line p-1">
              {list.map((c) => <button type="button" key={c.id} onClick={() => { if (c.id !== customerId) { setCustomerId(c.id); setSiteId(''); setVehicleNo(''); } }}
                className={cx('truncate rounded px-2 py-1.5 text-left text-sm', c.id === customerId ? 'bg-navy font-bold text-white' : 'hover:bg-gold-pale')}>{c.name}</button>)}
              {!list.length && <span className="col-span-3 p-2 text-sm text-gray-500">該当する客先がありません（客先マスタで登録）</span>}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="現場"><Select value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!customerId}><option value="">（現場なし）</option>{custSites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="車番" required hint="新しい車番は入力すると車番マスタに登録します">
              <Input list="sf-vehicles" value={vehicleNo} onChange={(e) => pickVehicle(e.target.value)} maxLength={20} disabled={!customerId} />
              <datalist id="sf-vehicles">{custVehicles.map((v) => <option key={v.id} value={v.vehicleNo} />)}</datalist>
            </Field>
            <Field label="品名" required><Select value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">選んでください</option>
              {(['RECEIVE', 'DELIVER'] as const).map((d) => <optgroup key={d} label={d === 'RECEIVE' ? '受入れ' : '納品'}>{(items.data ?? []).filter((i) => i.direction === d).map((i) => <option key={i.id} value={i.id}>{i.reportLabel}</option>)}</optgroup>)}
            </Select></Field>
            <Field label="車格" required><Select value={vcId} onChange={(e) => setVcId(e.target.value)}><option value="">選んでください</option>{(vcs.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
          </div>
          {item && vc && <p className="rounded bg-cream px-3 py-2 text-sm">日報の表示：<b>{item.reportLabel}{vc.name}</b>（価格表：{item.priceItemName}）</p>}
          {err && <p className="text-sm font-bold text-err" role="alert">{err}</p>}
        </div>
      </Dialog>
      {row && <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} title="行の削除" danger okLabel="削除する"
        message={<>「{row.customerName} {row.vehicleNo} {row.itemLabel}{row.vehicleClassName}」の行を削除します。便が記入された行は削除できません。</>}
        onOk={async () => { await api.del(`/report-rows/${row.id}`); toast('行を削除しました'); onDeleted?.(row.id); onClose(); }} />}
    </>
  );
}
