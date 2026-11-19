/* マスタ（FR-MST、SCR-50〜57）：客先・現場・請求先・車番・品目・車格・印、CSV の一括登録、単価表 */
import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { referencePrice } from '@soilflow/billing';
import { z, ZodTypeAny } from 'zod';
import { Actor, CurrentActor, isOffice, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { todayJst, toDate, ymd } from '../../common/dates';
import { markInvoicesRecheck, num, recomputeEffectiveItems } from '../../common/domain';
import { AppError, conflict, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse, zBoolQ, zDate, zUuid } from '../../common/validation';

export type MasterKind = 'customers' | 'sites' | 'billingParties' | 'vehicles' | 'items' | 'vehicleClasses' | 'marks';
const KINDS: MasterKind[] = ['customers', 'sites', 'billingParties', 'vehicles', 'items', 'vehicleClasses', 'marks'];
const KIND_JA: Record<MasterKind, string> = { customers: '客先', sites: '現場', billingParties: '請求先', vehicles: '車番', items: '品目', vehicleClasses: '車格', marks: '印' };

/* ---------------------------------------------------------------- 入力 */
const text = (max = 100) => z.string().trim().min(1).max(max);
const optText = (max = 500) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const emails = z.array(z.string().trim().email('メールアドレスの形式')).max(10);
const INPUT = {
  customers: z.object({ name: text(), kana: text(), defaultBillingPartyId: zUuid.optional(), sortOrder: z.number().int().optional(), note: optText(), active: z.boolean().optional() }),
  sites: z.object({ customerId: zUuid, name: text(), kana: text(), defaultBillingPartyId: zUuid.nullable().optional(), active: z.boolean().optional() }),
  billingParties: z.object({
    name: text(), kana: text(), honorific: z.enum(['御中', '様', '殿']).optional(),
    postalCode: z.string().regex(/^[0-9]{3}-[0-9]{4}$/, '郵便番号は 000-0000').nullable().optional().or(z.literal('').transform(() => null)),
    address: optText(), mailTo: emails.optional(), mailCc: emails.optional(),
    closingDay: z.number().int().min(0).max(28).optional(), paymentMonthOffset: z.number().int().min(0).max(3).optional(), paymentDay: z.number().int().min(0).max(31).optional(),
    paymentMethod: z.enum(['INVOICE', 'CASH']).optional(), // 現金のお客さま（FR-BIL-15）
    note: optText(), active: z.boolean().optional(),
  }),
  vehicles: z.object({ customerId: zUuid, vehicleNo: z.string().trim().min(1).max(20), defaultVehicleClassId: zUuid.nullable().optional(), active: z.boolean().optional() }),
  items: z.object({
    reportLabel: text(), priceItemName: text(), direction: z.enum(['RECEIVE', 'DELIVER']), pricePerM3Ref: z.number().int().min(0).nullable().optional(),
    smallVehicleFeeRef: z.number().int().min(0).optional(), sortOrder: z.number().int(), active: z.boolean().optional(),
  }),
  vehicleClasses: z.object({ name: text(20), capacityM3: z.number().positive().max(99), smallVehicle: z.boolean().optional(), sortOrder: z.number().int(), active: z.boolean().optional() }),
  marks: z.object({
    symbol: z.string().trim().min(1).max(2), displayName: text(20), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), sortOrder: z.number().int(), active: z.boolean().optional(),
    rules: z.array(z.object({ fromItemId: zUuid, toItemId: zUuid })).max(50).optional(),
  }),
} satisfies Record<MasterKind, z.ZodObject>;
const inputOf = (k: MasterKind): z.ZodObject => INPUT[k];
const MODEL: Record<MasterKind, string> = { customers: 'customer', sites: 'site', billingParties: 'billingParty', vehicles: 'vehicle', items: 'item', vehicleClasses: 'vehicleClass', marks: 'mark' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (tx: Tx | PrismaService, kind: MasterKind) => (tx as any)[MODEL[kind]];

/* ---------------------------------------------------------------- 出力（受付には金額・freee の項目を返さない、FR-RCV-20） */
type Rec = Record<string, unknown> & { id: string; active: boolean; version: number };
function dto(kind: MasterKind, r: Rec, office: boolean, extra: Record<string, unknown> = {}) {
  const o: Record<string, unknown> = { ...r, ...extra };
  delete o.createdAt; delete o.updatedAt;
  if (kind === 'vehicleClasses') o.capacityM3 = Number(r.capacityM3);
  for (const k of Object.keys(o)) if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
  if (!office) {
    for (const k of Object.keys(o)) if (k.startsWith('freee')) delete o[k];
    if (kind === 'items') { delete o.pricePerM3Ref; delete o.smallVehicleFeeRef; }
    if (kind === 'billingParties') { delete o.mailTo; delete o.mailCc; delete o.note; delete o.closingDay; delete o.paymentMonthOffset; delete o.paymentDay; }
  }
  return o;
}
const ORDER: Record<MasterKind, unknown> = {
  customers: [{ sortOrder: 'asc' }, { kana: 'asc' }], sites: [{ kana: 'asc' }], billingParties: [{ kana: 'asc' }], vehicles: [{ vehicleNo: 'asc' }],
  items: [{ sortOrder: 'asc' }], vehicleClasses: [{ sortOrder: 'asc' }], marks: [{ sortOrder: 'asc' }],
};
const kindOf = (k: string): MasterKind => { if (!KINDS.includes(k as MasterKind)) throw notFound(); return k as MasterKind; };
const labelOf = (kind: MasterKind, r: Record<string, unknown>) => String(r.name ?? r.reportLabel ?? r.vehicleNo ?? r.symbol ?? r.id);

@Injectable()
export class MastersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(actor: Actor, k: string, query: Record<string, unknown>) {
    const kind = kindOf(k);
    const q = parse(z.object({ includeInactive: zBoolQ.optional(), q: z.string().max(40).optional(), customerId: zUuid.optional() }), query);
    const where: Record<string, unknown> = {};
    if (!q.includeInactive) where.active = true;
    if (q.customerId && (kind === 'sites' || kind === 'vehicles')) where.customerId = q.customerId;
    if (q.q) {
      where.OR = kind === 'vehicles' ? [{ vehicleNo: { startsWith: q.q } }]
        : kind === 'items' ? [{ reportLabel: { startsWith: q.q } }, { priceItemName: { startsWith: q.q } }]
        : kind === 'marks' || kind === 'vehicleClasses' ? [{ [kind === 'marks' ? 'symbol' : 'name']: { startsWith: q.q } }]
        : [{ name: { startsWith: q.q } }, { kana: { startsWith: q.q } }];
    }
    const rows: Rec[] = await delegate(this.prisma, kind).findMany({ where, orderBy: ORDER[kind], take: 1000 });
    if (kind === 'marks') {
      const rules = await this.prisma.markRule.findMany({ where: { markId: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => dto(kind, r, true, { rules: rules.filter((x) => x.markId === r.id).map((x) => ({ fromItemId: x.fromItemId, toItemId: x.toItemId })) }));
    }
    return rows.map((r) => dto(kind, r, isOffice(actor)));
  }

  async create(actor: Actor, k: string, body: unknown) {
    const kind = kindOf(k);
    const input = parse(inputOf(kind).strict(), body) as Record<string, unknown>;
    return this.prisma.tx(async (tx) => {
      const { rules, ...data } = input as { rules?: { fromItemId: string; toItemId: string }[] } & Record<string, unknown>;
      if (kind === 'customers' && !data.defaultBillingPartyId) data.defaultBillingPartyId = (await this.billingPartyForCustomer(tx, actor, String(data.name), String(data.kana))).id;
      await this.checkRefs(tx, kind, data);
      const r: Rec = await delegate(tx, kind).create({ data });
      if (kind === 'marks' && rules) await this.saveRules(tx, r.id, rules);
      await this.audit.write(tx, actor, { action: 'MASTER_CREATE', targetType: MODEL[kind], targetId: r.id, summary: `${KIND_JA[kind]}「${labelOf(kind, r)}」を追加`, after: { ...data, rules } });
      return dto(kind, r, true, kind === 'marks' ? { rules: rules ?? [] } : {});
    });
  }

  /** 客先を登録すると同じ名前の請求先を作って既定にする（11 3.4 ケースA）。同名の請求先があればそれを使う */
  async billingPartyForCustomer(tx: Tx, actor: Actor, name: string, kana: string) {
    const bp = await tx.billingParty.findFirst({ where: { name, active: true } });
    if (bp) return bp;
    const created = await tx.billingParty.create({ data: { name, kana } });
    await this.audit.write(tx, actor, { action: 'MASTER_CREATE', targetType: 'billingParty', targetId: created.id, summary: `請求先「${name}」を追加（客先と同じ名前）` });
    return created;
  }

  async update(actor: Actor, k: string, id: string, body: unknown) {
    const kind = kindOf(k);
    const input = parse(inputOf(kind).partial().extend({ version: z.number().int() }).strict(), body) as Record<string, unknown>;
    parse(zUuid, id);
    return this.prisma.tx(async (tx) => {
      const { version, rules, ...data } = input as { version: number; rules?: { fromItemId: string; toItemId: string }[] } & Record<string, unknown>;
      const before: Rec | null = await delegate(tx, kind).findUnique({ where: { id } });
      if (!before) throw notFound(KIND_JA[kind]);
      if ((kind === 'sites' || kind === 'vehicles') && data.customerId && data.customerId !== before.customerId) throw new AppError('VALIDATION_ERROR', '客先は変えられません。新しく登録してください');
      await this.checkRefs(tx, kind, { ...before, ...data });
      const r = await delegate(tx, kind).updateMany({ where: { id, version }, data });
      if (!r.count) throw conflict();
      let changedTrips: string[] = [];
      if (kind === 'marks' && (rules || data.active !== undefined)) {
        if (rules) await this.saveRules(tx, id, rules);
        changedTrips = await recomputeEffectiveItems(tx, { markId: id });
        await markInvoicesRecheck(tx, changedTrips);
      }
      if ((kind === 'sites' && 'defaultBillingPartyId' in data) || (kind === 'customers' && data.defaultBillingPartyId)) {
        // 請求先の既定が変わると便の請求先が変わる（11 3.4）
        const t = await tx.$queryRaw<{ id: string }[]>`
          SELECT t.id FROM trips t JOIN report_rows r ON r.id = t.report_row_id
          WHERE t.status = 'ACTIVE' AND t.invoice_id IS NULL AND (r.site_id = ${id}::uuid OR r.customer_id = ${id}::uuid) LIMIT 5000`;
        await markInvoicesRecheck(tx, t.map((x) => x.id));
      }
      const after: Rec = await delegate(tx, kind).findUniqueOrThrow({ where: { id } });
      await this.audit.write(tx, actor, {
        action: 'MASTER_UPDATE', targetType: MODEL[kind], targetId: id,
        summary: `${KIND_JA[kind]}「${labelOf(kind, after)}」を${data.active === false ? '無効に' : '変更'}${changedTrips.length ? `（便 ${changedTrips.length} 件の品目を計算し直した）` : ''}`,
        before: pickKeys(before, Object.keys(data)), after: { ...pickKeys(after, Object.keys(data)), ...(rules ? { rules } : {}) },
      });
      const extra = kind === 'marks' ? { rules: (await tx.markRule.findMany({ where: { markId: id } })).map((x) => ({ fromItemId: x.fromItemId, toItemId: x.toItemId })) } : {};
      return dto(kind, after, true, extra);
    });
  }

  private async saveRules(tx: Tx, markId: string, rules: { fromItemId: string; toItemId: string }[]) {
    if (new Set(rules.map((r) => r.fromItemId)).size !== rules.length) throw new AppError('VALIDATION_ERROR', '同じ品目の切り替え規則が2つあります');
    if (rules.some((r) => r.fromItemId === r.toItemId)) throw new AppError('VALIDATION_ERROR', '切り替え先が同じ品目です');
    await tx.markRule.deleteMany({ where: { markId } });
    if (rules.length) await tx.markRule.createMany({ data: rules.map((r) => ({ markId, ...r })) });
  }

  private async checkRefs(tx: Tx, kind: MasterKind, d: Record<string, unknown>) {
    const must = async (ok: unknown, what: string) => { if (!ok) throw new AppError('VALIDATION_ERROR', `${what}が見つかりません`); };
    if (d.defaultBillingPartyId) await must(await tx.billingParty.findFirst({ where: { id: String(d.defaultBillingPartyId), active: true } }), '請求先');
    if ((kind === 'sites' || kind === 'vehicles') && d.customerId) await must(await tx.customer.findUnique({ where: { id: String(d.customerId) } }), '客先');
    if (d.defaultVehicleClassId) await must(await tx.vehicleClass.findUnique({ where: { id: String(d.defaultVehicleClassId) } }), '車格');
  }

  /* ---------------------------------------------------------------- CSV の一括登録（FR-MST-10） */
  async importCsv(actor: Actor, body: Record<string, unknown>, file: Express.Multer.File | undefined) {
    const { kind, dryRun } = parse(z.object({ kind: z.enum(['customers', 'sites', 'billingParties', 'vehicles']), dryRun: zBoolQ.optional() }), body);
    if (!file?.buffer?.length) throw new AppError('VALIDATION_ERROR', 'CSV ファイルを選んでください');
    if (file.size > 5 * 1024 * 1024) throw new AppError('VALIDATION_ERROR', 'CSV は 5MB までです');
    const recs = parseCsv(decodeCsv(file.buffer));
    if (recs.length < 2) throw new AppError('VALIDATION_ERROR', 'CSV に見出しの行とデータの行が必要です');
    const head = recs[0].map((h) => headerKey(kind, h));
    const result = { created: 0, updated: 0, errors: [] as { line: number; message: string }[] };
    const ROLLBACK = new Error('dry-run');
    try {
      await this.prisma.tx(async (tx) => {
        for (let i = 1; i < recs.length; i++) {
          if (recs[i].every((c) => !c.trim())) continue;
          const row = Object.fromEntries(head.map((h, j) => [h, (recs[i][j] ?? '').trim()]));
          try {
            await tx.$executeRawUnsafe('SAVEPOINT imp');
            const r = await this.importRow(tx, actor, kind, row);
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT imp');
            result[r] += 1;
          } catch (e) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT imp');
            result.errors.push({ line: i + 1, message: e instanceof AppError ? e.message : e instanceof z.ZodError ? e.issues.map((x) => `${x.path.join('.')}：${x.message}`).join('、') : String((e as Error).message).slice(0, 200) });
          }
        }
        if (!dryRun) await this.audit.write(tx, actor, { action: 'MASTER_IMPORT', targetType: MODEL[kind], summary: `${KIND_JA[kind]}を CSV で登録（追加 ${result.created}・変更 ${result.updated}・エラー ${result.errors.length}）` });
        if (dryRun) throw ROLLBACK;
      }, { timeout: 120000 });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return result;
  }

  private async importRow(tx: Tx, actor: Actor, kind: string, r: Record<string, string>): Promise<'created' | 'updated'> {
    const bpByName = async (name: string) => {
      if (!name) return undefined;
      const bp = await tx.billingParty.findFirst({ where: { name, active: true } });
      if (!bp) throw new AppError('VALIDATION_ERROR', `請求先「${name}」がありません（先に請求先を登録してください）`);
      return bp.id;
    };
    const custByName = async (name: string) => {
      const c = await tx.customer.findFirst({ where: { name, active: true } });
      if (!c) throw new AppError('VALIDATION_ERROR', `客先「${name}」がありません`);
      return c.id;
    };
    const int = (s: string | undefined, d?: number) => (s === undefined || s === '' ? d : Number.isInteger(Number(s)) ? Number(s) : (() => { throw new AppError('VALIDATION_ERROR', `数字ではありません：${s}`); })());
    const list = (s: string | undefined) => (s ? s.split(/[;；\s]+/).filter(Boolean) : []);
    if (kind === 'billingParties') {
      const d = parse(INPUT.billingParties, {
        name: r.name, kana: r.kana || r.name, honorific: r.honorific || undefined, postalCode: r.postalCode || null, address: r.address || null,
        mailTo: list(r.mailTo), mailCc: list(r.mailCc), closingDay: int(r.closingDay), paymentMonthOffset: int(r.paymentMonthOffset), paymentDay: int(r.paymentDay), note: r.note || null,
        paymentMethod: !r.paymentMethod ? undefined : /^(現金|CASH)$/i.test(r.paymentMethod) ? 'CASH' : /^(請求書|掛け?|INVOICE)$/i.test(r.paymentMethod) ? 'INVOICE' : (() => { throw new AppError('VALIDATION_ERROR', `支払い方法は「請求書」か「現金」：${r.paymentMethod}`); })(),
      });
      const ex = await tx.billingParty.findFirst({ where: { name: d.name, active: true } });
      if (ex) { await tx.billingParty.update({ where: { id: ex.id }, data: d }); return 'updated'; }
      await tx.billingParty.create({ data: d }); return 'created';
    }
    if (kind === 'customers') {
      const d = parse(INPUT.customers, { name: r.name, kana: r.kana || r.name, sortOrder: int(r.sortOrder), note: r.note || null });
      const bpId = (await bpByName(r.billingPartyName)) ?? (await this.billingPartyForCustomer(tx, actor, d.name, d.kana)).id;
      const ex = await tx.customer.findFirst({ where: { name: d.name, active: true } });
      if (ex) { await tx.customer.update({ where: { id: ex.id }, data: { ...d, defaultBillingPartyId: bpId } }); return 'updated'; }
      await tx.customer.create({ data: { ...d, defaultBillingPartyId: bpId } }); return 'created';
    }
    if (kind === 'sites') {
      const customerId = await custByName(r.customerName);
      const d = parse(INPUT.sites, { customerId, name: r.name, kana: r.kana || r.name, defaultBillingPartyId: (await bpByName(r.billingPartyName)) ?? null });
      const ex = await tx.site.findFirst({ where: { customerId, name: d.name, active: true } });
      if (ex) { await tx.site.update({ where: { id: ex.id }, data: d }); return 'updated'; }
      await tx.site.create({ data: d }); return 'created';
    }
    const customerId = await custByName(r.customerName);
    const vc = r.vehicleClassName ? await tx.vehicleClass.findFirst({ where: { name: r.vehicleClassName } }) : null;
    if (r.vehicleClassName && !vc) throw new AppError('VALIDATION_ERROR', `車格「${r.vehicleClassName}」がありません`);
    const d = parse(INPUT.vehicles, { customerId, vehicleNo: r.vehicleNo, defaultVehicleClassId: vc?.id ?? null });
    const ex = await tx.vehicle.findUnique({ where: { customerId_vehicleNo: { customerId, vehicleNo: d.vehicleNo } } });
    if (ex) { await tx.vehicle.update({ where: { id: ex.id }, data: { ...d, active: true } }); return 'updated'; }
    await tx.vehicle.create({ data: d }); return 'created';
  }

  /* ---------------------------------------------------------------- 単価表（FR-MST-06・07、11 3.2・3.3） */
  async priceTables() {
    const tables = await this.prisma.priceTable.findMany({ orderBy: { effectiveFrom: 'desc' } });
    const [entries, items, vcs, locked] = await Promise.all([
      this.prisma.priceTableEntry.findMany(), this.prisma.item.findMany(), this.prisma.vehicleClass.findMany(), this.lockedTableIds(),
    ]);
    const im = new Map(items.map((i) => [i.id, i])), vm = new Map(vcs.map((v) => [v.id, v]));
    return tables.map((t) => ({
      id: t.id, effectiveFrom: ymd(t.effectiveFrom), note: t.note, locked: locked.has(t.id),
      entries: entries.filter((e) => e.priceTableId === t.id)
        .sort((a, b) => (im.get(a.itemId)?.sortOrder ?? 0) - (im.get(b.itemId)?.sortOrder ?? 0) || (vm.get(a.vehicleClassId)?.sortOrder ?? 0) - (vm.get(b.vehicleClassId)?.sortOrder ?? 0))
        .map((e) => {
          const it = im.get(e.itemId), vc = vm.get(e.vehicleClassId);
          const ref = it && vc ? referencePrice(it.pricePerM3Ref, Number(vc.capacityM3), vc.smallVehicle, it.smallVehicleFeeRef) : null;
          return { itemId: e.itemId, vehicleClassId: e.vehicleClassId, unitPrice: e.unitPrice, referencePrice: ref, differsFromReference: ref !== null && ref !== e.unitPrice };
        }),
    }));
  }
  /** 適用開始日が過ぎ、取消でない請求書に使われた単価表 */
  private async lockedTableIds(tx: Tx | PrismaService = this.prisma) {
    const r = await tx.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM price_tables p WHERE p.effective_from <= ${todayJst()}::date AND EXISTS (
        SELECT 1 FROM invoice_trips it JOIN invoices i ON i.id = it.invoice_id AND i.status <> 'VOIDED' JOIN trips t ON t.id = it.trip_id
        WHERE t.trip_date >= p.effective_from
          AND t.trip_date < COALESCE((SELECT min(p2.effective_from) FROM price_tables p2 WHERE p2.effective_from > p.effective_from), 'infinity'::date))`;
    return new Set(r.map((x) => x.id));
  }
  async createPriceTable(actor: Actor, body: unknown) {
    const b = parse(z.object({ effectiveFrom: zDate, copyFrom: zUuid.optional(), note: z.string().max(200).optional() }).strict(), body);
    const id = await this.prisma.tx(async (tx) => {
      if (await tx.priceTable.findUnique({ where: { effectiveFrom: toDate(b.effectiveFrom) } })) throw new AppError('VALIDATION_ERROR', 'その適用開始日の単価表はすでにあります');
      const src = b.copyFrom ? await tx.priceTable.findUnique({ where: { id: b.copyFrom } }) : await tx.priceTable.findFirst({ where: { effectiveFrom: { lt: toDate(b.effectiveFrom) } }, orderBy: { effectiveFrom: 'desc' } });
      if (b.copyFrom && !src) throw notFound('写す元の単価表');
      const t = await tx.priceTable.create({ data: { effectiveFrom: toDate(b.effectiveFrom), note: b.note ?? null, createdBy: actor.id } });
      if (src) await tx.$executeRaw`INSERT INTO price_table_entries (price_table_id, item_id, vehicle_class_id, unit_price) SELECT ${t.id}::uuid, item_id, vehicle_class_id, unit_price FROM price_table_entries WHERE price_table_id = ${src.id}::uuid`;
      await this.audit.write(tx, actor, { action: 'PRICE_TABLE_CREATE', targetType: 'price_table', targetId: t.id, summary: `単価表（${b.effectiveFrom} から）を作成${src ? `（${ymd(src.effectiveFrom)} の表を写した）` : ''}` });
      return t.id;
    });
    return (await this.priceTables()).find((t) => t.id === id);
  }
  async putPriceEntries(actor: Actor, id: string, body: unknown) {
    const entries = parse(z.array(z.object({ itemId: zUuid, vehicleClassId: zUuid, unitPrice: z.number().int().min(0).max(10_000_000) }).passthrough()).max(2000), body);
    await this.prisma.tx(async (tx) => {
      const t = await tx.priceTable.findUnique({ where: { id } });
      if (!t) throw notFound('単価表');
      if ((await this.lockedTableIds(tx)).has(id)) throw new AppError('PRICE_TABLE_LOCKED', '請求書に使われた単価表は変更できません。新しい適用開始日の単価表を作ってください');
      const before = await tx.priceTableEntry.findMany({ where: { priceTableId: id } });
      const changes: { itemId: string; vehicleClassId: string; from: number | null; to: number }[] = [];
      for (const e of entries) {
        const old = before.find((x) => x.itemId === e.itemId && x.vehicleClassId === e.vehicleClassId);
        if (old?.unitPrice === e.unitPrice) continue;
        changes.push({ itemId: e.itemId, vehicleClassId: e.vehicleClassId, from: old?.unitPrice ?? null, to: e.unitPrice });
        await tx.priceTableEntry.upsert({
          where: { priceTableId_itemId_vehicleClassId: { priceTableId: id, itemId: e.itemId, vehicleClassId: e.vehicleClassId } },
          create: { priceTableId: id, itemId: e.itemId, vehicleClassId: e.vehicleClassId, unitPrice: e.unitPrice }, update: { unitPrice: e.unitPrice },
        });
      }
      if (changes.length) {
        // 単価が変わると、作成済・確認済の請求書の金額が変わりうる
        await tx.$executeRaw`UPDATE invoices SET status = 'NEEDS_RECHECK', confirmed_at = NULL, confirmed_by = NULL
          WHERE status IN ('DRAFT','CONFIRMED') AND period_to >= ${t.effectiveFrom}`;
        await this.audit.write(tx, actor, { action: 'PRICE_TABLE_UPDATE', targetType: 'price_table', targetId: id, summary: `単価表（${ymd(t.effectiveFrom)} から）の金額を ${changes.length} 件変更`, after: changes });
      }
    });
    return (await this.priceTables()).find((t) => t.id === id);
  }
}
const pickKeys = (o: Record<string, unknown>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, typeof o[k] === 'bigint' ? num(o[k] as bigint) : o[k]]));

/* ---------------------------------------------------------------- CSV */
/** CSV の見出し（docs/reference/templates のひな形）→ 項目名。英語の項目名もそのまま使える */
const HEADERS: Record<string, Record<string, string>> = {
  customers: { 会社名: 'name', 客先名: 'name', 名前: 'name', 読みがな: 'kana', 既定の請求先: 'billingPartyName', 請求先: 'billingPartyName', 表示順: 'sortOrder', 備考: 'note' },
  sites: { 会社名: 'customerName', 客先: 'customerName', 客先名: 'customerName', 現場名: 'name', 現場: 'name', 読みがな: 'kana', 既定の請求先: 'billingPartyName', 請求先: 'billingPartyName' },
  billingParties: { 名称: 'name', 名前: 'name', 読みがな: 'kana', 敬称: 'honorific', 郵便番号: 'postalCode', 住所: 'address', 送付先メール: 'mailTo', 支払い方法: 'paymentMethod', 締め日: 'closingDay', 支払月: 'paymentMonthOffset', 支払日: 'paymentDay', 備考: 'note' },
  vehicles: { 会社名: 'customerName', 客先: 'customerName', 客先名: 'customerName', 車番: 'vehicleNo', よく使う車格: 'vehicleClassName', 車格: 'vehicleClassName' },
};
export function headerKey(kind: string, h: string) {
  const t = h.replace(/^\uFEFF/, '').trim();
  if (kind === 'billingParties' && /^送付先メール/.test(t) && /CC/i.test(t)) return 'mailCc';
  const base = t.replace(/[（(].*$/, '').trim();
  return HEADERS[kind]?.[base] ?? t;
}
/** UTF-8（BOM 付き・なし）か Shift_JIS（Excel の既定の保存） */
export function decodeCsv(buf: Buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^﻿/, '');
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('shift_jis').decode(buf);
}
export function parseCsv(s: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

@Controller()
export class MastersController {
  constructor(private readonly m: MastersService) {}
  @Get('masters/:kind') @Roles('RECEPTION', 'OFFICE', 'ADMIN')
  list(@CurrentActor() a: Actor, @Param('kind') k: string, @Query() q: Record<string, unknown>) { return this.m.list(a, k, q); }
  @Post('masters/import') @Roles('OFFICE', 'ADMIN') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  import(@CurrentActor() a: Actor, @Body() b: Record<string, unknown>, @UploadedFile() f?: Express.Multer.File) { return this.m.importCsv(a, b, f); }
  @Post('masters/:kind') @Roles('OFFICE', 'ADMIN')
  create(@CurrentActor() a: Actor, @Param('kind') k: string, @Body() b: unknown) { return this.m.create(a, k, b); }
  @Patch('masters/:kind/:id') @Roles('OFFICE', 'ADMIN')
  update(@CurrentActor() a: Actor, @Param('kind') k: string, @Param('id') id: string, @Body() b: unknown) { return this.m.update(a, k, id, b); }
  @Get('price-tables') @Roles('OFFICE', 'ADMIN')
  priceTables() { return this.m.priceTables(); }
  @Post('price-tables') @Roles('OFFICE', 'ADMIN')
  createPriceTable(@CurrentActor() a: Actor, @Body() b: unknown) { return this.m.createPriceTable(a, b); }
  @Put('price-tables/:id/entries') @Roles('OFFICE', 'ADMIN')
  putEntries(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.m.putPriceEntries(a, id, b); }
}

@Module({ providers: [MastersService], controllers: [MastersController], exports: [MastersService] })
export class MastersModule {}

export type { ZodTypeAny };
