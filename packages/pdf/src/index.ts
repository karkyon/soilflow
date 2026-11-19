/* SoilFlow 帳票（10 帳票設計書）。pdfmake ＋ Noto Sans JP。入力は描画に必要な値だけ（DB に依存しない） */
import { existsSync } from 'node:fs';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter = require('pdfmake/src/printer');

type FontSpec = string | [string, string];
const CANDIDATES: { normal: FontSpec; bold: FontSpec }[] = [
  { normal: process.env.PDF_FONT_REGULAR ?? '', bold: process.env.PDF_FONT_BOLD ?? process.env.PDF_FONT_REGULAR ?? '' },
  { normal: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', bold: '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc' },
  { normal: '/usr/share/fonts/truetype/noto/NotoSansJP-Regular.ttf', bold: '/usr/share/fonts/truetype/noto/NotoSansJP-Bold.ttf' },
];
const fileOf = (f: FontSpec) => (Array.isArray(f) ? f[0] : f);
const withFace = (f: FontSpec, face: string): FontSpec => (typeof f === 'string' && f.endsWith('.ttc') ? [f, face] : f);

let printer: { createPdfKitDocument: (d: TDocumentDefinitions) => NodeJS.ReadableStream & { end(): void } } | null = null;
function getPrinter() {
  if (printer) return printer;
  const c = CANDIDATES.find((x) => fileOf(x.normal) && existsSync(fileOf(x.normal)));
  if (!c) throw new Error('PDF の書体（Noto Sans JP）が見つかりません。PDF_FONT_REGULAR を設定してください');
  const bold = fileOf(c.bold) && existsSync(fileOf(c.bold)) ? c.bold : c.normal;
  printer = new PdfPrinter({
    JP: {
      normal: withFace(c.normal, 'NotoSansCJKjp-Regular'),
      bold: withFace(bold, 'NotoSansCJKjp-Bold'),
      italics: withFace(c.normal, 'NotoSansCJKjp-Regular'),
      bolditalics: withFace(bold, 'NotoSansCJKjp-Bold'),
    },
  });
  return printer!;
}

function render(def: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = getPrinter().createPdfKitDocument({
      ...def,
      defaultStyle: { font: 'JP', fontSize: 9.5, ...(def.defaultStyle || {}) },
      info: { creator: 'SoilFlow', producer: 'SoilFlow', ...(def.info || {}) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const MM = 2.8346;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const jdate = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return `${y}年${m}月${dd}日（${WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`;
};
export const jdateShort = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return `${y}年${m}月${dd}日`; };
const yen = (n: number) => n.toLocaleString('ja-JP');
const pageFooter = (cur: number, cnt: number): Content =>
  cnt > 1 ? { text: `${cur} / ${cnt}`, alignment: 'right', margin: [0, 0, 10 * MM, 0], fontSize: 8 } : { text: '' };

/* ---------------------------------------------------------------- RPT-01 受入日報 */
export interface DailyReportPdfInput {
  date: string; companyName: string; officeName: string; firstHour: number; lastHour: number;
  printedAt: string; printedBy: string;
  rows: { customerName: string; siteName: string | null; vehicleNo: string; itemLabel: string; customerId: string;
    trips: { time: string; markSymbol: string | null }[] }[];
  countByCustomer: Record<string, number>; total: number;
}
export async function dailyReportPdf(x: DailyReportPdfInput): Promise<Buffer> {
  const hours: number[] = []; for (let h = x.firstHour; h <= x.lastHour; h++) hours.push(h);
  const slot = (t: string) => Math.min(Math.max(Number(t.slice(0, 2)), x.firstHour), x.lastHour);
  const head: TableCell[] = ['会社名／現場', '車番', '品名', ...hours.map(String), '台数'].map((t) => ({ text: t, bold: true, alignment: 'center', fillColor: '#eeeeee' }));
  let last: string | null = null;
  const body: TableCell[][] = x.rows.map((r) => {
    const first = last !== r.customerId; last = r.customerId;
    const cells = hours.map((h) => {
      const ts = r.trips.filter((t) => slot(t.time) === h);
      const shown = ts.slice(0, 6).map((t) => (t.markSymbol === '○' ? `○${t.time.slice(3)}` : `${t.time.slice(3)}${t.markSymbol ?? ''}`));
      return { text: shown.join(' ') + (ts.length > 6 ? ` ＋${ts.length - 6}` : ''), fontSize: 7.5 } as TableCell;
    });
    return [
      first ? { stack: [{ text: r.customerName, bold: true }, { text: r.siteName ?? '', fontSize: 7.5 }] } : { text: '' },
      { text: r.vehicleNo, alignment: 'center' }, { text: r.itemLabel },
      ...cells,
      { text: first ? String(x.countByCustomer[r.customerId] ?? 0) : '', bold: true, alignment: 'right' },
    ];
  });
  return render({
    pageSize: 'A3', pageOrientation: 'landscape', pageMargins: [10 * MM, 22 * MM, 10 * MM, 14 * MM],
    info: { title: `受入日報 ${x.date}` },
    header: () => ({
      margin: [10 * MM, 8 * MM, 10 * MM, 0],
      columns: [
        { text: '受入日報', fontSize: 18, bold: true, characterSpacing: 4, width: 'auto' },
        { text: `${jdate(x.date)}　${x.companyName} ${x.officeName}`, fontSize: 11, margin: [16, 5, 0, 0] },
        { text: `本日 ${x.total}台`, fontSize: 13, bold: true, alignment: 'right' },
      ],
    }),
    footer: (cur, cnt) => ({
      columns: [{ text: `印刷 ${x.printedAt} ${x.printedBy}`, fontSize: 8, margin: [10 * MM, 0, 0, 0] }, pageFooter(cur, cnt)],
    }),
    content: [{
      table: { headerRows: 1, dontBreakRows: true, widths: [110, 36, 90, ...hours.map(() => '*'), 34], body: [head, ...body] },
      layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, paddingTop: () => 3, paddingBottom: () => 3 },
    }],
  });
}

/* ---------------------------------------------------------------- RPT-02/03/04 伝票 */
export interface SlipPdfInput {
  slipNo: string; slipDate: string; addresseeName: string; siteName: string | null;
  billingPartyName: string | null; // 宛名と違うときだけ
  lines: { itemLabel: string; tripCount: number; vehicleNos: string }[];
  signaturePng?: Buffer | null; signedAt?: string | null;
  companyName: string; officeName: string; tel: string | null;
}
export type SlipCopy = 'customer' | 'office' | 'paper-customer' | 'paper-office';
const COPY_LABEL: Record<SlipCopy, string> = { customer: 'お客さま控え', office: 'フジモト様控え', 'paper-customer': '紙伝票　お客さま控え', 'paper-office': '紙伝票　フジモト様控え' };

function slipPage(x: SlipPdfInput, copy: SlipCopy, lines: SlipPdfInput['lines'], pageBreak: boolean, sheet: string): Content[] {
  const total = x.lines.reduce((a, l) => a + l.tripCount, 0);
  const paper = copy.startsWith('paper');
  const sig: Content = !paper && x.signaturePng
    ? { image: `data:image/png;base64,${x.signaturePng.toString('base64')}`, fit: [220, 60], alignment: 'center' }
    : { text: paper ? '' : '（サイン待ち）', color: '#999999', alignment: 'center', margin: [0, 22, 0, 0] };
  return [
    {
      pageBreak: pageBreak ? 'before' : undefined,
      columns: [{ text: '納品伝票（受入）', fontSize: 15, bold: true }, { text: COPY_LABEL[copy] + sheet, alignment: 'right', fontSize: 10, bold: true }],
    },
    { columns: [{ text: `No. ${x.slipNo}` }, { text: jdateShort(x.slipDate), alignment: 'right' }], margin: [0, 4, 0, 6] },
    { columns: [{ text: `${x.addresseeName} 様`, fontSize: 14, bold: true, width: '*' }, { text: `現場：${x.siteName ?? '—'}`, width: 'auto', margin: [0, 4, 0, 0] }] },
    {
      margin: [0, 6, 0, 0],
      table: {
        widths: ['*', 40, 150],
        body: [
          [{ text: '品名', bold: true, fillColor: '#eeeeee' }, { text: '台数', bold: true, alignment: 'center', fillColor: '#eeeeee' }, { text: '車番', bold: true, fillColor: '#eeeeee' }],
          ...lines.map((l) => [l.itemLabel, { text: String(l.tripCount), alignment: 'center' }, { text: l.vehicleNos, fontSize: 8.5 }] as TableCell[]),
          [{ text: '合計', bold: true }, { text: String(total), bold: true, alignment: 'center' }, ''],
        ],
      },
    },
    x.billingPartyName ? { text: `ご請求先：${x.billingPartyName} 御中`, margin: [0, 5, 0, 0] } : { text: '' },
    {
      margin: [0, 8, 0, 0],
      columns: [
        { text: '受領サイン', width: 60, margin: [0, 25, 0, 0] },
        { table: { widths: ['*'], heights: [64], body: [[sig]] }, layout: { hLineStyle: () => ({ dash: { length: 3 } }), vLineStyle: () => ({ dash: { length: 3 } }) } as never },
        { text: !paper && x.signedAt ? x.signedAt : '', width: 100, fontSize: 8.5, margin: [6, 50, 0, 0] },
      ],
    },
    { text: `${x.companyName} ${x.officeName}${x.tel ? '　TEL ' + x.tel : ''}`, margin: [0, 8, 0, 0], fontSize: 8.5 },
  ];
}
/** copies の順にページを並べる。明細は1枚8行まで */
export async function slipPdf(x: SlipPdfInput, copies: SlipCopy[]): Promise<Buffer> {
  const chunks: SlipPdfInput['lines'][] = [];
  for (let i = 0; i < Math.max(1, x.lines.length); i += 8) chunks.push(x.lines.slice(i, i + 8));
  const content: Content[] = [];
  copies.forEach((c, ci) => chunks.forEach((ls, li) => content.push(...slipPage(x, c, ls, ci > 0 || li > 0, chunks.length > 1 ? `（${li + 1}/${chunks.length}）` : ''))));
  return render({ pageSize: 'A5', pageOrientation: 'landscape', pageMargins: [10 * MM, 10 * MM, 10 * MM, 10 * MM], info: { title: `伝票 ${x.slipNo}` }, content });
}

/* ---------------------------------------------------------------- RPT-05 請求書 */
export interface InvoicePdfInput {
  invoiceNo: string; issueDate: string; dueDate: string; periodFrom: string; periodTo: string;
  billingPartyName: string; honorific: string; postalCode: string | null; address: string | null;
  replacesInvoiceNo: string | null;
  lines: { siteId: string | null; siteName: string | null; itemName: string; vehicleClassName: string; tripCount: number; unitPrice: number; amount: number }[];
  subtotal: number; taxRate: number; taxAmount: number; total: number;
  issuer: { companyName: string; officeName: string; postalCode: string | null; address: string | null; tel: string | null; fax: string | null; registrationNo: string | null; bankAccountText: string | null; note: string | null };
}
export async function invoicePdf(x: InvoicePdfInput): Promise<Buffer> {
  const sites: (string | null)[] = [];
  x.lines.forEach((l) => { if (!sites.includes(l.siteId)) sites.push(l.siteId); });
  const body: TableCell[][] = [[
    { text: '品目', bold: true, fillColor: '#eeeeee' }, { text: '車格', bold: true, fillColor: '#eeeeee' },
    { text: '台数', bold: true, alignment: 'right', fillColor: '#eeeeee' }, { text: '単価', bold: true, alignment: 'right', fillColor: '#eeeeee' },
    { text: '金額', bold: true, alignment: 'right', fillColor: '#eeeeee' },
  ]];
  for (const sid of sites) {
    const ls = x.lines.filter((l) => l.siteId === sid);
    body.push([{ text: `■ 現場：${ls[0].siteName ?? '（現場なし）'}`, bold: true, colSpan: 5, fillColor: '#f6f6f6' }, '', '', '', '']);
    ls.forEach((l) => body.push([l.itemName, l.vehicleClassName, { text: yen(l.tripCount), alignment: 'right' }, { text: yen(l.unitPrice), alignment: 'right' }, { text: yen(l.amount), alignment: 'right' }]));
    body.push([{ text: '現場の小計', colSpan: 4, alignment: 'right' }, '', '', '', { text: yen(ls.reduce((a, l) => a + l.amount, 0)), alignment: 'right' }]);
  }
  const i = x.issuer;
  return render({
    pageSize: 'A4', pageMargins: [10 * MM, 10 * MM, 10 * MM, 12 * MM], info: { title: `請求書 ${x.invoiceNo}` },
    footer: (cur, cnt) => pageFooter(cur, cnt),
    content: [
      {
        columns: [
          { width: '*', stack: [
            { text: x.postalCode ? `〒${x.postalCode}` : '' }, { text: x.address ?? '' },
            { text: `${x.billingPartyName} ${x.honorific}`, fontSize: 14, bold: true, margin: [0, 6, 0, 0] },
          ] },
          { width: 230, alignment: 'right', stack: [
            { text: '請 求 書', fontSize: 20, bold: true, characterSpacing: 6 },
            { text: `No. ${x.invoiceNo}` },
            ...(x.replacesInvoiceNo ? [{ text: `再発行（元の請求書：${x.replacesInvoiceNo}）`, fontSize: 8.5 }] : []),
            { text: `請求日 ${jdateShort(x.issueDate)}` },
            ...(i.registrationNo ? [{ text: `登録番号 ${i.registrationNo}` }] : []),
            { text: i.companyName, bold: true, margin: [0, 4, 0, 0] }, { text: i.officeName },
            { text: [i.postalCode ? `〒${i.postalCode} ` : '', i.address ?? ''].join('') }, { text: [i.tel ? `TEL ${i.tel}` : '', i.fax ? ` FAX ${i.fax}` : ''].join('') },
          ] },
        ],
      },
      { text: '下記のとおりご請求申し上げます。', margin: [0, 10, 0, 6] },
      {
        columns: [
          { width: 'auto', table: { body: [[{ text: `ご請求金額　${yen(x.total)}円（税込）`, fontSize: 15, bold: true, margin: [8, 4, 8, 4] }]] } },
          { width: '*', margin: [14, 0, 0, 0], stack: [{ text: `お支払期日　${jdateShort(x.dueDate)}` }, { text: `お振込先　${i.bankAccountText ?? ''}` }] },
        ],
      },
      { text: `請求期間　${jdateShort(x.periodFrom)}〜${jdateShort(x.periodTo)}`, margin: [0, 10, 0, 4] },
      { table: { headerRows: 1, dontBreakRows: true, widths: ['*', 50, 50, 70, 80], body }, layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6 } },
      {
        margin: [0, 10, 0, 0], unbreakable: true,
        columns: [{ width: '*', text: '' }, {
          width: 260,
          table: { widths: ['*', 90], body: [
            ['小計（税抜）', { text: yen(x.subtotal), alignment: 'right' }],
            [`${x.taxRate}%対象 ${yen(x.subtotal)}円　消費税`, { text: yen(x.taxAmount), alignment: 'right' }],
            [{ text: '合計（税込）', bold: true }, { text: yen(x.total), bold: true, alignment: 'right' }],
          ] },
        }],
      },
      ...(i.note ? [{ text: i.note, fontSize: 8.5, margin: [0, 14, 0, 0] } as Content] : []),
    ],
  });
}

/* ---------------------------------------------------------------- RPT-07 領収書（現金のお客さま、FR-BIL-15・設計案） */
export interface CashReceiptPdfInput {
  receiptNo: string; receiptDate: string; addresseeName: string; slipNo: string; siteName: string | null;
  lines: { itemName: string; vehicleClassName: string; tripCount: number; unitPrice: number; amount: number }[];
  subtotal: number; taxRate: number; taxAmount: number; total: number; revenueStamp: boolean; receivedByName: string;
  issuer: { companyName: string; officeName: string; postalCode: string | null; address: string | null; tel: string | null; registrationNo: string | null };
}
function receiptHalf(x: CashReceiptPdfInput, copy: 'customer' | 'office'): Content[] {
  const i = x.issuer;
  const body: TableCell[][] = [[
    { text: '品目', bold: true, fillColor: '#eeeeee' }, { text: '車格', bold: true, fillColor: '#eeeeee' }, { text: '台数', bold: true, alignment: 'right', fillColor: '#eeeeee' },
    { text: '単価', bold: true, alignment: 'right', fillColor: '#eeeeee' }, { text: '金額（税抜）', bold: true, alignment: 'right', fillColor: '#eeeeee' },
  ], ...x.lines.map((l) => [l.itemName, l.vehicleClassName, { text: yen(l.tripCount), alignment: 'right' }, { text: yen(l.unitPrice), alignment: 'right' }, { text: yen(l.amount), alignment: 'right' }] as TableCell[])];
  return [
    {
      columns: [
        { width: '*', stack: [
          { text: copy === 'customer' ? '領 収 書' : '領 収 書（控え）', fontSize: 18, bold: true, characterSpacing: 4 },
          { text: `${x.addresseeName} 様`, fontSize: 14, bold: true, margin: [0, 8, 0, 0] },
        ] },
        { width: 200, alignment: 'right', stack: [
          { text: `No. ${x.receiptNo}` }, { text: jdateShort(x.receiptDate) }, { text: `伝票 ${x.slipNo}`, fontSize: 8.5 },
        ] },
      ],
    },
    { margin: [0, 8, 0, 4], table: { widths: ['*'], body: [[{ text: `¥${yen(x.total)} −（税込）`, fontSize: 20, bold: true, alignment: 'center', margin: [0, 6, 0, 6] }]] } },
    { text: `但し　受入・納品の代金として${x.siteName ? `（現場：${x.siteName}）` : ''}　上記の金額を正に領収いたしました。`, margin: [0, 0, 0, 6] },
    { table: { headerRows: 1, widths: ['*', 50, 40, 60, 80], body }, layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5 }, fontSize: 9 },
    {
      margin: [0, 6, 0, 0],
      columns: [
        x.revenueStamp
          ? { width: 70, table: { widths: [60], heights: [60], body: [[{ text: '収入\n印紙', alignment: 'center', color: '#888888', margin: [0, 18, 0, 0] }]] } }
          : { width: 70, text: '' },
        { width: '*', margin: [10, 0, 0, 0], stack: [
          { text: i.companyName, bold: true }, { text: i.officeName }, { text: [i.postalCode ? `〒${i.postalCode} ` : '', i.address ?? ''].join('') }, { text: i.tel ? `TEL ${i.tel}` : '' },
          ...(i.registrationNo ? [{ text: `登録番号 ${i.registrationNo}` }] : []), { text: `受領者　${x.receivedByName}`, margin: [0, 2, 0, 0] },
        ] },
        { width: 210, table: { widths: ['*', 70], body: [
          [`${x.taxRate}%対象（税抜）`, { text: yen(x.subtotal), alignment: 'right' }],
          [`消費税（${x.taxRate}%）`, { text: yen(x.taxAmount), alignment: 'right' }],
          [{ text: '合計（税込）', bold: true }, { text: yen(x.total), bold: true, alignment: 'right' }],
        ] }, fontSize: 9 },
      ],
    },
  ];
}
export async function cashReceiptPdf(x: CashReceiptPdfInput): Promise<Buffer> {
  return render({
    pageSize: 'A4', pageMargins: [12 * MM, 10 * MM, 12 * MM, 10 * MM], info: { title: `領収書 ${x.receiptNo}` },
    content: [
      ...receiptHalf(x, 'customer'),
      { text: '- - - - - - - - - - - - - - - - - - - - - - - - - - - - 切り取り - - - - - - - - - - - - - - - - - - - - - - - - - - - -', alignment: 'center', color: '#999999', fontSize: 8, margin: [0, 18, 0, 18] },
      ...receiptHalf(x, 'office'),
    ],
  });
}
