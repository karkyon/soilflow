'use client';
/* SCR-10 受入日報（FR-RCV-01〜22）。紙の日報と同じ形。マスをクリックすると今の「分」が入る */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Alert, Button, cx, ErrorBox, errMsg, Loading, useToast } from '@/components/ui';
import { useOnline } from '@/components/Shell';
import { api, ApiError, openFile, uuid } from '@/lib/api/client';
import { addDays, jdate, jstNow, today } from '@/lib/format';
import { Item, useMaster } from '@/lib/masters';
import { RowDialog, RowDraft } from './RowDialog';
import { SlipDialog } from './SlipDialog';
import { MenuTarget, TripMenu } from './TripMenu';
import { Mark, Row, Trip, useDailyReport } from './useDailyReport';

const MAX_IN_CELL = 4;

function useClock() {
  const [n, setN] = useState(jstNow());
  useEffect(() => { const t = setInterval(() => setN(jstNow()), 15000); return () => clearInterval(t); }, []);
  return n;
}

function Chip({ t, mark, onClick }: { t: Trip; mark?: Mark; onClick: (e: React.MouseEvent) => void }) {
  const mm = t.time.slice(3, 5);
  const left = mark && mark.symbol === '○', right = mark && mark.symbol !== '○';
  return (
    <button type="button" onClick={onClick} title={`${t.time}${mark ? ` ${mark.displayName}` : ''}${t.locked === 'SLIP' ? '（伝票で固定）' : t.locked === 'INVOICE' ? '（請求書で固定）' : ''}`}
      className={cx('rounded px-1 py-0.5 text-[13px] font-bold num leading-none', t.pending && 'text-gray-400', t.locked !== 'NONE' && 'underline decoration-dotted underline-offset-4')}
      style={mark ? { color: mark.color, background: mark.symbol === '○' ? '#F1E4D9' : '#E1EFE4' } : undefined}>
      {left && '○'}{mm}{right && mark.symbol}
    </button>
  );
}

export function DailyGrid({ initialDate, office }: { initialDate?: string; office?: boolean }) {
  const toast = useToast(); const online = useOnline(); const clock = useClock();
  const [date, setDate] = useState(initialDate ?? today());
  const { data, error, apply, reload } = useDailyReport(date);
  const items = useMaster<Item>('items');
  const [rowDlg, setRowDlg] = useState<{ row?: Row | null; draft?: RowDraft | null } | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [slipOpen, setSlipOpen] = useState(false);
  const [convoy, setConvoy] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const isToday = date === clock.date, isFuture = date > clock.date;
  const hours = useMemo(() => (data ? Array.from({ length: data.lastHour - data.firstHour + 1 }, (_, i) => data.firstHour + i) : []), [data]);
  const curSlot = data ? Math.min(Math.max(clock.hour, data.firstHour), data.lastHour) : -1;
  const groups = useMemo(() => {
    const g: { customerId: string; customerName: string; rows: Row[] }[] = [];
    for (const r of data?.rows ?? []) { const last = g.at(-1); if (last && last.customerId === r.customerId) last.rows.push(r); else g.push({ customerId: r.customerId, customerName: r.customerName, rows: [r] }); }
    return g;
  }, [data?.rows]);
  useEffect(() => setConvoy(new Set()), [date]);

  /** 便の記入。押した瞬間に表示し（灰色）、保存できたら確定、失敗したら戻す（04 3.2） */
  const addNow = async (rowIds: string[]) => {
    if (!online) { toast('オフラインのため記入できません', 'err'); return; }
    const op = uuid(); const t = jstNow();
    const temps: Trip[] = rowIds.map((rowId, i) => ({ id: `tmp-${op}-${i}`, rowId, time: t.time, hourSlot: curSlot, markId: null, effectiveItemId: '', convoyId: null, slipId: null, locked: 'NONE', status: 'ACTIVE', version: 0, pending: true }));
    apply({ trips: temps });
    const body = { date, rowIds, clientTime: new Date().toISOString(), clientOpId: op };
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api.post<{ trips: Trip[]; clockSkewWarning?: boolean }>('/trips', body);
        apply({ trips: r.trips, removeTripIds: temps.map((x) => x.id) });
        toast(`${r.trips[0]?.time} を記入しました${rowIds.length > 1 ? `（車列 ${rowIds.length} 台）` : ''}`);
        if (r.clockSkewWarning) toast('PCの時計がずれています（サーバーの時刻で記入しました）', 'warn');
        return;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NETWORK' && attempt < 2) { await new Promise((s) => setTimeout(s, 800 * (attempt + 1))); continue; }
        apply({ removeTripIds: temps.map((x) => x.id) });
        toast(errMsg(e), 'err');
        return;
      }
    }
  };

  const onCell = (row: Row, hour: number) => {
    if (isFuture) { toast('今日より後の日報には記入できません', 'err'); return; }
    if (isToday && hour === curSlot) void addNow([row.id]);
    else if (isToday && hour > curSlot) toast('今より後の時間帯には記入できません', 'err');
    else setMenu({ mode: 'add', row, hour });
  };

  const carryOver = async () => {
    setBusy(true);
    try {
      const c = await api.get<{ fromDate: string | null; rows: Row[] }>(`/daily-reports/${date}/carry-over`);
      if (!c.rows.length) { toast('引き継げる前の日の行がありません', 'warn'); return; }
      const made = await api.post<Row[]>(`/daily-reports/${date}/carry-over`, { rowIds: c.rows.map((r) => r.id) });
      apply({ rows: made }); toast(`${jdate(c.fromDate)} の行を ${made.length} 行引き継ぎました`); reload();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  return (
    <div className="flex h-full flex-col">
      <div className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-white px-4 py-3">
        <div className="flex items-center gap-1">
          <Button size="sm" aria-label="前の日" onClick={() => setDate(addDays(date, -1))}>◀</Button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="sr-only" id="sf-date" />
          <label htmlFor="sf-date" className="cursor-pointer px-2 text-xl font-bold text-navy">{jdate(date)}</label>
          <Button size="sm" aria-label="次の日" onClick={() => setDate(addDays(date, 1))}>▶</Button>
          {!isToday && <Button size="sm" kind="ghost" onClick={() => setDate(clock.date)}>今日へ</Button>}
        </div>
        <span className="rounded-md bg-navy px-3 py-1.5 font-bold text-white">本日 <span className="text-lg num">{data?.counts.total ?? 0}</span>台</span>
        {isToday && <span className="text-sm text-gray-600">現在 <span className="num">{clock.time}</span></span>}
        <div className="ml-auto flex gap-2">
          {convoy.size >= 2 && isToday && <Button kind="navy" onClick={() => { void addNow([...convoy]); setConvoy(new Set()); }}>選んだ {convoy.size} 行に今の時刻で記入</Button>}
          {data && !data.rows.length && !isFuture && <Button busy={busy} onClick={carryOver}>前日の行を引き継ぐ</Button>}
          <Button kind="primary" disabled={isFuture} onClick={() => setRowDlg({})}>＋ 行を追加</Button>
          <Button disabled={!data?.trips.length} onClick={() => setSlipOpen(true)}>伝票を発行</Button>
          <Button onClick={() => openFile(`/daily-reports/${date}/pdf`).catch((e) => toast(errMsg(e), 'err'))}>日報を印刷</Button>
        </div>
      </div>
      {isFuture && <div className="px-4 pt-3"><Alert>今日より後の日報には記入できません。</Alert></div>}
      {!data ? <Loading /> : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="grid-table w-full min-w-[1100px] bg-white text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-navy text-white">
                <th className="w-10 border-r border-white/10 py-2 text-xs">車列</th>
                <th className="w-44 border-r border-white/10 px-2 text-left">会社名／現場</th>
                <th className="w-16 border-r border-white/10">車番</th>
                <th className="w-28 border-r border-white/10 px-2 text-left">品名</th>
                {hours.map((h) => <th key={h} className={cx('border-r border-white/10 num', isToday && h === curSlot && 'bg-gold')}>{h}</th>)}
                <th className="w-16">台数</th>
              </tr>
            </thead>
            <tbody>
              {!groups.length && <tr><td colSpan={hours.length + 5} className="py-12 text-center text-gray-500">まだ行がありません。「＋ 行を追加」か「前日の行を引き継ぐ」で始めてください。</td></tr>}
              {groups.map((g) => (
                <Fragment key={g.customerId}>
                  {g.rows.map((r, i) => (
                    <tr key={r.id} className="border-b border-line">
                      <td className="border-r border-line text-center"><input type="checkbox" aria-label={`${r.vehicleNo} を車列に選ぶ`} checked={convoy.has(r.id)} disabled={!isToday}
                        onChange={(e) => { const n = new Set(convoy); if (e.target.checked) n.add(r.id); else n.delete(r.id); setConvoy(n); }} /></td>
                      {i === 0 && <td rowSpan={g.rows.length} className="border-r border-b border-line px-2 py-1.5 align-top"><div className="font-bold">{g.customerName}</div>
                        <div className="text-xs text-gray-600">{[...new Set(g.rows.map((x) => x.siteName).filter(Boolean))].join('・')}</div></td>}
                      <td className="border-r border-line text-center"><button type="button" className="font-bold num hover:underline" onClick={() => setRowDlg({ row: r })}>{r.vehicleNo}</button></td>
                      <td className="border-r border-line px-2"><div>{r.itemLabel}{r.vehicleClassName}</div>{r.siteName && <div className="text-xs text-gray-500">{r.siteName}</div>}</td>
                      {hours.map((h) => {
                        const ts = data.trips.filter((t) => t.rowId === r.id && t.hourSlot === h && t.status === 'ACTIVE').sort((a, b) => a.time.localeCompare(b.time));
                        const future = isFuture || (isToday && h > curSlot); const now = isToday && h === curSlot;
                        return (
                          <td key={h} className={cx('h-11 cursor-pointer border-r border-line px-1 align-middle', now && 'bg-gold-pale', future && 'cursor-not-allowed bg-gray-100')}
                            onClick={() => onCell(r, h)} onContextMenu={(e) => { e.preventDefault(); setMenu({ mode: 'cell', row: r, hour: h }); }}>
                            <div className="flex flex-wrap items-center gap-0.5">
                              {ts.slice(0, MAX_IN_CELL).map((t) => <Chip key={t.id} t={t} mark={data.marks.find((m) => m.id === t.markId)} onClick={(e) => { e.stopPropagation(); if (!t.pending) setMenu({ mode: 'trip', trip: t }); }} />)}
                              {ts.length > MAX_IN_CELL && <button type="button" className="text-xs font-bold text-info" onClick={(e) => { e.stopPropagation(); setMenu({ mode: 'cell', row: r, hour: h }); }}>＋{ts.length - MAX_IN_CELL}</button>}
                              {now && !ts.length && <span className="w-full text-center text-gold" aria-hidden>＋</span>}
                            </div>
                          </td>
                        );
                      })}
                      {i === 0 && <td rowSpan={g.rows.length} className="border-b border-line text-center align-top text-lg font-bold num pt-2">{data.counts.byCustomer[g.customerId] ?? 0}</td>}
                    </tr>
                  ))}
                  <tr className="border-b-2 border-line bg-cream/50"><td />
                    <td colSpan={hours.length + 4} className="px-3 py-1"><button type="button" className="text-[13px] text-info hover:underline" disabled={isFuture}
                      onClick={() => { const l = g.rows.at(-1)!; setRowDlg({ draft: { customerId: g.customerId, siteId: l.siteId, itemId: l.itemId, vehicleClassId: l.vehicleClassId } }); }}>＋ 車番を追加（{g.customerName}）</button></td></tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="no-print border-t border-line bg-white px-4 py-2 text-xs text-gray-600">
        マスをクリック → 今の時刻の「分」が入る（前の時間帯は分を選んで後から記入）　分を押すと印のメニュー　右クリック → そのマスの便の一覧（時刻の修正・取消）　点線の下線＝伝票・請求書で固定{office && '　（本社でも記入・修正できます）'}
      </div>
      <RowDialog open={!!rowDlg} onClose={() => setRowDlg(null)} date={date} row={rowDlg?.row} draft={rowDlg?.draft} onSaved={(r) => { apply({ rows: [r] }); reload(); }} onDeleted={(id) => apply({ removeRowIds: [id] })} />
      {data && <TripMenu target={menu} onClose={() => setMenu(null)} date={date} rows={data.rows} trips={data.trips} marks={data.marks} items={items.data ?? []} onChanged={(c) => apply(c)} canEdit={online} />}
      {data && <SlipDialog open={slipOpen} onClose={() => setSlipOpen(false)} report={data} onDone={reload} />}
    </div>
  );
}
