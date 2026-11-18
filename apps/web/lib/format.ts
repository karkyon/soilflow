/* 表示の形（10 1章）。日付は日本時間 */
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const yen = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('ja-JP'));
export function jstNow() {
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  return { date: s.slice(0, 10), time: s.slice(11, 16), hour: Number(s.slice(11, 13)) };
}
export const today = () => jstNow().date;
export function addDays(d: string, k: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); }
export function jdate(d: string | null | undefined) {
  if (!d) return '—';
  const x = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return `${x.getUTCFullYear()}年${x.getUTCMonth() + 1}月${x.getUTCDate()}日（${WD[x.getUTCDay()]}）`;
}
export const jdateShort = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-').map(Number); return `${y}/${m}/${dd}`; };
export const jdatetime = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ').replace(/-/g, '/') : '—');
export const thisMonth = () => today().slice(0, 7);
export function addMonths(ym: string, k: number) { const [y, m] = ym.split('-').map(Number); const t = y * 12 + m - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }
export const monthLabel = (ym: string) => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;
/** 読みがなの頭文字の行（あ・か・さ…）（SCR-11） */
const ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ'];
const STARTS = 'あかさたなはまやらわ'.split('').map((c) => c.charCodeAt(0));
export function kanaRow(kana: string) {
  const c = kana.normalize('NFKC').replace(/[ァ-ヶ]/g, (x) => String.fromCharCode(x.charCodeAt(0) - 0x60)).charCodeAt(0);
  if (c < 0x3041 || c > 0x3096) return '他';
  let i = 0; for (let k = 0; k < STARTS.length; k++) if (c >= STARTS[k]) i = k;
  return ROWS[i];
}
export const KANA_ROWS = [...ROWS, '他'];
