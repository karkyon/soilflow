'use client';
/* SCR-12 便のメニュー（FR-RCV-08・10〜14）。印・時刻の修正・取消・後から記入 */
import { useEffect, useState } from 'react';
import { Button, cx, Dialog, errMsg, Input, useToast } from '@/components/ui';
import { api, uuid } from '@/lib/api/client';
import type { Item } from '@/lib/masters';
import type { Mark, Row, Trip } from './useDailyReport';

export type MenuTarget = { mode: 'trip'; trip: Trip } | { mode: 'cell'; row: Row; hour: number } | { mode: 'add'; row: Row; hour: number };

const LOCK_MSG = { SLIP: '伝票（サイン待ち以降）に含まれる便のため変えられません。伝票を取り消してから直してください', INVOICE: '送信済の請求書に含まれる便のため変えられません。請求書の取消・再発行で直します' } as const;

export function TripMenu({ target, onClose, date, rows, trips, marks, items, onChanged, canEdit }: {
  target: MenuTarget | null; onClose: () => void; date: string; rows: Row[]; trips: Trip[]; marks: Mark[]; items: Item[];
  onChanged: (ch: { trips: Trip[] }) => void; canEdit: boolean;
}) {
  const toast = useToast();
  const [convoy, setConvoy] = useState(true); const [minute, setMinute] = useState('00'); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [times, setTimes] = useState<Record<string, string>>({});
  useEffect(() => { setErr(null); setConvoy(true); setMinute('00'); setTimes({}); }, [target]);
  if (!target) return null;
  const row = target.mode === 'trip' ? rows.find((r) => r.id === target.trip.rowId)! : target.row;
  const hour = target.mode === 'trip' ? target.trip.hourSlot : target.hour;
  const list = target.mode === 'trip' ? trips.filter((t) => t.id === target.trip.id) : target.mode === 'cell' ? trips.filter((t) => t.rowId === row.id && t.hourSlot === hour) : [];
  const itemName = (id: string) => items.find((i) => i.id === id)?.priceItemName ?? '';
  const markOf = (id: string | null) => marks.find((m) => m.id === id);

  const act = async (key: string, fn: () => Promise<Trip[] | Trip>, msg: string) => {
    setBusy(key); setErr(null);
    try { const r = await fn(); onChanged({ trips: Array.isArray(r) ? r : [r] }); toast(msg); if (target.mode !== 'cell') onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  const setMark = (t: Trip, markId: string | null) => act(`m${t.id}`, () => api.patch<Trip[]>(`/trips/${t.id}`, { version: t.version, markId, applyToConvoy: convoy }), `${t.time} の印を${markOf(markId)?.symbol ?? 'なし'}にしました`);
  const setTime = (t: Trip) => { const v = times[t.id]; if (!v || v === t.time) return; void act(`t${t.id}`, () => api.patch<Trip[]>(`/trips/${t.id}`, { version: t.version, time: v, applyToConvoy: convoy }), `時刻を ${v} に直しました`); };
  const cancel = (t: Trip) => act(`c${t.id}`, () => api.post<Trip>(`/trips/${t.id}/cancel`, { version: t.version }), `${t.time} の便を取り消しました`);
  const add = () => {
    const time = `${String(hour).padStart(2, '0')}:${minute.padStart(2, '0')}`;
    return act('add', async () => (await api.post<{ trips: Trip[] }>('/trips', { date, rowIds: [row.id], time, clientOpId: uuid() })).trips, `${time} を記入しました`);
  };

  return (
    <Dialog open onClose={onClose} width={520} title={<>{row.customerName}　{row.vehicleNo}　{row.itemLabel}{row.vehicleClassName}　<span className="font-normal opacity-80">{hour}時台</span></>}>
      <div className="space-y-4">
        {target.mode === 'add' && (
          <div className="space-y-3">
            <p className="text-sm">前の時間帯に後から記入します。分を選んでください。</p>
            <div className="grid grid-cols-6 gap-1">
              {Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')).map((m) => <button type="button" key={m} onClick={() => setMinute(m)} className={cx('h-10 rounded border text-sm num', minute === m ? 'border-gold bg-gold text-white' : 'border-line bg-white')}>{m}</button>)}
            </div>
            <div className="flex items-center gap-2"><span className="text-sm">分を直接：</span><Input className="w-20 num" inputMode="numeric" maxLength={2} value={minute} onChange={(e) => setMinute(e.target.value.replace(/\D/g, '').slice(0, 2))} />
              <Button kind="primary" busy={busy === 'add'} disabled={!canEdit || Number(minute) > 59 || minute === ''} onClick={add}>{String(hour).padStart(2, '0')}:{minute.padStart(2, '0')} を記入する</Button></div>
          </div>
        )}
        {target.mode !== 'add' && !list.length && <p className="text-sm text-gray-500">このマスに便はありません。</p>}
        {list.map((t) => {
          const locked = t.locked !== 'NONE';
          const cancelled = t.status === 'CANCELLED';
          return (
            <div key={t.id} className={cx('rounded-lg border p-3', cancelled ? 'border-dashed border-gray-300 opacity-60' : 'border-line')}>
              <div className="mb-2 flex items-center gap-2">
                <Input type="time" className="w-28 num" value={times[t.id] ?? t.time} disabled={locked || cancelled || !canEdit} onChange={(e) => setTimes({ ...times, [t.id]: e.target.value })} onBlur={() => setTime(t)} aria-label="時刻" />
                <span className="text-sm text-gray-600">品目：{itemName(t.effectiveItemId)}</span>
                {cancelled && <span className="text-sm font-bold text-err">取消</span>}
                {t.convoyId && <span className="rounded bg-info-bg px-1.5 text-xs text-info">車列</span>}
              </div>
              {locked && <p className="mb-2 text-xs font-bold text-warn">{LOCK_MSG[t.locked as 'SLIP' | 'INVOICE']}</p>}
              {!cancelled && (
                <div className="flex flex-wrap items-center gap-2">
                  {marks.map((m) => <Button key={m.id} size="sm" disabled={locked || !canEdit} busy={busy === `m${t.id}`} onClick={() => setMark(t, m.id)}
                    className={cx(t.markId === m.id && 'ring-2 ring-gold')} style={{ color: m.color }}>{m.symbol}（{m.displayName}）</Button>)}
                  <Button size="sm" disabled={locked || !canEdit || !t.markId} onClick={() => setMark(t, null)}>印なし</Button>
                  <Button size="sm" kind="danger" className="ml-auto" disabled={locked || !canEdit} busy={busy === `c${t.id}`} onClick={() => cancel(t)}>取消</Button>
                </div>
              )}
            </div>
          );
        })}
        {list.some((t) => t.convoyId) && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={convoy} onChange={(e) => setConvoy(e.target.checked)} /> 車列の全部に付ける</label>}
        {err && <p className="text-sm font-bold text-err" role="alert">{err}</p>}
      </div>
    </Dialog>
  );
}
