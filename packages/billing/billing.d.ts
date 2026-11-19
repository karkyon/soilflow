/* packages/billing（11 計算仕様書）の型。実装は billing.js */

export type Rounding = 'floor' | 'round' | 'ceil';

export interface BRow { id: string; customerId: string; siteId: string | null; itemId: string; vehicleClassId: string }
export interface BTrip {
  id: string; rowId: string; date: string; time: string; markId: string | null;
  status: 'ACTIVE' | 'CANCELLED'; slipId: string | null; lockedInvoiceId?: string | null;
  /** 現金の領収書で受け取り済み（FR-BIL-15）。請求書に入れない */
  cashReceiptId?: string | null;
}
export interface BSlip { id: string; status: string; billingPartyId: string }
export interface BSite { id: string; name: string; kana?: string; defaultBillingPartyId: string | null }
export interface BCustomer { id: string; defaultBillingPartyId: string }
export interface BBillingParty {
  id: string; name: string; kana?: string; closingDay: number; paymentMonthOffset?: number; paymentDay?: number; active?: boolean;
}
export interface BItem { id: string; sortOrder: number; [k: string]: unknown }
export interface BVehicleClass { id: string; sortOrder: number; [k: string]: unknown }
export interface BPriceEntry { itemId: string; vehicleClassId: string; unitPrice: number }
export interface BPriceTable { id: string; effectiveFrom: string; entries: BPriceEntry[] }
export interface BMarkRule { markId: string; fromItemId: string; toItemId: string }

export interface BillingContext {
  rows: BRow[]; trips: BTrip[]; slips: BSlip[]; sites: BSite[]; customers: BCustomer[];
  billingParties: BBillingParty[]; items: BItem[]; vehicleClasses: BVehicleClass[];
  priceTables: BPriceTable[]; markRules: BMarkRule[];
  taxRate?: number; rounding?: Rounding; billingPartyIds?: string[]; seqStart?: number;
}

export interface BInvoiceLine {
  lineNo: number; siteId: string | null; itemId: string; vehicleClassId: string; unitPrice: number; tripCount: number; amount: number;
}
export interface BInvoice {
  invoiceNo: string; billingPartyId: string; periodFrom: string; periodTo: string; issueDate: string; dueDate: string;
  lines: BInvoiceLine[]; subtotal: number; taxRate: number; taxAmount: number; total: number; tripIds: string[];
}
export interface BProblem {
  kind: 'ROW_MISSING' | 'BILLING_PARTY_MISSING' | 'ALREADY_INVOICED' | 'PRICE_MISSING' | 'INVOICE_BLOCKED' | 'CASH_SETTLED';
  tripId?: string; billingPartyId?: string; date?: string; itemId?: string; vehicleClassId?: string; invoiceId?: string; cashReceiptId?: string;
}

export interface FreeeMapping { accountItemId: number; taxCode: number; freeeItemId: number | null }
export interface FreeeDetail { accountItemId: number; taxCode: number; itemId: number | null; amount: number; vat: number }

export function billingPeriod(ym: string, closingDay: number): { from: string; to: string };
export function dueDate(periodTo: string, offsetMonths: number, payDay: number): string;
export function effectiveItemId(rowItemId: string, markId: string | null, markRules: BMarkRule[]): string;
export function priceTableFor(date: string, priceTables: BPriceTable[]): BPriceTable | null;
export function unitPrice(date: string, itemId: string, vehicleClassId: string, priceTables: BPriceTable[]): number | null;
export function referencePrice(pricePerM3: number | null, capacityM3: number, smallVehicle: boolean, smallLoadingFee: number): number | null;
export function billingPartyIdFor(
  trip: { slipId: string | null }, row: { siteId: string | null; customerId: string },
  ctx: { slips: BSlip[]; sites: BSite[]; customers: BCustomer[] },
): string | null;
export function taxOf(subtotal: number, ratePercent: number, mode: Rounding): number;
export function invoiceNo(periodTo: string, seq: number): string;
export function buildInvoices(ym: string, ctx: BillingContext): { invoices: BInvoice[]; problems: BProblem[] };
export function freeeDetails(
  invoice: { lines: { lineNo: number; itemId: string; amount: number }[]; taxRate: number; taxAmount: number },
  mapping: Record<string, FreeeMapping>, rounding?: Rounding,
): { details: FreeeDetail[]; error?: undefined } | { error: 'ITEM_MAPPING_MISSING'; itemIds: string[] } | { error: 'TOO_MANY_DETAILS'; count: number };
export function tripCounts(rows: { id: string; customerId: string }[], trips: { rowId: string; status: string }[]): {
  byRow: Record<string, number>; byCustomer: Record<string, number>; total: number;
};
export function hourSlot(time: string, firstHour: number, lastHour: number): number;

/* 現金の領収書（FR-BIL-15） */
export interface CashLine { itemId: string; vehicleClassId: string; unitPrice: number; tripCount: number; amount: number }
export function buildCashReceipt(
  trips: { id: string; date: string; itemId: string; vehicleClassId: string }[], priceTables: BPriceTable[], taxRate: number, rounding: Rounding,
): { lines: CashLine[]; subtotal: number; taxRate: number; taxAmount: number; total: number; error?: undefined } | { error: 'PRICE_MISSING'; tripIds: string[] };
export function cashReceiptNo(date: string, seq: number): string;
export function needsRevenueStamp(subtotal: number): boolean;
