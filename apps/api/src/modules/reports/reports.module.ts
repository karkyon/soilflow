/* 受入日報・行・便（FR-RCV、SCR-10〜13）。便の記入・車列・印・取消・前日の引継ぎ・変更分の取得 */
import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { hourSlot, tripCounts } from '@soilflow/billing';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Actor, CurrentActor, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { hhmm, jst, now, todayJst, toDate, toTime } from '../../common/dates';
import { assertUnlocked, effectiveItemFor, LockKind, lockStates, markInvoicesRecheck, recomputeEffectiveItems } from '../../common/domain';
import { dbErrorOf } from '../../common/error.filter';
import { AppError, conflict, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse, zDate, zTime, zUuid } from '../../common/validation';
import { PdfService } from '../pdf/pdf.module';
import { SettingsService } from '../settings/settings.module';

export interface RowDto {
  id: string; customerId: string; customerName: string; siteId: string | null; siteName: string | null; vehicleId: string; vehicleNo: string;
  itemId: string; itemLabel: string; vehicleClassId: string; vehicleClassName: string; sortOrder: number; deleted: boolean; version: number;
}
export interface TripDto {
  id: string; rowId: string; time: string; hourSlot: number; markId: string | null; effectiveItemId: string; convoyId: string | null;
  slipId: string | null; locked: LockKind; status: 'ACTIVE' | 'CANCELLED'; version: number;
}
interface RowRaw { id: string; customer_id: string; customer_name: string; site_id: string | null; site_name: string | null; vehicle_id: string; vehicle_no: string; item_id: string; item_label: string; vehicle_class_id: string; vc_name: string; sort_order: number; deleted_at: Date | null; version: number; customer_sort: number; customer_kana: string }
interface TripRaw { id: string; report_row_id: string; trip_time: Date; mark_id: string | null; effective_item_id: string; convoy_id: string | null; slip_id: string | null; ss: string | null; is: string | null; status: 'ACTIVE' | 'CANCELLED'; version: number }

/** カーソル＝DB の時刻（画面は中身を解釈しない）。取りこぼさないよう5秒重ねて返す */
const OVERLAP_MS = 5000;
export const encodeCursor = (t: string) => Buffer.from(JSON.stringify({ t })).toString('base64url');
export function decodeCursor(c: string): Date {
  try { const t = new Date(JSON.parse(Buffer.from(c, 'base64url').toString()).t); if (!Number.isNaN(t.getTime())) return new Date(t.getTime() - OVERLAP_MS); } catch { /* 下へ */ }
  throw new AppError('VALIDATION_ERROR', 'cursor が正しくありません');
}
export const dbNow = async (db: Tx | PrismaService) => (await db.$queryRaw<{ t: string }[]>`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)[0].t;

/** 車列の2台目以降の操作 ID（同じクリックの再送で同じ値になる） */
function derivedOpId(base: string, i: number) {
  if (i === 0) return base;
  const h = createHash('sha256').update(`${base}:${i}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const RowInput = z.object({
  date: zDate, customerId: zUuid, siteId: zUuid.nullable().optional(), vehicleId: zUuid.optional(), vehicleNo: z.string().trim().min(1).max(20).optional(),
  itemId: zUuid, vehicleClassId: zUuid, afterRowId: zUuid.optional(),
});

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly pdf: PdfService) {}

  /* ---------------------------------------------------------------- 読み出し */
  async ensureReport(db: Tx | PrismaService, date: string) {
    const r = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO daily_reports (report_date) VALUES (${date}::date) ON CONFLICT (report_date) DO UPDATE SET report_date = EXCLUDED.report_date RETURNING id`;
    return r[0].id;
  }
  async rows(db: Tx | PrismaService, where: { reportId?: string; ids?: string[]; since?: Date }): Promise<RowDto[]> {
    const r = await db.$queryRaw<RowRaw[]>`
      SELECT r.id, r.customer_id, c.name AS customer_name, r.site_id, s.name AS site_name, r.vehicle_id, v.vehicle_no, r.item_id, i.report_label AS item_label,
             r.vehicle_class_id, vc.name AS vc_name, r.sort_order, r.deleted_at, r.version, c.sort_order AS customer_sort, c.kana AS customer_kana
      FROM report_rows r JOIN customers c ON c.id = r.customer_id LEFT JOIN sites s ON s.id = r.site_id JOIN vehicles v ON v.id = r.vehicle_id
      JOIN items i ON i.id = r.item_id JOIN vehicle_classes vc ON vc.id = r.vehicle_class_id
      WHERE (${where.reportId ?? null}::uuid IS NULL OR r.daily_report_id = ${where.reportId ?? null}::uuid)
        AND (${where.ids ?? null}::uuid[] IS NULL OR r.id = ANY(${where.ids ?? null}::uuid[]))
        AND (${where.since ?? null}::timestamptz IS NULL AND r.deleted_at IS NULL OR r.updated_at > ${where.since ?? null}::timestamptz)
      ORDER BY c.sort_order, c.kana, c.id, r.sort_order, r.created_at`;
    return r.map((x) => ({
      id: x.id, customerId: x.customer_id, customerName: x.customer_name, siteId: x.site_id, siteName: x.site_name, vehicleId: x.vehicle_id, vehicleNo: x.vehicle_no,
      itemId: x.item_id, itemLabel: x.item_label, vehicleClassId: x.vehicle_class_id, vehicleClassName: x.vc_name, sortOrder: x.sort_order, deleted: !!x.deleted_at, version: x.version,
    }));
  }
  async trips(db: Tx | PrismaService, where: { reportId?: string; ids?: string[]; since?: Date; convoyId?: string }): Promise<TripDto[]> {
    const st = await this.settings.get(db);
    const r = await db.$queryRaw<TripRaw[]>`
      SELECT t.id, t.report_row_id, t.trip_time, t.mark_id, t.effective_item_id, t.convoy_id, t.slip_id, s.status AS ss, i.status AS "is", t.status, t.version
      FROM trips t LEFT JOIN slips s ON s.id = t.slip_id LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE (${where.reportId ?? null}::uuid IS NULL OR t.daily_report_id = ${where.reportId ?? null}::uuid)
        AND (${where.ids ?? null}::uuid[] IS NULL OR t.id = ANY(${where.ids ?? null}::uuid[]))
        AND (${where.convoyId ?? null}::uuid IS NULL OR t.convoy_id = ${where.convoyId ?? null}::uuid)
        AND (${where.since ?? null}::timestamptz IS NULL OR t.updated_at > ${where.since ?? null}::timestamptz)
      ORDER BY t.trip_time, t.created_at, t.id`;
    return r.map((x) => {
      const time = hhmm(x.trip_time);
      const locked: LockKind = x.is && ['SENDING', 'SENT', 'SEND_ERROR'].includes(x.is) ? 'INVOICE' : x.ss && ['AWAITING_SIGNATURE', 'SIGNED', 'PAPER_PRINTED', 'PAPER_SIGNED'].includes(x.ss) ? 'SLIP' : 'NONE';
      return {
        id: x.id, rowId: x.report_row_id, time, hourSlot: hourSlot(time, st.reportFirstHour, st.reportLastHour), markId: x.mark_id, effectiveItemId: x.effective_item_id,
        convoyId: x.convoy_id, slipId: x.slip_id && x.ss !== 'CANCELLED' ? x.slip_id : null, locked, status: x.status, version: x.version,
      };
    });
  }
  private async counts(db: Tx | PrismaService, reportId: string) {
    const rows = await db.reportRow.findMany({ where: { dailyReportId: reportId, deletedAt: null }, select: { id: true, customerId: true } });
    const trips = await db.trip.findMany({ where: { dailyReportId: reportId, status: 'ACTIVE' }, select: { reportRowId: true, status: true } });
    return tripCounts(rows, trips.map((t) => ({ rowId: t.reportRowId, status: t.status })));
  }

  async dailyReport(date: string) {
    parse(zDate, date);
    const reportId = await this.ensureReport(this.prisma, date);
    const cursor = encodeCursor(await dbNow(this.prisma));
    const st = await this.settings.get();
    const marks = await this.prisma.mark.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
    return {
      id: reportId, date, firstHour: st.reportFirstHour, lastHour: st.reportLastHour,
      rows: await this.rows(this.prisma, { reportId }), trips: await this.trips(this.prisma, { reportId }), counts: await this.counts(this.prisma, reportId),
      marks: marks.map((m) => ({ id: m.id, symbol: m.symbol, displayName: m.displayName, color: m.color })), cursor,
    };
  }

  async changes(date: string, since: string | undefined) {
    parse(zDate, date);
    if (!since) throw new AppError('VALIDATION_ERROR', 'since が必要です');
    const t = decodeCursor(since);
    const rep = await this.prisma.dailyReport.findUnique({ where: { reportDate: toDate(date) } });
    const cursor = encodeCursor(await dbNow(this.prisma));
    if (!rep) return { cursor, rows: [], trips: [], counts: { byRow: {}, byCustomer: {}, total: 0 } };
    return { cursor, rows: await this.rows(this.prisma, { reportId: rep.id, since: t }), trips: await this.trips(this.prisma, { reportId: rep.id, since: t }), counts: await this.counts(this.prisma, rep.id) };
  }

  /* ---------------------------------------------------------------- 行 */
  /** 車番：既存の ID、または新しい車番を登録（FR-RCV-05） */
  private async resolveVehicle(tx: Tx, actor: Actor, customerId: string, vehicleId: string | undefined, vehicleNo: string | undefined, vehicleClassId: string) {
    if (vehicleId && vehicleNo) throw new AppError('VALIDATION_ERROR', 'vehicleId と vehicleNo はどちらか一方を送ってください');
    if (vehicleId) {
      const v = await tx.vehicle.findUnique({ where: { id: vehicleId } });
      if (!v || v.customerId !== customerId) throw new AppError('VALIDATION_ERROR', 'この客先の車番ではありません');
      return v.id;
    }
    if (!vehicleNo) throw new AppError('VALIDATION_ERROR', '車番を選ぶか入力してください');
    const ex = await tx.vehicle.findUnique({ where: { customerId_vehicleNo: { customerId, vehicleNo } } });
    if (ex) { if (!ex.active) await tx.vehicle.update({ where: { id: ex.id }, data: { active: true } }); return ex.id; }
    const v = await tx.vehicle.create({ data: { customerId, vehicleNo, defaultVehicleClassId: vehicleClassId } });
    await this.audit.write(tx, actor, { action: 'MASTER_CREATE', targetType: 'vehicle', targetId: v.id, summary: `車番「${vehicleNo}」を追加（日報から）` });
    return v.id;
  }
  private async checkRowRefs(tx: Tx, d: { customerId: string; siteId?: string | null; itemId: string; vehicleClassId: string }) {
    const c = await tx.customer.findUnique({ where: { id: d.customerId } });
    if (!c?.active) throw new AppError('VALIDATION_ERROR', '客先が見つかりません');
    if (d.siteId) { const s = await tx.site.findUnique({ where: { id: d.siteId } }); if (!s?.active || s.customerId !== d.customerId) throw new AppError('VALIDATION_ERROR', 'この客先の現場ではありません'); }
    const i = await tx.item.findUnique({ where: { id: d.itemId } }); if (!i?.active) throw new AppError('VALIDATION_ERROR', '品目が見つかりません');
    const v = await tx.vehicleClass.findUnique({ where: { id: d.vehicleClassId } }); if (!v?.active) throw new AppError('VALIDATION_ERROR', '車格が見つかりません');
  }

  async createRow(actor: Actor, body: unknown) {
    const b = parse(RowInput.strict(), body);
    try {
      return await this.prisma.tx(async (tx) => {
        await this.checkRowRefs(tx, b);
        const reportId = await this.ensureReport(tx, b.date);
        const vehicleId = await this.resolveVehicle(tx, actor, b.customerId, b.vehicleId, b.vehicleNo, b.vehicleClassId);
        let sortOrder: number;
        if (b.afterRowId) {
          const after = await tx.reportRow.findUnique({ where: { id: b.afterRowId } });
          if (!after || after.dailyReportId !== reportId) throw new AppError('VALIDATION_ERROR', '入れる位置の行が見つかりません');
          await tx.$executeRaw`UPDATE report_rows SET sort_order = sort_order + 1 WHERE daily_report_id = ${reportId}::uuid AND sort_order > ${after.sortOrder}`;
          sortOrder = after.sortOrder + 1;
        } else {
          const m = await tx.reportRow.aggregate({ where: { dailyReportId: reportId }, _max: { sortOrder: true } });
          sortOrder = (m._max.sortOrder ?? 0) + 1;
        }
        const r = await tx.reportRow.create({ data: { dailyReportId: reportId, customerId: b.customerId, siteId: b.siteId ?? null, vehicleId, itemId: b.itemId, vehicleClassId: b.vehicleClassId, sortOrder, createdBy: actor.id } });
        const [dto] = await this.rows(tx, { ids: [r.id] });
        await this.audit.write(tx, actor, { action: 'ROW_CREATE', targetType: 'report_row', targetId: r.id, summary: `${b.date} の日報に行を追加（${dto.customerName}${dto.siteName ? '・' + dto.siteName : ''} ${dto.vehicleNo} ${dto.itemLabel}${dto.vehicleClassName}）`, after: dto });
        return dto;
      });
    } catch (e) {
      if (dbErrorOf(e)?.code === '23505') throw new AppError('CONFLICT', '同じ客先・現場・車番・品目・車格の行がすでにあります');
      throw e;
    }
  }

  async updateRow(actor: Actor, id: string, body: unknown) {
    const b = parse(RowInput.partial().extend({ version: z.number().int() }).strict(), body);
    try {
      return await this.prisma.tx(async (tx) => {
        const row = await tx.reportRow.findUnique({ where: { id } });
        if (!row || row.deletedAt) throw notFound('行');
        const rep = await tx.dailyReport.findUniqueOrThrow({ where: { id: row.dailyReportId } });
        if (b.date && toDate(b.date).getTime() !== rep.reportDate.getTime()) throw new AppError('VALIDATION_ERROR', '行の日付は変えられません');
        const next = {
          customerId: b.customerId ?? row.customerId, siteId: b.siteId !== undefined ? b.siteId : b.customerId && b.customerId !== row.customerId ? null : row.siteId,
          itemId: b.itemId ?? row.itemId, vehicleClassId: b.vehicleClassId ?? row.vehicleClassId,
        };
        await this.checkRowRefs(tx, next);
        const vehicleId = b.vehicleId || b.vehicleNo ? await this.resolveVehicle(tx, actor, next.customerId, b.vehicleId, b.vehicleNo, next.vehicleClassId)
          : next.customerId !== row.customerId ? (() => { throw new AppError('VALIDATION_ERROR', '客先を変えるときは車番も選んでください'); })() : row.vehicleId;
        const tripIds = (await tx.trip.findMany({ where: { reportRowId: id, status: 'ACTIVE' }, select: { id: true } })).map((t) => t.id);
        const billingChange = next.customerId !== row.customerId || next.siteId !== row.siteId || next.vehicleClassId !== row.vehicleClassId || next.itemId !== row.itemId || vehicleId !== row.vehicleId;
        if (billingChange) for (const l of (await lockStates(tx, tripIds)).values()) assertUnlocked(l);
        const before = (await this.rows(tx, { ids: [id] }))[0];
        const r = await tx.reportRow.updateMany({ where: { id, version: b.version }, data: { ...next, vehicleId } });
        if (!r.count) throw conflict();
        await recomputeEffectiveItems(tx, { rowId: id });
        await markInvoicesRecheck(tx, tripIds);
        if (billingChange) await tx.$executeRaw`UPDATE trips SET updated_at = now() WHERE report_row_id = ${id}::uuid`;
        const [dto] = await this.rows(tx, { ids: [id] });
        await this.audit.write(tx, actor, { action: 'ROW_UPDATE', targetType: 'report_row', targetId: id, summary: `日報の行を修正（${dto.customerName} ${dto.vehicleNo} ${dto.itemLabel}${dto.vehicleClassName}）`, before, after: dto });
        return dto;
      });
    } catch (e) {
      if (dbErrorOf(e)?.code === '23505') throw new AppError('CONFLICT', '同じ客先・現場・車番・品目・車格の行がすでにあります');
      throw e;
    }
  }

  async deleteRow(actor: Actor, id: string) {
    parse(zUuid, id);
    await this.prisma.tx(async (tx) => {
      const row = await tx.reportRow.findUnique({ where: { id } });
      if (!row || row.deletedAt) throw notFound('行');
      if (await tx.trip.count({ where: { reportRowId: id, status: 'ACTIVE' } })) throw new AppError('ROW_HAS_TRIPS', '便が記入された行は削除できません。先に便を取り消してください');
      const [dto] = await this.rows(tx, { ids: [id] });
      await tx.reportRow.update({ where: { id }, data: { deletedAt: now() } });
      await this.audit.write(tx, actor, { action: 'ROW_DELETE', targetType: 'report_row', targetId: id, summary: `日報の行を削除（${dto.customerName} ${dto.vehicleNo} ${dto.itemLabel}${dto.vehicleClassName}）`, before: dto });
    });
  }

  /* ---------------------------------------------------------------- 前日の引継ぎ（FR-RCV-06） */
  private async previousReport(date: string) {
    const r = await this.prisma.$queryRaw<{ id: string; report_date: Date }[]>`
      SELECT d.id, d.report_date FROM daily_reports d WHERE d.report_date < ${date}::date
        AND EXISTS (SELECT 1 FROM trips t WHERE t.daily_report_id = d.id AND t.status = 'ACTIVE')
      ORDER BY d.report_date DESC LIMIT 1`;
    return r[0] ?? null;
  }
  async carryOverCandidates(date: string) {
    parse(zDate, date);
    const prev = await this.previousReport(date);
    if (!prev) return { fromDate: null, rows: [] };
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM report_rows r WHERE r.daily_report_id = ${prev.id}::uuid AND r.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM trips t WHERE t.report_row_id = r.id AND t.status = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM report_rows x JOIN daily_reports d ON d.id = x.daily_report_id AND d.report_date = ${date}::date
          WHERE x.deleted_at IS NULL AND x.customer_id = r.customer_id AND x.site_id IS NOT DISTINCT FROM r.site_id AND x.vehicle_id = r.vehicle_id AND x.item_id = r.item_id AND x.vehicle_class_id = r.vehicle_class_id)`;
    return { fromDate: prev.report_date.toISOString().slice(0, 10), rows: ids.length ? await this.rows(this.prisma, { ids: ids.map((x) => x.id) }) : [] };
  }
  async carryOver(actor: Actor, date: string, body: unknown) {
    parse(zDate, date);
    const { rowIds } = parse(z.object({ rowIds: z.array(zUuid).min(1).max(500) }).strict(), body);
    return this.prisma.tx(async (tx) => {
      const reportId = await this.ensureReport(tx, date);
      const src = await tx.$queryRaw<{ id: string; customer_id: string; site_id: string | null; vehicle_id: string; item_id: string; vehicle_class_id: string }[]>`
        SELECT r.id, r.customer_id, r.site_id, r.vehicle_id, r.item_id, r.vehicle_class_id FROM report_rows r JOIN daily_reports d ON d.id = r.daily_report_id
        WHERE r.id = ANY(${rowIds}::uuid[]) AND r.deleted_at IS NULL AND d.report_date < ${date}::date ORDER BY r.sort_order`;
      if (src.length !== new Set(rowIds).size) throw new AppError('VALIDATION_ERROR', '引き継げない行が含まれています');
      const m = await tx.reportRow.aggregate({ where: { dailyReportId: reportId }, _max: { sortOrder: true } });
      let so = m._max.sortOrder ?? 0;
      const created: string[] = [];
      for (const r of src) {
        const ins = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO report_rows (daily_report_id, customer_id, site_id, vehicle_id, item_id, vehicle_class_id, sort_order, carried_from_row_id, created_by)
          VALUES (${reportId}::uuid, ${r.customer_id}::uuid, ${r.site_id}::uuid, ${r.vehicle_id}::uuid, ${r.item_id}::uuid, ${r.vehicle_class_id}::uuid, ${++so}, ${r.id}::uuid, ${actor.id}::uuid)
          ON CONFLICT DO NOTHING RETURNING id`;
        if (ins[0]) created.push(ins[0].id);
      }
      await this.audit.write(tx, actor, { action: 'ROW_CARRY_OVER', targetType: 'daily_report', targetId: reportId, summary: `${date} の日報に前日の行を ${created.length} 行引き継いだ`, after: { rowIds: created, from: rowIds } });
      return created.length ? this.rows(tx, { ids: created }) : [];
    });
  }

  /* ---------------------------------------------------------------- 便 */
  /** 便の時刻（11 2.1、04 3.7）。PC の時刻とのずれが5分以内なら PC の時刻 */
  private tripTime(date: string, time: string | undefined, clientTime: string | undefined): { time: string; skew: boolean } {
    const today = todayJst();
    if (date > today) throw new AppError('FUTURE_TIME', '今日より後の日報には記入できません');
    if (time) {
      if (date === today && time > jst().time) throw new AppError('FUTURE_TIME', '今より後の時間帯には記入できません');
      return { time, skew: false };
    }
    if (date !== today) throw new AppError('VALIDATION_ERROR', '過去の日報に記入するときは時刻を入れてください');
    if (clientTime) {
      const c = new Date(clientTime);
      if (!Number.isNaN(c.getTime()) && Math.abs(c.getTime() - now().getTime()) <= 5 * 60000 && jst(c).date === date) {
        const t = jst(c).time;
        return { time: t > jst().time ? jst().time : t, skew: false };
      }
      return { time: jst().time, skew: true };
    }
    return { time: jst().time, skew: false };
  }

  async createTrips(actor: Actor, body: unknown, res: Response) {
    const b = parse(z.object({ date: zDate, rowIds: z.array(zUuid).min(1).max(30), time: zTime.optional(), clientTime: z.string().datetime({ offset: true }).optional(), clientOpId: zUuid }).strict(), body);
    if (new Set(b.rowIds).size !== b.rowIds.length) throw new AppError('VALIDATION_ERROR', '同じ行が2回指定されています');
    const existing = async () => {
      const t = await this.prisma.trip.findUnique({ where: { clientOpId: b.clientOpId } });
      if (!t) return null;
      return t.convoyId ? this.trips(this.prisma, { convoyId: t.convoyId }) : this.trips(this.prisma, { ids: [t.id] });
    };
    const done = await existing();
    if (done) { res.status(200); return { trips: done, clockSkewWarning: false }; }
    const { time, skew } = this.tripTime(b.date, b.time, b.clientTime);
    try {
      const trips = await this.prisma.tx(async (tx) => {
        const rep = await tx.dailyReport.findUnique({ where: { reportDate: toDate(b.date) } });
        if (!rep) throw new AppError('VALIDATION_ERROR', '日報が見つかりません');
        const rows = await tx.reportRow.findMany({ where: { id: { in: b.rowIds }, dailyReportId: rep.id, deletedAt: null } });
        if (rows.length !== b.rowIds.length) throw new AppError('VALIDATION_ERROR', 'この日の日報の行ではないものが含まれています');
        const convoyId = b.rowIds.length > 1 ? randomUUID() : null;
        const ids: string[] = [];
        for (const [i, rowId] of b.rowIds.entries()) {
          const row = rows.find((r) => r.id === rowId)!;
          const t = await tx.trip.create({
            data: { dailyReportId: rep.id, tripDate: rep.reportDate, reportRowId: rowId, tripTime: toTime(time), effectiveItemId: await effectiveItemFor(tx, row.itemId, null), convoyId, clientOpId: derivedOpId(b.clientOpId, i), createdBy: actor.id },
          });
          ids.push(t.id);
        }
        await markInvoicesRecheck(tx, ids);
        const dto = await this.trips(tx, { ids });
        const names = await this.rows(tx, { ids: b.rowIds });
        await this.audit.write(tx, actor, {
          action: 'TRIP_CREATE', targetType: 'trip', targetId: ids[0],
          summary: `${b.date} ${time} に便を記入（${names.map((r) => `${r.customerName} ${r.vehicleNo}`).join('・')}${convoyId ? `、車列 ${ids.length} 台` : ''}）`,
          after: { time, rowIds: b.rowIds, convoyId, tripIds: ids },
        });
        return dto;
      });
      res.status(201);
      return { trips, clockSkewWarning: skew };
    } catch (e) {
      if (dbErrorOf(e)?.code === '23505') { const t = await existing(); if (t) { res.status(200); return { trips: t, clockSkewWarning: false }; } }
      throw e;
    }
  }

  async updateTrip(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), time: zTime.optional(), markId: zUuid.nullable().optional(), applyToConvoy: z.boolean().default(true) }).strict(), body);
    parse(zUuid, id);
    return this.prisma.tx(async (tx) => {
      const t = await tx.trip.findUnique({ where: { id } });
      if (!t) throw notFound('便');
      if (t.status !== 'ACTIVE') throw new AppError('INVALID_STATE', '取り消した便は変更できません');
      if (t.version !== b.version) throw conflict();
      const date = t.tripDate.toISOString().slice(0, 10);
      if (b.time) this.tripTime(date, b.time, undefined);
      if (b.markId) { const m = await tx.mark.findUnique({ where: { id: b.markId } }); if (!m?.active) throw new AppError('VALIDATION_ERROR', '印が見つかりません'); }
      const targets = b.applyToConvoy && t.convoyId ? await tx.trip.findMany({ where: { convoyId: t.convoyId, status: 'ACTIVE' } }) : [t];
      for (const l of (await lockStates(tx, targets.map((x) => x.id))).values()) assertUnlocked(l);
      const before = await this.trips(tx, { ids: targets.map((x) => x.id) });
      for (const x of targets) {
        const row = await tx.reportRow.findUniqueOrThrow({ where: { id: x.reportRowId } });
        const markId = b.markId !== undefined ? b.markId : x.markId;
        const r = await tx.trip.updateMany({
          where: { id: x.id, version: x.id === id ? b.version : x.version },
          data: { markId, effectiveItemId: await effectiveItemFor(tx, row.itemId, markId), ...(b.time && (x.id === id || b.applyToConvoy) ? { tripTime: toTime(b.time) } : {}) },
        });
        if (!r.count) throw conflict();
      }
      const ids = targets.map((x) => x.id);
      await markInvoicesRecheck(tx, ids);
      const after = await this.trips(tx, { ids });
      const mark = b.markId ? await tx.mark.findUnique({ where: { id: b.markId } }) : null;
      await this.audit.write(tx, actor, {
        action: 'TRIP_UPDATE', targetType: 'trip', targetId: id,
        summary: `便を変更（${date} ${before[0]?.time}${b.time ? ` → ${b.time}` : ''}${b.markId !== undefined ? `、印：${mark ? mark.symbol : 'なし'}` : ''}${ids.length > 1 ? `、車列 ${ids.length} 台` : ''}）`,
        before, after,
      });
      return after;
    });
  }

  async cancelTrip(actor: Actor, id: string, body: unknown) {
    const b = parse(z.object({ version: z.number().int(), reason: z.string().trim().max(200).optional() }).strict(), body);
    parse(zUuid, id);
    return this.prisma.tx(async (tx) => {
      const t = await tx.trip.findUnique({ where: { id } });
      if (!t) throw notFound('便');
      if (t.status !== 'ACTIVE') throw new AppError('INVALID_STATE', 'すでに取り消した便です');
      assertUnlocked((await lockStates(tx, [id])).get(id) ?? 'NONE');
      const r = await tx.trip.updateMany({ where: { id, version: b.version }, data: { status: 'CANCELLED', cancelReason: b.reason ?? null, cancelledAt: now(), cancelledBy: actor.id } });
      if (!r.count) throw conflict();
      await markInvoicesRecheck(tx, [id]);
      const [dto] = await this.trips(tx, { ids: [id] });
      const [row] = await this.rows(tx, { ids: [t.reportRowId] });
      await this.audit.write(tx, actor, { action: 'TRIP_CANCEL', targetType: 'trip', targetId: id, summary: `便を取消（${t.tripDate.toISOString().slice(0, 10)} ${dto.time} ${row?.customerName ?? ''} ${row?.vehicleNo ?? ''}）`, reason: b.reason ?? null, after: dto });
      return dto;
    });
  }

  pdfUrl(actor: Actor, date: string) { parse(zDate, date); return this.pdf.dailyReport(date, actor.name); }
}

const R = ['RECEPTION', 'OFFICE', 'ADMIN'] as const;
@Controller()
export class ReportsController {
  constructor(private readonly s: ReportsService) {}
  @Get('daily-reports/:date') @Roles(...R) get(@Param('date') d: string) { return this.s.dailyReport(d); }
  @Get('daily-reports/:date/changes') @Roles(...R) changes(@Param('date') d: string, @Query('since') since?: string) { return this.s.changes(d, since); }
  @Get('daily-reports/:date/carry-over') @Roles(...R) candidates(@Param('date') d: string) { return this.s.carryOverCandidates(d); }
  @Post('daily-reports/:date/carry-over') @Roles(...R) carry(@CurrentActor() a: Actor, @Param('date') d: string, @Body() b: unknown) { return this.s.carryOver(a, d, b); }
  @Get('daily-reports/:date/pdf') @Roles(...R) pdf(@CurrentActor() a: Actor, @Param('date') d: string) { return this.s.pdfUrl(a, d); }
  @Post('report-rows') @Roles(...R) createRow(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.createRow(a, b); }
  @Patch('report-rows/:id') @Roles(...R) updateRow(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.updateRow(a, id, b); }
  @Delete('report-rows/:id') @Roles(...R) @HttpCode(204) async deleteRow(@CurrentActor() a: Actor, @Param('id') id: string) { await this.s.deleteRow(a, id); }
  @Post('trips') @Roles(...R) createTrips(@CurrentActor() a: Actor, @Body() b: unknown, @Res({ passthrough: true }) res: Response) { return this.s.createTrips(a, b, res); }
  @Patch('trips/:id') @Roles(...R) updateTrip(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.updateTrip(a, id, b); }
  @Post('trips/:id/cancel') @Roles(...R) @HttpCode(200) cancelTrip(@CurrentActor() a: Actor, @Param('id') id: string, @Body() b: unknown) { return this.s.cancelTrip(a, id, b); }
}

@Module({ providers: [ReportsService], controllers: [ReportsController], exports: [ReportsService] })
export class ReportsModule {}
