/* 権限（区分×API の全組合せ、13 4章）・認証（NFR-12・13）・CSRF（08 2章）・DB の決まり（07 12章） */
import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FakeMail, MAIL } from '../src/adapters/mail';
import { Api, PASSWORD, resetDb, sql, startApp, uuid } from './helpers';

const spec = parse(readFileSync(join(__dirname, '../../../docs/spec/openapi.yaml'), 'utf8'));
const ops: { method: string; path: string; roles: string[] }[] = [];
for (const [p, o] of Object.entries<Record<string, { 'x-roles': string[] }>>(spec.paths)) for (const [m, d] of Object.entries(o)) ops.push({ method: m, path: p, roles: d['x-roles'] });
const fill = (p: string) => p.replace('{date}', '2026-02-05').replace('{kind}', 'customers').replace(/\{id\}/g, '00000000-0000-4000-8000-000000000000');

let app: INestApplication;
const as: Record<string, Api> = {};
beforeAll(async () => {
  await resetDb();
  app = await startApp();
  for (const [r, l] of [['RECEPTION', 'reception'], ['SIGN_TERMINAL', 'tablet1'], ['OFFICE', 'office'], ['ADMIN', 'admin']]) as[r] = await Api.login(app, l);
});
afterAll(async () => { await app?.close(); });

describe('権限（openapi.yaml の x-roles）', () => {
  it('openapi.yaml の全操作が実装されている', async () => {
    expect(ops.length).toBe(85); // 84 ＋ 集計の元の便（GET /aggregates/trips、FR-AGG-04）
    for (const o of ops) {
      const r = await (as.ADMIN.agent as unknown as Record<string, (u: string) => request.Test>)[o.method](`/api/v1${fill(o.path)}`).set('X-CSRF-Token', as.ADMIN.csrf).send({});
      // 経路がなければ既定の「見つかりません」になる（業務の 404 は「請求書が見つかりません」など）
      expect(r.status === 404 && r.body?.message === '見つかりません', `${o.method} ${o.path}`).toBe(false);
    }
    as.ADMIN = await Api.login(app, 'admin'); // 上でログアウト・パスワード変更も呼んだため
  });
  for (const role of ['RECEPTION', 'SIGN_TERMINAL', 'OFFICE', 'ADMIN']) {
    it(`${role} は許されない API を呼べない（403）`, async () => {
      const api = as[role];
      const denied = ops.filter((o) => !o.roles.some((r) => r === role || ['ANY', 'EXTERNAL', 'SCHEDULER'].includes(r)));
      if (role === 'ADMIN') expect(denied).toHaveLength(denied.filter((o) => o.roles.includes('SIGN_TERMINAL')).length);
      for (const o of denied) {
        const r = await (api.agent as unknown as Record<string, (u: string) => request.Test>)[o.method](`/api/v1${fill(o.path)}`).set('X-CSRF-Token', api.csrf).send({});
        expect(r.status, `${role} ${o.method} ${o.path}`).toBe(403);
      }
    });
  }
  it('ログインしていなければ 401', async () => {
    for (const o of ops.filter((x) => !x.roles.some((r) => ['ANY', 'EXTERNAL', 'SCHEDULER'].includes(r)))) {
      const r = await (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[o.method](`/api/v1${fill(o.path)}`).send({});
      expect(r.status, `${o.method} ${o.path}`).toBe(401);
    }
  });
  it('更新系は X-CSRF-Token がなければ 403 CSRF_INVALID', async () => {
    const r = await as.OFFICE.agent.post('/api/v1/masters/customers').send({ name: 'x', kana: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CSRF_INVALID');
  });
  it('応答はキャッシュさせない・エラーの形が決まっている', async () => {
    const r = await as.OFFICE.get('/invoices/not-a-uuid');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(r.body.requestId).toBeTruthy();
  });
});

describe('認証（NFR-12・13）', () => {
  it('5回続けて間違えると15分ロック（423）、管理者の初期化で解除', async () => {
    for (let i = 0; i < 5; i++) expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ loginId: 'office', password: 'wrong-password-x' })).status).toBe(401);
    const r = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ loginId: 'office', password: PASSWORD });
    expect(r.status).toBe(423);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE login_id = 'office'`);
    const { temporaryPassword } = await as.ADMIN.ok(as.ADMIN.post(`/users/${u.id}/reset-password`));
    const a = await Api.login(app, 'office', temporaryPassword);
    expect((await a.get('/dashboard')).body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await a.post('/auth/password', { current: temporaryPassword, next: 'short' })).status).toBe(400);
    expect((await a.post('/auth/password', { current: temporaryPassword, next: 'a-much-better-passphrase' })).status).toBe(204);
    expect((await a.get('/dashboard')).status).toBe(200);
    as.OFFICE = a;
  });
  it('管理者の2段階の確認（メールのコード）', async () => {
    const a = await Api.login(app, 'admin2');
    expect(a.me.mfaRequired).toBe(true);
    expect((await a.get('/users')).body.code).toBe('MFA_REQUIRED');
    expect((await a.post('/auth/mfa', { code: '000000' })).status).toBe(401);
    const mail = app.get<FakeMail>(MAIL);
    const code = /(\d{6})/.exec(mail.outbox.filter((m) => m.to.includes('admin2@fujimoto.example')).at(-1)!.text)![1];
    expect((await a.post('/auth/mfa', { code })).status).toBe(200);
    expect((await a.get('/users')).status).toBe(200);
  });
  it('ログアウトでセッションが無効になる', async () => {
    const a = await Api.login(app, 'reception');
    expect((await a.post('/auth/logout')).status).toBe(204);
    expect((await a.get('/auth/me')).status).toBe(401);
  });
  it('利用者の追加は仮のパスワードを返し、次回ログインで変更させる', async () => {
    const r = await as.ADMIN.ok(as.ADMIN.post('/users', { loginId: 'uketsuke2', name: '受付 次郎', role: 'RECEPTION' }), 201);
    expect(r.temporaryPassword).toHaveLength(16);
    expect(r.user.mustChangePassword).toBe(true);
    const list = await as.ADMIN.ok(as.ADMIN.get('/users'));
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|password_hash/);
  });
});

describe('DB の決まり（07 12章）', () => {
  it('同じクリックの ID で便を2回保存できない・別の客先の現場は付けられない', async () => {
    const r = await as.OFFICE.post('/masters/customers', { name: '甲社', kana: 'こうしゃ' });
    const c1 = r.body.id;
    const c2 = (await as.OFFICE.ok(as.OFFICE.post('/masters/customers', { name: '乙社', kana: 'おつしゃ' }))).id;
    const s2 = (await as.OFFICE.ok(as.OFFICE.post('/masters/sites', { customerId: c2, name: '乙現場', kana: 'おつげんば' }))).id;
    const vc = (await as.OFFICE.ok(as.OFFICE.post('/masters/vehicleClasses', { name: '10t', capacityM3: 5.5, sortOrder: 1 }))).id;
    const it_ = (await as.OFFICE.ok(as.OFFICE.post('/masters/items', { reportLabel: '残土', priceItemName: '建設発生土1〜2種', direction: 'RECEIVE', sortOrder: 1 }))).id;
    const bad = await as.RECEPTION.post('/report-rows', { date: '2026-03-02', customerId: c1, siteId: s2, vehicleNo: '1', itemId: it_, vehicleClassId: vc });
    expect(bad.status).toBe(400);
    const row = await as.RECEPTION.ok(as.RECEPTION.post('/report-rows', { date: '2026-03-02', customerId: c1, vehicleNo: '1', itemId: it_, vehicleClassId: vc }), 201);
    expect((await as.RECEPTION.post('/report-rows', { date: '2026-03-02', customerId: c1, vehicleNo: '1', itemId: it_, vehicleClassId: vc })).status).toBe(409);
    const op = uuid();
    await as.RECEPTION.ok(as.RECEPTION.post('/trips', { date: '2026-03-02', rowIds: [row.id], time: '09:00', clientOpId: op }), 201);
    await expect(sql(`INSERT INTO trips (daily_report_id, trip_date, report_row_id, trip_time, effective_item_id, client_op_id, created_by)
      SELECT daily_report_id, trip_date, report_row_id, '10:00', effective_item_id, client_op_id, created_by FROM trips WHERE client_op_id = $1`, [op])).rejects.toThrow(/duplicate key/);
    // 車列（FR-RCV-12）：2行を同じ時刻で記入し、印を車列の全部に付ける
    const row2 = await as.RECEPTION.ok(as.RECEPTION.post('/report-rows', { date: '2026-03-02', customerId: c1, vehicleNo: '2', itemId: it_, vehicleClassId: vc }), 201);
    const cv = await as.RECEPTION.ok(as.RECEPTION.post('/trips', { date: '2026-03-02', rowIds: [row.id, row2.id], time: '10:15', clientOpId: uuid() }), 201);
    expect(cv.trips).toHaveLength(2);
    expect(cv.trips[0].convoyId).toBe(cv.trips[1].convoyId);
    const mk = await as.OFFICE.ok(as.OFFICE.post('/masters/marks', { symbol: '草', displayName: '草根', color: '#2c6e3f', sortOrder: 1 }));
    const up = await as.RECEPTION.ok(as.RECEPTION.patch(`/trips/${cv.trips[0].id}`, { version: cv.trips[0].version, markId: mk.id }));
    expect(up).toHaveLength(2);
    expect(up.every((t: { markId: string }) => t.markId === mk.id)).toBe(true);
    // 前日の引継ぎ（FR-RCV-06）
    const co = await as.RECEPTION.ok(as.RECEPTION.get('/daily-reports/2026-03-03/carry-over'));
    expect(co.fromDate).toBe('2026-03-02');
    const made = await as.RECEPTION.ok(as.RECEPTION.post('/daily-reports/2026-03-03/carry-over', { rowIds: co.rows.map((r: { id: string }) => r.id) }), 201);
    expect(made).toHaveLength(2);
    // CSV の一括登録（dryRun では保存しない）
    const csv = Buffer.from('﻿名前,読みがな,締め日\n丙商事,へいしょうじ,20\n,,\n丁商事,,abc\n');
    const dry = await as.OFFICE.agent.post('/api/v1/masters/import').set('X-CSRF-Token', as.OFFICE.csrf).field('kind', 'billingParties').field('dryRun', 'true').attach('file', csv, 'bp.csv');
    expect(dry.body).toMatchObject({ created: 1, errors: [{ line: 4 }] });
    expect((await sql(`SELECT 1 FROM billing_parties WHERE name = '丙商事'`)).length).toBe(0);
    // docs/reference/templates のひな形をそのまま取り込める
    const tpl = (n: string) => readFileSync(join(__dirname, '../../../docs/reference/templates', n));
    const imp = (kind: string, n: string) => as.OFFICE.agent.post('/api/v1/masters/import').set('X-CSRF-Token', as.OFFICE.csrf).field('kind', kind).attach('file', tpl(n), 'x.csv');
    { const r = await imp('billingParties', '請求先.csv'); expect(r.body.errors, JSON.stringify(r.body)).toEqual([]); }
    { const r = await imp('customers', '客先.csv'); expect(r.body.errors, JSON.stringify(r.body)).toEqual([]); }
    { const r = await imp('sites', '現場.csv'); expect(r.body.created).toBe(1); expect(r.body.errors[0].message).toContain('かや工業'); } // ひな形の記入例に客先がない行がある
    const bp = await sql<{ closing_day: number; mail_to: string[] }>(`SELECT closing_day, mail_to FROM billing_parties WHERE name = '山陽建設'`);
    expect(bp[0]).toMatchObject({ closing_day: 20, mail_to: ['keiri@example.jp'] });
  });
});
