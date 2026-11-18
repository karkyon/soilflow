'use client';
/* 日報の読み込みと、変更分の取得（5秒ごと、画面が見えていないときは止める。04 3.3） */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api/client';

export interface Row { id: string; customerId: string; customerName: string; siteId: string | null; siteName: string | null; vehicleId: string; vehicleNo: string; itemId: string; itemLabel: string; vehicleClassId: string; vehicleClassName: string; sortOrder: number; deleted?: boolean; version: number }
export interface Trip { id: string; rowId: string; time: string; hourSlot: number; markId: string | null; effectiveItemId: string; convoyId: string | null; slipId: string | null; locked: 'NONE' | 'SLIP' | 'INVOICE'; status: 'ACTIVE' | 'CANCELLED'; version: number; pending?: boolean }
export interface Mark { id: string; symbol: string; displayName: string; color: string }
export interface Counts { byRow: Record<string, number>; byCustomer: Record<string, number>; total: number }
export interface Report { id: string; date: string; firstHour: number; lastHour: number; rows: Row[]; trips: Trip[]; counts: Counts; marks: Mark[]; cursor: string }

const merge = <T extends { id: string }>(cur: T[], ch: T[]) => {
  const m = new Map(cur.map((x) => [x.id, x]));
  for (const x of ch) m.set(x.id, x);
  return [...m.values()];
};

export function useDailyReport(date: string) {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  const cursor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await api.get<Report>(`/daily-reports/${date}`); cursor.current = r.cursor; setData(r); setError(null); }
    catch (e) { setError(e); }
  }, [date]);

  const poll = useCallback(async () => {
    if (!cursor.current || document.hidden) return;
    try {
      const c = await api.get<{ cursor: string; rows: Row[]; trips: Trip[]; counts: Counts }>(`/daily-reports/${date}/changes`, { since: cursor.current });
      cursor.current = c.cursor;
      if (!c.rows.length && !c.trips.length) { setData((d) => (d ? { ...d, counts: c.counts } : d)); return; }
      setData((d) => d && d.date === date ? { ...d, rows: merge(d.rows, c.rows).filter((r) => !r.deleted), trips: merge(d.trips.filter((t) => !t.pending), c.trips).concat(d.trips.filter((t) => t.pending)), counts: c.counts } : d);
    } catch { /* 次の回に */ }
  }, [date]);

  useEffect(() => { setData(null); cursor.current = null; load(); }, [load]);
  useEffect(() => { const t = setInterval(poll, 5000); return () => clearInterval(t); }, [poll]);

  /** 保存した結果を画面に反映（ポーリングを待たない） */
  const apply = useCallback((ch: { rows?: Row[]; trips?: Trip[]; removeRowIds?: string[]; removeTripIds?: string[] }) => {
    setData((d) => {
      if (!d) return d;
      let rows = ch.rows ? merge(d.rows, ch.rows) : d.rows;
      if (ch.removeRowIds) rows = rows.filter((r) => !ch.removeRowIds!.includes(r.id));
      let trips = ch.trips ? merge(d.trips, ch.trips) : d.trips;
      if (ch.removeTripIds) trips = trips.filter((t) => !ch.removeTripIds!.includes(t.id));
      rows = rows.filter((r) => !r.deleted);
      const byRow: Record<string, number> = {}, byCustomer: Record<string, number> = {}; let total = 0;
      const rm = new Map(rows.map((r) => [r.id, r]));
      for (const t of trips) if (t.status === 'ACTIVE' && rm.has(t.rowId)) { byRow[t.rowId] = (byRow[t.rowId] ?? 0) + 1; const c = rm.get(t.rowId)!.customerId; byCustomer[c] = (byCustomer[c] ?? 0) + 1; total++; }
      return { ...d, rows, trips, counts: { byRow, byCustomer, total } };
    });
  }, []);

  return { data, error, reload: load, apply, poll };
}
