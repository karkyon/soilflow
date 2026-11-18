/* 日付・時刻（11 1章・04 3.7）。サーバーは UTC で動き、日付の区切りは日本時間 */
const TZ = 'Asia/Tokyo';
const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

let fixedNow: Date | null = null;
/** 試験用に現在時刻を固定する（null で解除） */
export function setNow(d: Date | string | null) { fixedNow = d === null ? null : new Date(d); }
export function now(): Date { return fixedNow ? new Date(fixedNow) : new Date(); }

/** 日本時間の 'YYYY-MM-DD' と 'HH:MM' */
export function jst(d: Date = now()): { date: string; time: string; hour: number; iso: string } {
  const s = fmt.format(d); // 2026-02-05 15:10:00
  const date = s.slice(0, 10), time = s.slice(11, 16);
  return { date, time, hour: Number(time.slice(0, 2)), iso: `${date}T${s.slice(11, 19)}+09:00` };
}
export const todayJst = () => jst().date;

/** Prisma の @db.Date ⇔ 'YYYY-MM-DD' */
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** Prisma の @db.Time ⇔ 'HH:MM' */
export const hhmm = (d: Date) => d.toISOString().slice(11, 16);
export const toTime = (s: string) => new Date(`1970-01-01T${s}:00.000Z`);
/** timestamptz を日本時間の ISO 8601（+09:00）で */
export const isoJst = (d: Date | null | undefined) => (d ? jst(d).iso : null);

export function addDays(s: string, k: number) { const d = toDate(s); d.setUTCDate(d.getUTCDate() + k); return ymd(d); }
export const isValidYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(toDate(s)) === s;
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const jdate = (s: string) => { const d = toDate(s); return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEKDAYS[d.getUTCDay()]}）`; };
export const jdateShort = (s: string) => { const d = toDate(s); return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };
