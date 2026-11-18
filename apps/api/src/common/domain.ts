/* 複数のモジュールで使う業務の決まり（ロックの判定・要再確認・変更分の通知・番号の採番） */
import { AppError } from './errors';
import { Prisma, Tx } from './prisma.service';

/** 伝票がこの状態なら、含まれる便は変えられない（07 5章 sf_trips_lock） */
export const SLIP_LOCKING = ['AWAITING_SIGNATURE', 'SIGNED', 'PAPER_PRINTED', 'PAPER_SIGNED'];
/** 請求書がこの状態なら、含まれる便は変えられない */
export const INVOICE_LOCKING = ['SENDING', 'SENT', 'SEND_ERROR'];
/** 伝票が有効（請求先を決める） */
export const SLIP_EFFECTIVE = ['DRAFT', ...SLIP_LOCKING];

export type LockKind = 'NONE' | 'SLIP' | 'INVOICE';
export const lockOf = (slipStatus: string | null | undefined, invoiceStatus: string | null | undefined): LockKind =>
  invoiceStatus && INVOICE_LOCKING.includes(invoiceStatus) ? 'INVOICE' : slipStatus && SLIP_LOCKING.includes(slipStatus) ? 'SLIP' : 'NONE';

export function assertUnlocked(lock: LockKind) {
  if (lock === 'INVOICE') throw new AppError('TRIP_LOCKED_BY_INVOICE');
  if (lock === 'SLIP') throw new AppError('TRIP_LOCKED_BY_SLIP');
}

/** 便のロックの状態をまとめて調べる */
export async function lockStates(tx: Tx, tripIds: string[]): Promise<Map<string, LockKind>> {
  if (!tripIds.length) return new Map();
  const rows = await tx.$queryRaw<{ id: string; ss: string | null; is: string | null }[]>`
    SELECT t.id, s.status AS ss, i.status AS "is" FROM trips t
    LEFT JOIN slips s ON s.id = t.slip_id LEFT JOIN invoices i ON i.id = t.invoice_id
    WHERE t.id = ANY(${tripIds}::uuid[])`;
  return new Map(rows.map((r) => [r.id, lockOf(r.ss, r.is)]));
}

/** 便の変更を画面に知らせる（変更分の取得は updated_at で拾う。04 3.3） */
export async function touchTrips(tx: Tx, where: { slipId?: string; invoiceId?: string; tripIds?: string[] }) {
  if (where.slipId) await tx.$executeRaw`UPDATE trips SET updated_at = now() WHERE slip_id = ${where.slipId}::uuid`;
  if (where.invoiceId) await tx.$executeRaw`UPDATE trips SET updated_at = now() WHERE invoice_id = ${where.invoiceId}::uuid`;
  if (where.tripIds?.length) await tx.$executeRaw`UPDATE trips SET updated_at = now() WHERE id = ANY(${where.tripIds}::uuid[])`;
}

/**
 * 便が変わったとき、作成済・確認済の請求書を「要再確認」にする（04 5.2）。
 * 対象：その便を含む請求書と、その便の請求先・日付を請求期間に含む請求書
 */
export async function markInvoicesRecheck(tx: Tx, tripIds: string[]): Promise<string[]> {
  if (!tripIds.length) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE invoices i SET status = 'NEEDS_RECHECK', confirmed_at = NULL, confirmed_by = NULL
    WHERE i.status IN ('DRAFT','CONFIRMED') AND (
      i.id IN (SELECT invoice_id FROM trips WHERE id = ANY(${tripIds}::uuid[]) AND invoice_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM v_trip_billing b WHERE b.trip_id = ANY(${tripIds}::uuid[])
                 AND b.billing_party_id = i.billing_party_id AND b.trip_date BETWEEN i.period_from AND i.period_to))
    RETURNING i.id`;
  return rows.map((r) => r.id);
}

/** 採番（07 7章）。同時に発行しても重複しない */
export async function nextSlipNo(tx: Tx, date: string) {
  const r = await tx.$queryRaw<{ last_no: number }[]>`
    INSERT INTO slip_counters (slip_date, last_no) VALUES (${date}::date, 1)
    ON CONFLICT (slip_date) DO UPDATE SET last_no = slip_counters.last_no + 1 RETURNING last_no`;
  return `${date.replace(/-/g, '')}-${String(r[0].last_no).padStart(3, '0')}`;
}
/** 請求書の連番を n 個まとめて採り、最初の番号を返す */
export async function takeInvoiceSeq(tx: Tx, periodTo: string, n: number) {
  const ym = periodTo.slice(2, 4) + periodTo.slice(5, 7);
  const r = await tx.$queryRaw<{ last_no: number }[]>`
    INSERT INTO invoice_counters (ym, last_no) VALUES (${ym}, ${n})
    ON CONFLICT (ym) DO UPDATE SET last_no = invoice_counters.last_no + ${n} RETURNING last_no`;
  return r[0].last_no - n + 1;
}

/** version つきの更新。0件なら 409（07 8章） */
export async function updateVersioned<T>(fn: () => Promise<{ count: number }>, after: () => Promise<T>): Promise<T> {
  const r = await fn();
  if (!r.count) throw new AppError('CONFLICT');
  return after();
}

export const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
export const big = (v: bigint | number) => Number(v);
export const jsonOf = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
export const yen = (n: number) => n.toLocaleString('ja-JP');

/**
 * 便の品目（印による切り替え、11 3.1）を計算し直す。ロックされた便（伝票・送信済の請求書）は変えない。
 * 変わった便の ID を返す（呼び出し側で要再確認にする）
 */
export async function recomputeEffectiveItems(tx: Tx, where: { markId?: string; rowId?: string }): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE trips t SET effective_item_id = COALESCE(
      (SELECT mr.to_item_id FROM mark_rules mr JOIN marks m ON m.id = mr.mark_id AND m.active WHERE mr.mark_id = t.mark_id AND mr.from_item_id = r.item_id), r.item_id)
    FROM report_rows r
    WHERE r.id = t.report_row_id AND t.status = 'ACTIVE'
      AND (${where.markId ?? null}::uuid IS NULL OR t.mark_id = ${where.markId ?? null}::uuid)
      AND (${where.rowId ?? null}::uuid IS NULL OR t.report_row_id = ${where.rowId ?? null}::uuid)
      AND NOT EXISTS (SELECT 1 FROM slips s WHERE s.id = t.slip_id AND s.status IN ('AWAITING_SIGNATURE','SIGNED','PAPER_PRINTED','PAPER_SIGNED'))
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = t.invoice_id AND i.status IN ('SENDING','SENT','SEND_ERROR'))
      AND t.effective_item_id IS DISTINCT FROM COALESCE(
      (SELECT mr.to_item_id FROM mark_rules mr JOIN marks m ON m.id = mr.mark_id AND m.active WHERE mr.mark_id = t.mark_id AND mr.from_item_id = r.item_id), r.item_id)
    RETURNING t.id`;
  return rows.map((r) => r.id);
}

/** 印の切り替え先の品目（便の記入・印の変更のとき） */
export async function effectiveItemFor(tx: Tx, rowItemId: string, markId: string | null): Promise<string> {
  if (!markId) return rowItemId;
  const r = await tx.$queryRaw<{ to_item_id: string }[]>`
    SELECT mr.to_item_id FROM mark_rules mr JOIN marks m ON m.id = mr.mark_id AND m.active WHERE mr.mark_id = ${markId}::uuid AND mr.from_item_id = ${rowItemId}::uuid`;
  return r[0]?.to_item_id ?? rowItemId;
}
